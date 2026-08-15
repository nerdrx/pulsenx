'use strict';

/**
 * Unit tests for src/main/state.js — the pure vitals processing core.
 *
 *   node --test test/state.test.js
 *
 * The state object takes an injectable clock, so every time-dependent
 * behaviour (calorie integration, pacer phases, alarm duration filter) is
 * driven deterministically rather than with sleeps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VitalsState,
  zoneFor,
  normalizeHealth,
  rmssd,
  kcalPerMinute,
  stressIndex,
  stressText,
  formatClock,
  ZONE_KEYS
} = require('../src/main/state');

/** A state object wired to a clock the test advances by hand. */
function makeState(overrides = {}) {
  const clock = { t: 1_700_000_000_000 };
  const state = new VitalsState({ now: () => clock.t });
  state.setProfile({ age: 30, gender: 'male', weightKg: 80, maxHr: 200, ...(overrides.profile || {}) });
  if (overrides.alarm) state.setAlarmConfig(overrides.alarm);
  if (overrides.stressOffset !== undefined) state.setStressOffset(overrides.stressOffset);
  // The pacer clock is anchored at construction time.
  state.resetStats(clock.t);
  return { state, clock };
}

// ---------------------------------------------------------------------------
// Training zones
// ---------------------------------------------------------------------------
test('zoneFor uses 60/70/80/90 %maxHR thresholds, inclusive at the lower edge', () => {
  const max = 200;
  assert.equal(zoneFor(100, max).key, 'warmup');    // 50 %
  assert.equal(zoneFor(119, max).key, 'warmup');    // 59.5 %
  assert.equal(zoneFor(120, max).key, 'fatburn');   // exactly 60 %
  assert.equal(zoneFor(139, max).key, 'fatburn');   // 69.5 %
  assert.equal(zoneFor(140, max).key, 'aerobic');   // exactly 70 %
  assert.equal(zoneFor(159, max).key, 'aerobic');
  assert.equal(zoneFor(160, max).key, 'anaerobic'); // exactly 80 %
  assert.equal(zoneFor(179, max).key, 'anaerobic');
  assert.equal(zoneFor(180, max).key, 'extreme');   // exactly 90 %
  assert.equal(zoneFor(240, max).key, 'extreme');
});

test('zoneFor names map one-to-one onto the canonical keys', () => {
  assert.equal(zoneFor(100, 200).name, 'Warm Up');
  assert.equal(zoneFor(120, 200).name, 'Fat Burn');
  assert.equal(zoneFor(140, 200).name, 'Aerobic');
  assert.equal(zoneFor(160, 200).name, 'Anaerobic');
  assert.equal(zoneFor(180, 200).name, 'Extreme');
});

test('zoneFor falls back to a sane max HR when the profile is broken', () => {
  assert.equal(zoneFor(95, 0).key, 'warmup');   // 95/190 = 50 %
  assert.equal(zoneFor(150, null).key, 'aerobic'); // 150/190 = 78.9 %
});

// ---------------------------------------------------------------------------
// HRV
// ---------------------------------------------------------------------------
test('rmssd returns null until at least two RR intervals exist — it never fakes a value', () => {
  assert.equal(rmssd([]), null);
  assert.equal(rmssd([800]), null);
  assert.equal(rmssd(null), null);
  assert.equal(rmssd([800, 850]), 50);
});

test('rmssd ignores artefact-sized jumps and reports null when nothing is usable', () => {
  // A 600 ms step is a dropped beat, not heart rate variability.
  assert.equal(rmssd([800, 1400]), null);
  // 800->850->800: two diffs of 50 -> rMSSD 50.
  assert.equal(rmssd([800, 850, 800]), 50);
});

