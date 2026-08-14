#!/usr/bin/env node
/**
 * PULSENX PC — HEADLESS END-TO-END TEST
 *
 * Launches the real Electron app and verifies the whole pipeline:
 *
 *   ws://127.0.0.1:9000 (tcp)  ->  main process  ->  renderer IPC
 *                              ->  ws broadcast  ->  OBS browser source
 *                              ->  OSC           ->  127.0.0.1:9000 (udp)
 *
 * The two port 9000 bindings do not collide: the link server is TCP, the OSC
 * target is UDP.
 *
 * Usage:
 *   npm run test:e2e
 *   ELECTRON_CMD="/path/to/electron" npm run test:e2e
 *
 * The app runs against a throwaway --user-data-dir, so the developer's own
 * settings are never read or overwritten, and Discord Rich Presence is
 * suppressed in --e2e-hooks mode so the test cannot hijack a real presence.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const WebSocket = require('ws');
const osc = require('node-osc');

// -------------------------------------------------------------------------
// Test parameters
// -------------------------------------------------------------------------
const LINK_WS_URL = 'ws://127.0.0.1:9000';
const OSC_UDP_PORT = 9000;
const HOOKS_PORT = 9010;
const OBS_PORT = 9005;

const TEST_BPM = 96;                 // 96 bpm -> one beat every 625 ms
const TEST_RR = Math.round(60000 / TEST_BPM);
const VITALS_INTERVAL_MS = 250;      // 4 packets/second from the "phone"
const STREAM_DURATION_MS = 10000;
const SETTLE_MS = 2000;              // ignored at the start of the rate window
const BOOT_TIMEOUT_MS = 30000;

const AVATAR_PARAMS_PER_TICK = 20;   // messages emitted by one sendAvatarParams
const BEAT_PARAMS = ['/avatar/parameters/isHRBeat', '/avatar/parameters/HeartBeatPulse',
                     '/avatar/parameters/HeartBeat', '/avatar/parameters/HBListen'];

const FATAL_LOG_PATTERNS = [
  /Cannot set propert(y|ies) of null/i,
  /Cannot read propert(y|ies) of null/i,
  /Cannot set propert(y|ies) of undefined/i,
  /ReferenceError/,
  /is not defined/,
  /Uncaught .*Error/
];

// -------------------------------------------------------------------------
// Harness state
// -------------------------------------------------------------------------
const failures = [];
const checks = [];
let child = null;
let oscServer = null;
let phoneSocket = null;
let obsSocket = null;
let userDataDir = null;

const appOutput = [];
const oscMessages = [];   // { t, address, args }
const obsFrames = [];     // frames received by the synthetic OBS consumer

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------------------
// Process control
// -------------------------------------------------------------------------
function resolveElectronCommand() {
  if (process.env.ELECTRON_CMD) {
    const parts = process.env.ELECTRON_CMD.trim().split(/\s+/);
    return { cmd: parts[0], prefixArgs: parts.slice(1) };
  }

  const localElectron = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(localElectron)) {
    throw new Error(`Electron binary not found at ${localElectron}. Run "npm install" first.`);
  }

  // A headless box has no DISPLAY; xvfb-run supplies one.
  if (!process.env.DISPLAY) {
    const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0;
    if (!hasXvfb) {
      throw new Error('No DISPLAY and xvfb-run is unavailable. Set ELECTRON_CMD or install xvfb.');
    }
    return { cmd: 'xvfb-run', prefixArgs: ['-a', localElectron] };
  }

  return { cmd: localElectron, prefixArgs: [] };
}

function launchApp() {
  const { cmd, prefixArgs } = resolveElectronCommand();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsenx-e2e-'));

  const args = [
    ...prefixArgs,
    APP_DIR,
    '--no-sandbox',
    '--disable-gpu',
    '--e2e-hooks',
    '--enable-logging=stderr',
    `--user-data-dir=${userDataDir}`
  ];

  console.log(`Launching: ${cmd} ${args.join(' ')}`);

  // detached puts the app in its own process group so the whole tree
  // (xvfb-run -> Xvfb -> electron -> zygotes) dies with a single group kill.
  child = spawn(cmd, args, { cwd: APP_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const record = (buf) => {
    buf.toString().split(/\r?\n/).filter(Boolean).forEach((line) => appOutput.push(line));
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.on('error', (err) => failures.push(`Failed to spawn the app: ${err.message}`));

  return child;
}

function signalGroup(signal) {
  if (!child) return;
  try {
    // Negative pid targets the whole group: xvfb-run, Xvfb, electron, zygotes.
    process.kill(-child.pid, signal);
  } catch (e) {
    try { child.kill(signal); } catch (e2) { /* already gone */ }
  }
}

