'use strict';

/**
 * Unit tests for the two other pure main-process modules: the CSV
 * export/import pair and the settings store's merge + coercion rules.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const csv = require('../src/main/csv');
const { SettingsStore, DEFAULTS, mergeShaped } = require('../src/main/settings');
const { applyTemplate } = require('../src/main/discord-rpc');
const { generateLinkCode, topicForCode } = require('../src/main/mqtt-link');

// ---------------------------------------------------------------------------
// CSV round trip
// ---------------------------------------------------------------------------
test('buildCsv emits the documented header and quotes text fields', () => {
  const out = csv.buildCsv([
    { time: '2026-01-01T00:00:00.000Z', elapsed: 0, bpm: 72, rr: 833, zone: 'Warm Up', stress: 12 }
  ]);
  const lines = out.trim().split('\r\n');
  assert.equal(lines[0], csv.CSV_HEADER);
  assert.equal(lines[1], '"2026-01-01T00:00:00.000Z",0,72,833,"Warm Up",12');
});

test('a session survives an export/import round trip', () => {
  const rows = [
    { time: '2026-01-01T00:00:00.000Z', elapsed: 0, bpm: 70, rr: 857, zone: 'Warm Up', stress: 10 },
    { time: '2026-01-01T00:00:05.000Z', elapsed: 5, bpm: 130, rr: 461, zone: 'Aerobic', stress: 70 },
    { time: '2026-01-01T00:01:05.000Z', elapsed: 65, bpm: 100, rr: 600, zone: 'Fat Burn', stress: 40 }
  ];
  const parsed = csv.parseSessionCsv(csv.buildCsv(rows));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.hr, [70, 130, 100]);
  assert.deepEqual(parsed.stress, [10, 70, 40]);
  assert.deepEqual(parsed.labels, ['00:00', '00:05', '01:05']);
  assert.equal(parsed.stats.min, 70);
  assert.equal(parsed.stats.max, 130);
  assert.equal(parsed.stats.avg, 100);
  assert.equal(parsed.stats.stressAvg, 40);
  assert.equal(parsed.stats.duration, '00:01:05');
});

test('the importer matches columns by header name, not position', () => {
  const text = 'Stress Index,Heart Rate (BPM),Elapsed Time (s)\n55,88,0\n60,90,1\n';
  const parsed = csv.parseSessionCsv(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.hr, [88, 90]);
  assert.deepEqual(parsed.stress, [55, 60]);
});

test('the importer honours quoted fields containing commas', () => {
  const text = [
    csv.CSV_HEADER,
    '"Jan 1, 2026, 00:00:00",0,101,594,"Fat Burn",44'
  ].join('\r\n');
  const parsed = csv.parseSessionCsv(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.hr, [101]);
  assert.deepEqual(parsed.stress, [44]);
});

test('splitCsvLine unescapes doubled quotes', () => {
  assert.deepEqual(csv.splitCsvLine('"a,b","say ""hi""",3'), ['a,b', 'say "hi"', '3']);
});

test('the importer degrades gracefully on bad input', () => {
  assert.equal(csv.parseSessionCsv('').ok, false);
  assert.equal(csv.parseSessionCsv('Timestamp,Something\n1,2\n').ok, false);
  assert.equal(csv.parseSessionCsv(csv.CSV_HEADER).ok, false, 'header without rows');
  // Junk rows are skipped rather than aborting the import.
  const mixed = csv.parseSessionCsv(`${csv.CSV_HEADER}\n"x",0,,,,\n"y",1,80,750,"Warm Up",20\n`);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.hr, [80]);
});

test('a file without an elapsed column still plots against a row timeline', () => {
  const parsed = csv.parseSessionCsv('Heart Rate (BPM)\n70\n80\n90\n');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.labels, ['00:00', '00:01', '00:02']);
  assert.deepEqual(parsed.stress, [], 'no stress column means no second series');
});

test('exportSession writes the file when no dialog is available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsenx-csv-'));
  const target = path.join(dir, 'session.csv');
  const rows = [{ time: 'T', elapsed: 0, bpm: 70, rr: 857, zone: 'Warm Up', stress: 10 }];

  const result = await csv.exportSession(rows, {
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) }
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, target);
  assert.match(fs.readFileSync(target, 'utf8'), /Heart Rate \(BPM\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exportSession reports cancellation and empty sessions instead of throwing', async () => {
  const canceled = await csv.exportSession([{ bpm: 70 }], {
    dialog: { showSaveDialog: async () => ({ canceled: true }) }
  });
  assert.deepEqual(canceled, { ok: false, canceled: true });

  const empty = await csv.exportSession([], {});
  assert.equal(empty.ok, false);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
test('the store starts from the documented defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsenx-settings-'));
  const store = new SettingsStore(dir);
  assert.deepEqual(store.get(), DEFAULTS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial patch merges without disturbing sibling keys, and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsenx-settings-'));
  const store = new SettingsStore(dir);

  const merged = store.set({ osc: { port: 9001 } });
  assert.equal(merged.osc.port, 9001);
  assert.equal(merged.osc.host, DEFAULTS.osc.host, 'sibling keys survive a partial patch');
  assert.equal(merged.profile.age, DEFAULTS.profile.age);

  const reloaded = new SettingsStore(dir);
  assert.equal(reloaded.get().osc.port, 9001);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('values are coerced to the type of their default', () => {
  const merged = mergeShaped(DEFAULTS, DEFAULTS, {
    osc: { port: '9002', enabled: 'false', minHr: '40' },
    profile: { age: '31' },
    stressOffset: '-5'
  });
  assert.strictEqual(merged.osc.port, 9002);
  assert.strictEqual(merged.osc.enabled, false);
  assert.strictEqual(merged.osc.minHr, 40);
  assert.strictEqual(merged.profile.age, 31);
  assert.strictEqual(merged.stressOffset, -5);
});

test('unknown keys and unusable values are rejected', () => {
  const merged = mergeShaped(DEFAULTS, DEFAULTS, {
    nonsense: true,
    osc: { port: 'not-a-number', bogus: 1 }
  });
  assert.equal('nonsense' in merged, false);
  assert.equal('bogus' in merged.osc, false);
  assert.equal(merged.osc.port, DEFAULTS.osc.port, 'a broken value keeps the default');
});

test('a corrupt settings file falls back to defaults instead of failing to start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsenx-settings-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json', 'utf8');
  const store = new SettingsStore(dir);
  assert.deepEqual(store.get(), DEFAULTS);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discord templates & link codes
// ---------------------------------------------------------------------------
test('presence templates replace every placeholder occurrence', () => {
  const out = applyTemplate('{bpm} bpm, still {bpm} bpm — {zone}/{stresstext}', {
    bpm: 88, zone: 'Aerobic', stresstext: 'Normal'
  });
  assert.equal(out, '88 bpm, still 88 bpm — Aerobic/Normal');
});

test('link codes are 6 uppercase alphanumerics and drive the MQTT topic', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateLinkCode();
    assert.match(code, /^[A-Z0-9]{6}$/);
  }
  assert.equal(topicForCode('AB12CD'), 'pulsenx/vitals/pc-AB12CD');
});