test('the HRV readout stays null through the first sample and is real from the second', () => {
  const { state, clock } = makeState();

  const first = state.ingest({ bpm: 75, rr: 800 }, clock.t);
  assert.equal(first.hrv, null, 'one RR interval cannot produce an rMSSD');

  clock.t += 1000;
  const second = state.ingest({ bpm: 75, rr: 840 }, clock.t);
  assert.equal(second.hrv, 40);
});

test('a missing RR interval is derived from the heart rate', () => {
  const { state, clock } = makeState();
  const sample = state.ingest({ bpm: 60 }, clock.t);
  assert.equal(sample.rrMs, 1000);
});

// ---------------------------------------------------------------------------
// Calories
// ---------------------------------------------------------------------------
test('calories accumulate exactly once per sample', () => {
  const { state, clock } = makeState();
  const profile = state.profile;

  // First sample only sets the integration baseline.
  state.ingest({ bpm: 120, rr: 500 }, clock.t);
  assert.equal(state.kcal, 0);

  clock.t += 1000;
  state.ingest({ bpm: 120, rr: 500 }, clock.t);
  const expectedPerSecond = kcalPerMinute(120, profile) / 60;
  assert.ok(Math.abs(state.kcal - expectedPerSecond) < 1e-9,
    `expected ${expectedPerSecond}, got ${state.kcal}`);

  // Ten further seconds in one-second steps must add exactly ten more seconds
  // worth of energy — never twice per sample the way the old build did.
  for (let i = 0; i < 10; i++) {
    clock.t += 1000;
    state.ingest({ bpm: 120, rr: 500 }, clock.t);
  }
  assert.ok(Math.abs(state.kcal - expectedPerSecond * 11) < 1e-9,
    `expected ${expectedPerSecond * 11}, got ${state.kcal}`);
});

test('calorie integration skips gaps longer than 10 s and non-positive steps', () => {
  const { state, clock } = makeState();
  state.ingest({ bpm: 120 }, clock.t);
  clock.t += 1000;
  state.ingest({ bpm: 120 }, clock.t);
  const afterOneSecond = state.kcal;

  clock.t += 60_000; // stream stalled for a minute
  state.ingest({ bpm: 120 }, clock.t);
  assert.equal(state.kcal, afterOneSecond, 'a stalled minute must not be billed as exercise');

  state.ingest({ bpm: 120 }, clock.t); // same timestamp: zero elapsed
  assert.equal(state.kcal, afterOneSecond);
});

test('starting a recording resets the calorie budget and the integrator baseline', () => {
  const { state, clock } = makeState();
  state.ingest({ bpm: 120 }, clock.t);
  clock.t += 5000;
  state.ingest({ bpm: 120 }, clock.t);
  assert.ok(state.kcal > 0);

  state.startRecording(clock.t);
  assert.equal(state.kcal, 0);
  assert.equal(state.lastKcalAt, null);

  clock.t += 1000;
  const sample = state.ingest({ bpm: 120 }, clock.t);
  assert.equal(sample.stats.kcal, 0, 'the first sample after start only re-arms the baseline');
});

test('kcalPerMinute covers both genders and floors at a basal rate that still tracks HR', () => {
  const male = { age: 30, gender: 'male', weightKg: 80 };
  const female = { age: 30, gender: 'female', weightKg: 65 };

  assert.ok(kcalPerMinute(150, male) > kcalPerMinute(100, male));
  assert.ok(kcalPerMinute(150, female) > kcalPerMinute(100, female));
  assert.notEqual(kcalPerMinute(150, male), kcalPerMinute(150, female));

  // At rest the regression goes negative; the floor branch takes over.
  const resting = kcalPerMinute(55, male);
  assert.ok(Math.abs(resting - (1.2 + (55 - 50) * 0.02)) < 1e-9, `got ${resting}`);
});

// ---------------------------------------------------------------------------
// Stress index
// ---------------------------------------------------------------------------
test('stressIndex combines HR elevation, HRV suppression and the user offset', () => {
  // (100-60)*0.9 = 36, (100-50)*0.4 = 20 -> 56
  assert.equal(stressIndex(100, 50, 0), 56);
  assert.equal(stressIndex(100, 50, 10), 66);
  // A null HRV is treated as the 50 ms neutral midpoint.
  assert.equal(stressIndex(100, null, 0), 56);
});

