'use strict';

/**
 * Unit tests for the NX Hub connector's send policy.
 *
 * The socket half is vendored upstream code (nx-connector.js) and is not
 * retested here; what is ours is the decision of WHEN to speak and WHAT to say,
 * which decideStatus/statusFor expose as pure functions. The service tests drive
 * HubConnector against a fake bus and an injected clock, so nothing here opens a
 * port or waits on a real hub.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HubConnector,
  decideStatus,
  statusFor,
  sameStatus,
  APP_ID,
  MIN_INTERVAL_MS
} = require('../src/main/connector');

const GAP = MIN_INTERVAL_MS;

/** A stand-in for the vendored client: records what was sent, fires events. */
function fakeBus() {
  const listeners = new Map();
  const bus = {
    sent: [],
    closed: false,
    live: false,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return () => {};
    },
    sendStatus(fields) {
      if (!bus.live) return false;
      bus.sent.push(fields);
      return true;
    },
    close() {
      bus.closed = true;
    },
    connected() {
      return bus.live;
    },
    // test-side helpers
    fire(event, arg) {
      for (const fn of listeners.get(event) || []) fn(arg);
    }
  };
  return bus;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------
test('a live stream reports the hub-declared fields', () => {
  assert.deepEqual(statusFor({ hr: 72, connected: true }), { hr: 72, connected: true });
});

test('heart rate is reported as a whole bpm', () => {
  assert.deepEqual(statusFor({ hr: 72.6, connected: true }), { hr: 73, connected: true });
});

test('a stopped stream omits hr entirely rather than sending a stale or zero one', () => {
  const status = statusFor({ hr: 72, connected: false });
  assert.deepEqual(status, { connected: false });
  assert.equal('hr' in status, false, 'the key must be absent, not undefined');
});

test('a missing or nonsense reading is not a measurement of zero', () => {
  for (const hr of [null, undefined, 0, -5, NaN, '', 'abc']) {
    const status = statusFor({ hr, connected: true });
    assert.deepEqual(status, { connected: true }, `hr=${String(hr)}`);
  }
});

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------
test('the first status always goes out', () => {
  const d = decideStatus({ lastSent: null, lastSentAt: null }, { hr: 70, connected: true }, 1000);
  assert.equal(d.shouldSend, true);
  assert.deepEqual(d.payload, { hr: 70, connected: true });
  assert.equal(d.waitMs, 0);
});

test('restating what the hub already holds sends nothing and schedules nothing', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: 70, connected: true }, 1000 + GAP * 5);
  assert.equal(d.shouldSend, false);
  assert.equal(d.waitMs, 0, 'an unchanged value must not arm the flush timer');
});

test('a changed heart rate goes out once the rate window has passed', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: 71, connected: true }, 1000 + GAP);
  assert.equal(d.shouldSend, true);
  assert.deepEqual(d.payload, { hr: 71, connected: true });
});

test('the rate window is inclusive at its boundary', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 0 };
  assert.equal(decideStatus(sent, { hr: 71, connected: true }, GAP - 1).shouldSend, false);
  assert.equal(decideStatus(sent, { hr: 71, connected: true }, GAP).shouldSend, true);
});

test('a change inside the window is deferred, not dropped', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: 71, connected: true }, 1400);
  assert.equal(d.shouldSend, false);
  assert.equal(d.waitMs, 600, 'the caller is told exactly how long to wait');
  assert.deepEqual(d.payload, { hr: 71, connected: true }, 'the pending value survives the refusal');
});

test('losing the stream is a change even when the heart rate would not be', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: 70, connected: false }, 1000 + GAP);
  assert.equal(d.shouldSend, true);
  assert.deepEqual(d.payload, { connected: false });
});

test('a connectivity flip inside the window is deferred rather than lost', () => {
  // The one that matters: goOffline() fires once and no later sample will
  // re-trigger it, so dropping it would strand the hub card on "connected".
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: null, connected: false }, 1001);
  assert.equal(d.shouldSend, false);
  assert.equal(d.waitMs, GAP - 1);
  assert.deepEqual(d.payload, { connected: false });
});

test('two disconnected updates in a row are still one status', () => {
  const sent = { lastSent: { connected: false }, lastSentAt: 1000 };
  const d = decideStatus(sent, { hr: null, connected: false }, 1000 + GAP * 3);
  assert.equal(d.shouldSend, false);
  assert.equal(d.waitMs, 0);
});

test('the throttle interval is overridable for a caller that wants a tighter one', () => {
  const sent = { lastSent: { hr: 70, connected: true }, lastSentAt: 1000 };
  assert.equal(decideStatus(sent, { hr: 71, connected: true }, 1050, 100).shouldSend, false);
  assert.equal(decideStatus(sent, { hr: 71, connected: true }, 1150, 100).shouldSend, true);
});

test('sameStatus compares both declared fields', () => {
  assert.equal(sameStatus({ hr: 70, connected: true }, { hr: 70, connected: true }), true);
  assert.equal(sameStatus({ hr: 70, connected: true }, { hr: 71, connected: true }), false);
  assert.equal(sameStatus({ connected: false }, { connected: true }), false);
  assert.equal(sameStatus({ connected: true }, { hr: 70, connected: true }), false);
  assert.equal(sameStatus(null, { connected: false }), false, 'nothing sent yet is never a match');
});

// ---------------------------------------------------------------------------
// Service behaviour
// ---------------------------------------------------------------------------
test('the app announces itself under its hub id and version', () => {
  let seen = null;
  const hub = new HubConnector({ connect: (opts) => { seen = opts; return fakeBus(); } });
  hub.start({ version: '1.2.2' });

  assert.equal(seen.app, APP_ID);
  assert.equal(seen.app, 'pulsenx');
  assert.equal(seen.version, '1.2.2');
  hub.stop();
});