async function killApp() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));

  signalGroup('SIGTERM');
  const stillRunning = await Promise.race([
    exited.then(() => false),
    sleep(5000).then(() => true)
  ]);

  if (stillRunning) {
    signalGroup('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

function killAppSync() {
  signalGroup('SIGTERM');
  signalGroup('SIGKILL');
}

function waitForLogLine(pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (appOutput.some((line) => pattern.test(line))) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for /${pattern.source}/ in the app output`));
      } else if (child && child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`App exited early with code ${child.exitCode}`));
      }
    }, 200);
  });
}

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------
function getJson(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad response for ${route}: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function getText(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

const probe = (route) => getJson(HOOKS_PORT, route);

// -------------------------------------------------------------------------
// Assertions
// -------------------------------------------------------------------------
function assertOscTraffic(windowStart, windowEnd) {
  const windowSeconds = (windowEnd - windowStart) / 1000;
  const inWindow = oscMessages.filter((m) => m.t >= windowStart && m.t <= windowEnd);

  const avatarParams = inWindow.filter(
    (m) => m.address.startsWith('/avatar/parameters/') && !BEAT_PARAMS.includes(m.address)
  );
  const rate = avatarParams.length / windowSeconds;

  check(
    'OSC avatar parameter stream runs at the 1 Hz broadcaster rate',
    rate >= AVATAR_PARAMS_PER_TICK * 0.75 && rate <= AVATAR_PARAMS_PER_TICK * 1.35,
    `${rate.toFixed(1)} msg/s over ${windowSeconds.toFixed(1)}s (expected ~${AVATAR_PARAMS_PER_TICK})`
  );

  const hrValues = inWindow
    .filter((m) => m.address === '/avatar/parameters/HR')
    .map((m) => m.args[0]);
  check(
    'OSC /avatar/parameters/HR reflects the injected BPM',
    hrValues.length > 0 && hrValues.every((v) => Number(v) === TEST_BPM),
    `${hrValues.length} samples, distinct values: ${[...new Set(hrValues)].join(', ') || 'none'}`
  );

  const hrPercent = inWindow
    .filter((m) => m.address === '/avatar/parameters/HRPercent')
    .map((m) => Number(m.args[0]));
  const expectedPercent = TEST_BPM / 150; // default OSC min/max HR = 0/150
  check(
    'OSC /avatar/parameters/HRPercent is normalised against the OSC min/max range',
    hrPercent.length > 0 && hrPercent.every((v) => Math.abs(v - expectedPercent) < 0.02),
    `expected ~${expectedPercent.toFixed(3)}, saw ${hrPercent.length ? hrPercent[0].toFixed(3) : 'none'}`
  );

  check(
    'OSC isHRConnected is broadcast while vitals are live',
    inWindow.some((m) => m.address === '/avatar/parameters/isHRConnected'),
    ''
  );

  const beats = inWindow.filter((m) => m.address === '/avatar/parameters/isHRBeat');
  const rising = beats.filter((m) => m.args[0] === true || m.args[0] === 1);
  const falling = beats.filter((m) => m.args[0] === false || m.args[0] === 0);
  const expectedBeats = (TEST_BPM / 60) * windowSeconds;

  check(
    'OSC isHRBeat pulses with the beat-sync toggle enabled by default',
    rising.length >= expectedBeats * 0.6 && falling.length >= expectedBeats * 0.6,
    `${rising.length} rising / ${falling.length} falling (expected ~${expectedBeats.toFixed(0)})`
  );

  const gaps = [];
  for (let i = 1; i < rising.length; i++) gaps.push(rising[i].t - rising[i - 1].t);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const expectedGap = 60000 / TEST_BPM;

  check(
    'OSC isHRBeat cadence tracks the heart rate',
    gaps.length > 3 && Math.abs(medianGap - expectedGap) <= expectedGap * 0.35,
    `median gap ${medianGap} ms (expected ~${expectedGap.toFixed(0)} ms)`
  );
}

function assertOscSilenceAfterDisconnect(from) {
  const after = oscMessages.filter(
    (m) => m.t > from && m.address.startsWith('/avatar/parameters/')
      && m.address !== '/avatar/parameters/HeartRateWarning'
      && !BEAT_PARAMS.includes(m.address)
  );
  check(
    'OSC avatar parameters stop once the phone disconnects (isHRConnected never lies)',
    after.length === 0,
    `${after.length} message(s) after disconnect: ${[...new Set(after.map((m) => m.address))].slice(0, 3).join(', ')}`
  );
}

function assertNoRuntimeErrors() {
  const offenders = appOutput.filter((line) =>
    FATAL_LOG_PATTERNS.some((pattern) => pattern.test(line))
  );
  check(
    'App output is free of null-property and reference errors',
    offenders.length === 0,
    offenders.slice(0, 5).join(' | ')
  );
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------
async function run() {
  console.log('PulseNX end-to-end test\n');

  // 1. OSC listener first, so nothing emitted during boot is missed.
  oscServer = new osc.Server(OSC_UDP_PORT, '127.0.0.1');
  oscServer.on('message', (msg) => {
    oscMessages.push({ t: Date.now(), address: msg[0], args: msg.slice(1) });
  });
  await new Promise((resolve) => oscServer.on('listening', resolve));
  console.log(`OSC listener bound to 127.0.0.1:${OSC_UDP_PORT}/udp`);

  // 2. Boot the app.
  launchApp();
  await waitForLogLine(/LAN WebSocket server listening/, BOOT_TIMEOUT_MS);
  await waitForLogLine(/E2E test hooks listening/, BOOT_TIMEOUT_MS);
  await waitForLogLine(/OBS browser-source server listening/, BOOT_TIMEOUT_MS);
  await waitForLogLine(/Discovery beacon broadcasting/, BOOT_TIMEOUT_MS);
  console.log('All servers report ready');

  // 3. Nothing may be broadcast before a phone links.
  await sleep(1500);
  check(
    'No OSC avatar parameters are broadcast before a phone links',
    oscMessages.filter((m) => m.address.startsWith('/avatar/parameters/')).length === 0,
    `${oscMessages.length} message(s) seen while idle`
  );

  // 4. The OBS widget page must be self-contained (an OBS box is often offline).
  const widget = await getText(OBS_PORT, '/');
  check('OBS widget page is served on :9005', /PulseNX/.test(widget), '');
  check(
    'OBS widget page pulls in no external resources',
    !/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(widget),
    (widget.match(/https?:\/\/[^"'\s)]+/gi) || []).slice(0, 3).join(', ')
  );
  check('OBS widget page carries the NX violet theme', /#7700FF/i.test(widget), '');

  // 5. A consumer socket (what the OBS page is) attaches to the same hub.
  obsSocket = new WebSocket(LINK_WS_URL);
  await new Promise((resolve, reject) => {
    obsSocket.once('open', resolve);
    obsSocket.once('error', reject);
  });
  obsSocket.on('message', (data) => {
    try { obsFrames.push(JSON.parse(data.toString())); } catch (e) { /* ignore */ }
  });

  // 6. Connect the synthetic phone and stream vitals.
  phoneSocket = new WebSocket(LINK_WS_URL);
  await new Promise((resolve, reject) => {
    phoneSocket.once('open', resolve);
    phoneSocket.once('error', reject);
  });
  console.log('Synthetic phone connected to the link server');

  const streamStart = Date.now();
  const pump = setInterval(() => {
    if (phoneSocket.readyState === WebSocket.OPEN) {
      phoneSocket.send(JSON.stringify({
        bpm: TEST_BPM, rr: TEST_RR, contact: true, battery: 88, rssi: -55
      }));
    }
  }, VITALS_INTERVAL_MS);

  await sleep(3000);

  // 7. Producer/consumer separation.
  check(
    'Processed vitals are broadcast to consumer sockets',
    obsFrames.length > 0 && obsFrames[obsFrames.length - 1].bpm === TEST_BPM,
    `${obsFrames.length} frame(s), last bpm ${obsFrames.length ? obsFrames[obsFrames.length - 1].bpm : 'none'}`
  );
  check(
    'Consumer broadcasts carry processed fields, not the raw phone packet',
    obsFrames.length > 0 && 'zoneKey' in obsFrames[obsFrames.length - 1],
    ''
  );

  // 8. The synthetic injection route feeds the same pipeline.
  const injected = await probe('/inject?bpm=123&rr=488');
  check('/inject feeds a synthetic sample through the real pipeline', injected.ok === true, '');
  check(
    '/inject returns the processed payload',
    !!injected.processed && injected.processed.bpm === 123 && typeof injected.processed.zoneKey === 'string',
    injected.processed ? `zone ${injected.processed.zoneKey}` : 'no payload'
  );

  // 9. DOM assertions mid-stream (the dashboard is rendered by the renderer).
  // Let the phone stream overwrite the injected sample above first, otherwise
  // the readouts legitimately show 123 rather than the streamed rate.
  await sleep(750);
  const live = await probe('/dom');
  check('DOM: bpm-val shows the injected heart rate', live.bpm === String(TEST_BPM), `read "${live.bpm}"`);
  check('DOM: zone-badge is populated', !!live.zone && live.zone.length > 0, `read "${live.zone}"`);
  check('DOM: hrv-val is populated', !!live.hrv && live.hrv !== '--', `read "${live.hrv}"`);
  check('DOM: stress-val is populated', !!live.stress && live.stress !== '--', `read "${live.stress}"`);
  check('DOM: stat-avg-bpm accumulates', !!live.avgBpm && live.avgBpm !== '-', `read "${live.avgBpm}"`);
  check('DOM: zone distribution is driven', !!live.zoneWarmupPct, `read "${live.zoneWarmupPct}"`);
  check('DOM: record button unlocks once a phone is linked', live.recordStartEnabled === true, '');

  // 10. Session recorder.
  const started = await probe('/action/record-start');
  check('DOM: Start Recording is clickable', started.ok === true, '');
  await sleep(1500);
  const recording = await probe('/dom');
  check('DOM: rec-indicator turns active while recording', recording.recording === true, '');
  check(
    'DOM: session-timer advances while recording',
    !!recording.sessionTimer && recording.sessionTimer !== '00:00:00',
    `read "${recording.sessionTimer}"`
  );

  await probe('/action/record-stop');
  await sleep(500);
  const stopped = await probe('/dom');
  check('DOM: rec-indicator clears when recording stops', stopped.recording === false, '');
  check('DOM: CSV export unlocks after a recorded session', stopped.exportEnabled === true, '');

  // 11. Steady-state OSC window.
  const elapsed = Date.now() - streamStart;
  if (elapsed < STREAM_DURATION_MS) await sleep(STREAM_DURATION_MS - elapsed);
  clearInterval(pump);
  const streamEnd = Date.now();

  assertOscTraffic(streamStart + SETTLE_MS, streamEnd);

  // 12. Disconnecting the phone must silence every OSC producer.
  phoneSocket.close();
  await sleep(2500);
  assertOscSilenceAfterDisconnect(Date.now() - 1500);

  assertNoRuntimeErrors();
}

async function main() {
  let exitCode = 0;
  try {
    await run();
  } catch (err) {
    failures.push(`Harness error: ${err.message}`);
    console.error(`\nHarness error: ${err.stack || err.message}`);
  } finally {
    for (const socket of [phoneSocket, obsSocket]) {
      try { if (socket) socket.close(); } catch (e) { /* closing anyway */ }
    }
    try { if (oscServer) oscServer.close(); } catch (e) { /* closing anyway */ }
    await killApp();
    if (userDataDir) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
  }

  console.log('');
  console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);

  if (failures.length > 0) {
    exitCode = 1;
    // App output first so the failure list stays visible under `tail`.
    console.log('\nLast 40 lines of app output:');
    appOutput.slice(-40).forEach((line) => console.log(`  ${line}`));
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('E2E FAILED');
  } else {
    console.log('E2E PASSED');
  }

  process.exit(exitCode);
}

// Never leave an Electron process holding port 9000.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killAppSync();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  console.error('Uncaught harness exception:', err);
  killAppSync();
  process.exit(1);
});

main();