test('stressIndex clamps to 0..100 at both ends', () => {
  assert.equal(stressIndex(220, 5, 50), 100);
  assert.equal(stressIndex(40, 100, 0), 0);
  assert.equal(stressIndex(100, 50, -100), 0);
  assert.equal(stressIndex(300, 0, 0), 100);
});

test('stressText buckets follow the 25/50/70 boundaries', () => {
  assert.equal(stressText(0), 'Relaxed');
  assert.equal(stressText(25), 'Relaxed');
  assert.equal(stressText(26), 'Normal');
  assert.equal(stressText(51), 'Tense');
  assert.equal(stressText(71), 'Stressed');
});

test('stress statistics track min, max and average across the session', () => {
  const { state, clock } = makeState();
  const seen = [];
  for (const bpm of [70, 120, 90]) {
    seen.push(state.ingest({ bpm, rr: Math.round(60000 / bpm) }, clock.t).stress);
    clock.t += 1000;
  }
  const last = state.lastPayload;
  assert.equal(last.stressStats.min, Math.min(...seen));
  assert.equal(last.stressStats.max, Math.max(...seen));
  assert.equal(last.stressStats.avg, Math.round(seen.reduce((a, b) => a + b, 0) / seen.length));
});

// ---------------------------------------------------------------------------
// BPM statistics and zone distribution
// ---------------------------------------------------------------------------
test('bpm statistics track min, max and average', () => {
  const { state, clock } = makeState();
  for (const bpm of [80, 60, 100]) {
    state.ingest({ bpm }, clock.t);
    clock.t += 1000;
  }
  assert.deepEqual(state.lastPayload.stats.min, 60);
  assert.deepEqual(state.lastPayload.stats.max, 100);
  assert.deepEqual(state.lastPayload.stats.avg, 80);
});

test('zone distribution buckets by canonical key and always sums over the real ticks', () => {
  const { state, clock } = makeState(); // maxHr 200

  for (let i = 0; i < 3; i++) { state.ingest({ bpm: 100 }, clock.t); clock.t += 1000; } // warmup
  state.ingest({ bpm: 180 }, clock.t); // extreme

  const pct = state.lastPayload.zonePct;
  assert.deepEqual(Object.keys(pct).sort(), [...ZONE_KEYS].sort());
  assert.equal(pct.warmup, 75);
  assert.equal(pct.extreme, 25);
  assert.equal(pct.fatburn, 0);
  assert.equal(state.zoneTickTotal, 4, 'no sample may fall outside the buckets');
});

// ---------------------------------------------------------------------------
// Breathing pacer and coherence
// ---------------------------------------------------------------------------
test('the pacer alternates every 5 s and reports phase changes once', () => {
  const { state, clock } = makeState();
  assert.equal(state.phaseAt(clock.t), 'inhale');
  assert.equal(state.phaseAt(clock.t + 4999), 'inhale');
  assert.equal(state.phaseAt(clock.t + 5000), 'exhale');
  assert.equal(state.phaseAt(clock.t + 9999), 'exhale');
  assert.equal(state.phaseAt(clock.t + 10_000), 'inhale');

  assert.equal(state.tickBreath(clock.t + 1000).changed, false);
  const flip = state.tickBreath(clock.t + 5000);
  assert.equal(flip.changed, true);
  assert.equal(flip.phase, 'exhale');
  assert.equal(state.tickBreath(clock.t + 6000).changed, false);
});