test('the e2e harness never takes the real app slot on the bus', () => {
  let called = false;
  const hub = new HubConnector({ suppressed: true, connect: () => { called = true; return fakeBus(); } });

  assert.equal(hub.start({ version: '1.2.2' }), false);
  assert.equal(called, false);
  // Feeding it is harmless rather than fatal.
  hub.setVitals({ bpm: 70 });
  hub.setOffline();
  hub.stop();
});

test('a connector that cannot be constructed does not take the app down', () => {
  const hub = new HubConnector({ connect: () => { throw new Error('no'); } });
  assert.equal(hub.start({ version: '1.2.2' }), false);
  hub.setVitals({ bpm: 70 });
  hub.stop();
});

test('nothing is sent while no hub is listening', () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus });
  hub.start({});

  hub.setVitals({ bpm: 70 });
  hub.setOffline();
  assert.deepEqual(bus.sent, [], 'a machine without NX Hub sees no traffic and no errors');
  hub.stop();
});

test('joining the bus states the current status immediately', () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus });
  hub.start({});

  bus.live = true;
  bus.fire('connected', { hub: '0.5.0' });
  assert.deepEqual(bus.sent, [{ connected: false }], 'an idle app still reports itself idle');
  hub.stop();
});

test('a live session pushes hr, then withdraws it when the stream stops', () => {
  const bus = fakeBus();
  let clock = 10000;
  const hub = new HubConnector({ connect: () => bus, now: () => clock });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});

  clock += GAP;
  hub.setVitals({ bpm: 72 });
  clock += GAP;
  hub.setVitals({ bpm: 75 });
  clock += GAP;
  hub.setOffline();

  assert.deepEqual(bus.sent, [
    { connected: false },
    { hr: 72, connected: true },
    { hr: 75, connected: true },
    { connected: false }
  ]);
  hub.stop();
});

test('a burst of samples is thinned to the rate limit', () => {
  const bus = fakeBus();
  let clock = 10000;
  const hub = new HubConnector({ connect: () => bus, now: () => clock });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});
  bus.sent.length = 0;

  // Ten samples across a single second, as the phone actually delivers them.
  for (let i = 0; i < 10; i++) {
    clock += 100;
    hub.setVitals({ bpm: 70 + i });
  }

  assert.equal(bus.sent.length, 1, 'at most one status per second reaches the bus');
  assert.deepEqual(bus.sent[0], { hr: 79, connected: true },
    'the survivor is the newest reading — thinning must never rewind the gauge');
  hub.stop();
});

test('an unchanged heart rate spends none of the rate budget', () => {
  const bus = fakeBus();
  let clock = 10000;
  const hub = new HubConnector({ connect: () => bus, now: () => clock });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});
  bus.sent.length = 0;

  for (let i = 0; i < 20; i++) {
    clock += GAP * 2;
    hub.setVitals({ bpm: 70 });
  }

  assert.equal(bus.sent.length, 1, 'a resting heart rate is one status, not twenty');
  hub.stop();
});

test('reconnecting restates the full status onto the hubs empty slot', () => {
  const bus = fakeBus();
  let clock = 10000;
  const hub = new HubConnector({ connect: () => bus, now: () => clock });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});
  clock += GAP;
  hub.setVitals({ bpm: 88 });
  bus.sent.length = 0;

  bus.live = false;
  bus.fire('disconnected');
  bus.live = true;
  bus.fire('connected', {});

  assert.deepEqual(bus.sent, [{ hr: 88, connected: true }], 'merge semantics have nothing to merge onto');
  hub.stop();
});

test('a shutdown request is handed to the app rather than acted on here', () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus });
  hub.start({});

  let asked = 0;
  hub.on('shutdown-request', () => { asked++; });
  bus.fire('shutdown-request');
  assert.equal(asked, 1);
  hub.stop();
});

test('stop() says goodbye once and stays stopped', () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus });
  hub.start({});
  bus.live = true;
  bus.fire('connected', {});
  bus.sent.length = 0;

  hub.stop();
  assert.equal(bus.closed, true);

  hub.stop(); // idempotent
  hub.setVitals({ bpm: 70 });
  assert.deepEqual(bus.sent, [], 'a stopped connector is silent');
});

test('a throttled update is flushed by the trailing timer, not dropped', async () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus, minIntervalMs: 25 });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});
  assert.deepEqual(bus.sent, [{ connected: false }]);

  // Immediately after the first send, so it lands inside the rate window.
  hub.setVitals({ bpm: 91 });
  assert.equal(bus.sent.length, 1, 'held back for now');

  await sleep(60);
  assert.deepEqual(bus.sent[1], { hr: 91, connected: true }, 'the latest value still arrives');
  hub.stop();
});

test('the flush timer carries the newest value, not the one that armed it', async () => {
  const bus = fakeBus();
  const hub = new HubConnector({ connect: () => bus, minIntervalMs: 25 });
  hub.start({});

  bus.live = true;
  bus.fire('connected', {});

  hub.setVitals({ bpm: 91 }); // deferred, arms the timer
  hub.setVitals({ bpm: 92 });
  hub.setVitals({ bpm: 93 }); // still deferred, same timer

  await sleep(60);
  assert.deepEqual(bus.sent[1], { hr: 93, connected: true });
  assert.equal(bus.sent.length, 2, 'one flush, not three');
  hub.stop();
});