test('coherence scores a rising HR on inhale and a falling HR on exhale', () => {
  const { state, clock } = makeState();
  const t0 = clock.t;

  // Inhale phase: baseline 70, HR rises -> coherent.
  assert.equal(state.ingest({ bpm: 70 }, t0).coherence, 100);
  assert.equal(state.ingest({ bpm: 75 }, t0 + 1000).coherence, 100);

  // Exhale phase begins; the baseline becomes the HR at the boundary (75) and
  // a rising HR is now incoherent.
  const exhale = state.ingest({ bpm: 80 }, t0 + 5000);
  assert.equal(exhale.breathPhase, 'exhale');
  assert.equal(exhale.coherence, 67, '2 of 3 samples coherent');

  // A falling HR during exhale scores again.
  const falling = state.ingest({ bpm: 70 }, t0 + 6000);
  assert.equal(falling.coherence, 75, '3 of 4 samples coherent');
});

test('coherence averages over a 15-sample window only', () => {
  const { state, clock } = makeState();
  const t0 = clock.t;

  // 20 incoherent exhale samples must fully flush the earlier coherent ones.
  state.ingest({ bpm: 70 }, t0);
  for (let i = 0; i < 20; i++) {
    // Stay inside the exhale half-cycle window by re-anchoring the pacer.
    state.breathPhase = 'exhale';
    state.breathCycleHrStart = 60;
    state.breathStartAt = t0 + (i * 1000) - 5000;
    state.ingest({ bpm: 100 }, t0 + (i * 1000));
  }
  assert.equal(state.coherenceScores.length, 15);
  assert.equal(state.coherence(), 0);
});

// ---------------------------------------------------------------------------
// Threshold alarm
// ---------------------------------------------------------------------------
test('the threshold alarm only latches after the duration filter has elapsed', () => {
  const { state, clock } = makeState({ alarm: { bpmLimit: 130, durationSec: 3 } });
  const t0 = clock.t;

  assert.deepEqual(state.checkThreshold(135, t0), { active: false, changed: false });
  assert.deepEqual(state.checkThreshold(140, t0 + 2999), { active: false, changed: false });

  const latched = state.checkThreshold(140, t0 + 3000);
  assert.deepEqual(latched, { active: true, changed: true }, 'edge reported exactly once');
  assert.deepEqual(state.checkThreshold(140, t0 + 4000), { active: true, changed: false });
});

test('one sample under the limit clears the alarm and restarts the filter', () => {
  const { state, clock } = makeState({ alarm: { bpmLimit: 130, durationSec: 3 } });
  const t0 = clock.t;

  state.checkThreshold(135, t0);
  state.checkThreshold(135, t0 + 3000);
  assert.equal(state.thresholdActive, true);

  const cleared = state.checkThreshold(120, t0 + 3500);
  assert.deepEqual(cleared, { active: false, changed: true });
  assert.equal(state.thresholdStartedAt, null);

  // The filter starts from scratch: being over the limit again is not enough.
  assert.equal(state.checkThreshold(135, t0 + 4000).active, false);
  assert.equal(state.checkThreshold(135, t0 + 6999).active, false);
  assert.equal(state.checkThreshold(135, t0 + 7000).active, true);
});

test('a zero-second duration filter latches immediately', () => {
  const { state, clock } = makeState({ alarm: { bpmLimit: 100, durationSec: 0 } });
  assert.deepEqual(state.checkThreshold(101, clock.t), { active: true, changed: true });
});

test('losing the stream clears the latched alarm', () => {
  const { state, clock } = makeState({ alarm: { bpmLimit: 100, durationSec: 0 } });
  state.checkThreshold(120, clock.t);
  assert.equal(state.thresholdActive, true);
  state.clearLive();
  assert.equal(state.thresholdActive, false);
  assert.equal(state.thresholdStartedAt, null);
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------
test('liveness expires 10 s after the last sample and is cleared on BYE', () => {
  const { state, clock } = makeState();
  assert.equal(state.isLive(clock.t), false, 'nothing is live before the first sample');

  state.ingest({ bpm: 80 }, clock.t);
  assert.equal(state.isLive(clock.t), true);
  assert.equal(state.isLive(clock.t + 10_000), true);
  assert.equal(state.isLive(clock.t + 10_001), false);

  state.ingest({ bpm: 80 }, clock.t + 11_000);
  assert.equal(state.isLive(clock.t + 11_000), true);
  state.clearLive();
  assert.equal(state.isLive(clock.t + 11_000), false);
});

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------
test('the recorder buffers samples with elapsed seconds and stops cleanly', () => {
  const { state, clock } = makeState();
  const t0 = clock.t;

  state.ingest({ bpm: 90, rr: 660 }, t0); // before start: not recorded
  state.startRecording(t0 + 1000);

  state.ingest({ bpm: 92, rr: 650 }, t0 + 1000);
  state.ingest({ bpm: 94, rr: 640 }, t0 + 3500);
  const stopped = state.stopRecording();

  assert.equal(stopped.rows, 2);
  const rows = state.rows();
  assert.equal(rows[0].elapsed, 0);
  assert.equal(rows[1].elapsed, 3);
  assert.equal(rows[1].bpm, 94);
  assert.equal(rows[1].rr, 640);
  assert.equal(typeof rows[1].zone, 'string');
  assert.equal(typeof rows[1].stress, 'number');

  const after = state.ingest({ bpm: 96 }, t0 + 5000);
  assert.equal(after.recording, false);
  assert.equal(after.elapsedRecSec, null);
  assert.equal(state.rows().length, 2, 'nothing is recorded after stop');
});

// ---------------------------------------------------------------------------
// Payload shape (the IPC contract the renderer codes against)
// ---------------------------------------------------------------------------
test('ingest returns the full processed payload and rejects unusable samples', () => {
  const { state, clock } = makeState();
  assert.equal(state.ingest({ bpm: 0 }, clock.t), null);
  assert.equal(state.ingest({ bpm: 'nonsense' }, clock.t), null);
  assert.equal(state.ingest(null, clock.t), null);

  const p = state.ingest({ bpm: 88, rr: 690, contact: true, battery: 77, rssi: -60 }, clock.t);
  for (const key of ['bpm', 'rrMs', 'hrv', 'stress', 'stressText', 'zone', 'zoneKey', 'contact',
    'battery', 'rssi', 'stats', 'stressStats', 'zonePct', 'coherence', 'breathPhase',
    'elapsedRecSec', 'recording', 'chartPoint']) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, key), `payload is missing "${key}"`);
  }
  assert.equal(p.bpm, 88);
  assert.equal(p.contact, true);
  assert.equal(p.battery, 77);
  assert.equal(p.rssi, -60);
  assert.equal(p.chartPoint.bpm, 88);
  assert.equal(typeof p.chartPoint.t, 'string');
  assert.equal(p.chartPoint.ts, clock.t);
});

test('resetStats clears every accumulator', () => {
  const { state, clock } = makeState();
  state.ingest({ bpm: 120, rr: 500 }, clock.t);
  state.ingest({ bpm: 130, rr: 520 }, clock.t + 1000);
  state.resetStats(clock.t + 2000);

  assert.equal(state.bpmMin, null);
  assert.equal(state.bpmMax, null);
  assert.equal(state.bpmCount, 0);
  assert.equal(state.kcal, 0);
  assert.equal(state.rrHistory.length, 0);
  assert.equal(state.zoneTickTotal, 0);
  assert.equal(state.coherence(), 0);
  assert.equal(state.isLive(clock.t + 2000), false);
});

test('formatClock renders HH:MM:SS', () => {
  assert.equal(formatClock(0), '00:00:00');
  assert.equal(formatClock(61), '00:01:01');
  assert.equal(formatClock(3725), '01:02:05');
});

// ---------------------------------------------------------------------------
// Health Connect daily summary (normalizeHealth)
// ---------------------------------------------------------------------------
const HEALTH_TS = 1_734_300_000_000;

/** The message the phone sends verbatim (SPEC.md "Health summary message"). */
function healthMessage(summary, extra = {}) {
  return { type: 'health', ts: HEALTH_TS, summary, ...extra };
}

const FULL_SUMMARY = {
  steps: 8421,
  distanceKm: 6.2,
  activeKcal: 412.5,
  totalKcal: 1980.0,
  sleepMin: 432,
  restingBpm: 58,
  minBpm: 52,
  avgBpm: 74,
  maxBpm: 141,
  spo2Pct: 97.0,
  source: 'huawei'
};

test('normalizeHealth passes a full valid payload straight through', () => {
  assert.deepEqual(normalizeHealth(healthMessage(FULL_SUMMARY)), {
    ts: HEALTH_TS,
    steps: 8421,
    distanceKm: 6.2,
    activeKcal: 412.5,
    totalKcal: 1980,
    sleepMin: 432,
    restingBpm: 58,
    minBpm: 52,
    avgBpm: 74,
    maxBpm: 141,
    spo2Pct: 97,
    source: 'huawei'
  });
});

test('normalizeHealth always returns the whole field set, even for an all-null summary', () => {
  const allNull = Object.fromEntries(Object.keys(FULL_SUMMARY).map((k) => [k, null]));
  const out = normalizeHealth(healthMessage(allNull));

  assert.equal(out.ts, HEALTH_TS);
  assert.equal(out.source, 'healthconnect', 'a null source is plain Health Connect');
  for (const key of ['steps', 'distanceKm', 'activeKcal', 'totalKcal', 'sleepMin',
    'restingBpm', 'minBpm', 'avgBpm', 'maxBpm', 'spo2Pct']) {
    assert.equal(out[key], null, `"${key}" must stay null, never 0`);
  }
});

test('normalizeHealth fills in every field for an empty summary object', () => {
  const out = normalizeHealth(healthMessage({}));
  assert.deepEqual(Object.keys(out).sort(), [
    'activeKcal', 'avgBpm', 'distanceKm', 'maxBpm', 'minBpm', 'restingBpm',
    'sleepMin', 'source', 'spo2Pct', 'steps', 'totalKcal', 'ts'
  ]);
  assert.equal(out.steps, null);
  assert.equal(out.source, 'healthconnect');
});

test('normalizeHealth rejects garbage per field and keeps the usable ones', () => {
  const out = normalizeHealth(healthMessage({
    steps: 'not a number',
    distanceKm: NaN,
    activeKcal: true,              // Number(true) is 1 — never a measurement
    totalKcal: {},
    sleepMin: Infinity,
    restingBpm: '',                // Number('') is 0 — never a measurement
    minBpm: -5,                    // a negative heart rate is a bad read
    avgBpm: [74],
    maxBpm: undefined,
    spo2Pct: 96.5,                 // the one good reading survives
    source: 'huawei'
  }));

  for (const key of ['steps', 'distanceKm', 'activeKcal', 'totalKcal', 'sleepMin',
    'restingBpm', 'minBpm', 'avgBpm', 'maxBpm']) {
    assert.equal(out[key], null, `"${key}" must be rejected`);
  }
  assert.equal(out.spo2Pct, 96.5, 'one bad field must not discard the rest of the day');
  assert.equal(out.source, 'huawei');
});

test('normalizeHealth accepts numeric strings the way the rest of the pipeline does', () => {
  const out = normalizeHealth(healthMessage({ steps: '8421', distanceKm: '6.24' }));
  assert.equal(out.steps, 8421);
  assert.equal(out.distanceKm, 6.2);
});

test('normalizeHealth rounds counts to integers and measurements to one decimal', () => {
  const out = normalizeHealth(healthMessage({
    steps: 8421.6,
    sleepMin: 431.5,
    restingBpm: 57.4,
    minBpm: 51.5,
    avgBpm: 73.49,
    maxBpm: 140.99,
    distanceKm: 6.249,
    activeKcal: 412.55,
    totalKcal: 1979.94,
    spo2Pct: 96.96
  }));

  assert.equal(out.steps, 8422);
  assert.equal(out.sleepMin, 432);
  assert.equal(out.restingBpm, 57);
  assert.equal(out.minBpm, 52);
  assert.equal(out.avgBpm, 73);
  assert.equal(out.maxBpm, 141);
  assert.equal(out.distanceKm, 6.2);
  assert.equal(out.activeKcal, 412.6);
  assert.equal(out.totalKcal, 1979.9);
  assert.equal(out.spo2Pct, 97);
});

test('normalizeHealth coerces the source to the two documented values', () => {
  const source = (value) => normalizeHealth(healthMessage({ source: value })).source;

  assert.equal(source('huawei'), 'huawei');
  assert.equal(source('HUAWEI'), 'huawei');
  assert.equal(source(' Huawei '), 'huawei');
  assert.equal(source('healthconnect'), 'healthconnect');
  assert.equal(source('com.google.android.apps.fitness'), 'healthconnect');
  assert.equal(source(''), 'healthconnect');
  assert.equal(source(undefined), 'healthconnect');
  assert.equal(source(null), 'healthconnect');
  assert.equal(source(42), 'healthconnect');
});

test('normalizeHealth rejects anything that is not a health message', () => {
  assert.equal(normalizeHealth(null), null);
  assert.equal(normalizeHealth(undefined), null);
  assert.equal(normalizeHealth('health'), null);
  assert.equal(normalizeHealth(42), null);
  assert.equal(normalizeHealth([]), null);
  assert.equal(normalizeHealth({}), null, 'no type');
  // A vitals sample must never be mistaken for a summary.
  assert.equal(normalizeHealth({ bpm: 72, rr: 812, src: 'health' }), null);
  assert.equal(normalizeHealth({ type: 'vitals', summary: FULL_SUMMARY }), null);
});

test('normalizeHealth rejects a message whose summary is missing or not an object', () => {
  assert.equal(normalizeHealth({ type: 'health', ts: HEALTH_TS }), null);
  assert.equal(normalizeHealth({ type: 'health', ts: HEALTH_TS, summary: null }), null);
  assert.equal(normalizeHealth({ type: 'health', ts: HEALTH_TS, summary: 'steps' }), null);
  assert.equal(normalizeHealth({ type: 'health', ts: HEALTH_TS, summary: 8421 }), null);
  assert.equal(normalizeHealth({ type: 'health', ts: HEALTH_TS, summary: [FULL_SUMMARY] }), null);
});

test('normalizeHealth falls back to the supplied clock for a missing or broken ts', () => {
  const now = 1_700_000_000_000;
  assert.equal(normalizeHealth({ type: 'health', summary: {} }, now).ts, now);
  assert.equal(normalizeHealth(healthMessage({}, { ts: null }), now).ts, now);
  assert.equal(normalizeHealth(healthMessage({}, { ts: 'yesterday' }), now).ts, now);
  assert.equal(normalizeHealth(healthMessage({}, { ts: -1 }), now).ts, now);
  assert.equal(normalizeHealth(healthMessage({}, { ts: HEALTH_TS + 0.7 }), now).ts, HEALTH_TS + 1);

  // Without a clock the wall time stands in, so the card can always stamp itself.
  const stamped = normalizeHealth({ type: 'health', summary: {} }).ts;
  assert.ok(Number.isInteger(stamped) && Math.abs(Date.now() - stamped) < 5000, `got ${stamped}`);
});

test('normalizeHealth is pure — it never mutates the message it is handed', () => {
  const message = healthMessage({ ...FULL_SUMMARY, steps: 8421.6 });
  const snapshot = JSON.parse(JSON.stringify(message));
  normalizeHealth(message);
  assert.deepEqual(message, snapshot);
});
