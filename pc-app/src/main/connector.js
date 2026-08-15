'use strict';

/**
 * PulseNX — NX Hub connector.
 *
 * Announces PulseNX on the NX Hub bus (ws://127.0.0.1:9021) and streams the two
 * status fields the hub's app overlay declares for us:
 *
 *   { hr: <int bpm>, connected: <bool> }
 *
 * `connected` is "is the watch/bridge delivering data right now", NOT "are we
 * talking to the hub" — the hub already knows the latter from the socket. When
 * the stream stops we send `{connected:false}` and OMIT `hr`: the hub merges
 * status per key (PROTOCOL.md §4), so the last reading stays on the card as a
 * greyed-out last-known value instead of flashing to zero.
 *
 * The socket work is entirely upstream's: nx-connector.js is a vendored drop-in
 * that retries forever, silently, and no-ops when no hub is installed. This file
 * adds only the PulseNX-shaped part — when to say something, and what.
 *
 * Rate discipline: the bus allows 4 status/s and drops the excess *silently*, so
 * a naive "send every sample" would quietly lose the newest reading. We send at
 * most 1/s and only when something actually changed, with a trailing flush so a
 * throttled update is delayed rather than dropped. That matters most for the
 * one-shot `connected:false`, which has no later sample to re-trigger it.
 *
 * The decision is a pure function (decideStatus) so the throttle and the
 * change-detection are unit-testable without a socket or a clock.
 */

const { EventEmitter } = require('events');

const nx = require('./nx-connector');

const APP_ID = 'pulsenx';
// One status per second: comfortably inside the bus's 4/s cap, with enough head
// room that a terminal `connected:false` can never be the message that trips it.
// Verified against the real hub — at 8/s the hub silently swallowed exactly that
// update and left the card reading "connected" forever.
const MIN_INTERVAL_MS = 1000;

function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds the wire status for a desired state.
 *
 * PURE. `hr` is only ever present alongside `connected:true`, and only when
 * there is a real reading to report — a zero or absent bpm is "no reading", not
 * a measurement of zero.
 *
 * @param {{hr: ?number, connected: boolean}} update
 * @returns {{hr?: number, connected: boolean}}
 */
function statusFor(update) {
  const connected = !!(update && update.connected);
  if (!connected) return { connected: false };

  const hr = Math.round(num(update.hr, NaN));
  if (!Number.isFinite(hr) || hr <= 0) return { connected: true };
  return { hr, connected: true };
}

/** True when two status objects say the same thing. */
function sameStatus(a, b) {
  if (!a || !b) return false;
  return a.connected === b.connected && a.hr === b.hr;
}

/**
 * Decides whether the current status is worth putting on the wire.
 *
 * PURE — no clock, no socket. Three outcomes:
 *   - nothing changed        -> {shouldSend:false, waitMs:0}
 *   - changed, too soon      -> {shouldSend:false, waitMs:>0}  (flush later)
 *   - changed, window open   -> {shouldSend:true,  waitMs:0}
 *
 * `payload` is always the status we would like the hub to hold, so a caller that
 * defers can send exactly this object when the window opens.
 *
 * @param {{lastSent: ?object, lastSentAt: ?number}} sent  what the hub already has
 * @param {{hr: ?number, connected: boolean}} update       what we want it to have
 * @param {number} now                                     epoch ms
 * @param {number} [minIntervalMs]
 * @returns {{shouldSend: boolean, payload: object, waitMs: number}}
 */
function decideStatus(sent, update, now, minIntervalMs) {
  const gap = num(minIntervalMs, MIN_INTERVAL_MS);
  const payload = statusFor(update);
  const lastSent = sent ? sent.lastSent : null;
  const lastSentAt = sent ? sent.lastSentAt : null;

  // Status is a gauge, not a log: restating a value the hub already holds buys
  // nothing and spends part of the rate budget.
  if (sameStatus(lastSent, payload)) return { shouldSend: false, payload, waitMs: 0 };

  const since = lastSentAt === null || lastSentAt === undefined ? Infinity : now - lastSentAt;
  if (since < gap) return { shouldSend: false, payload, waitMs: gap - since };

  return { shouldSend: true, payload, waitMs: 0 };
}

/**
 * Lives for the whole app session. Fed by main.js from the two places that know
 * whether vitals are flowing: the ingest path and goOffline().
 *
 * Emits 'shutdown-request' when the hub asks PulseNX to exit (stack teardown);
 * main.js turns that into app.quit(). Never throws, and never logs unless the
 * hub connection itself changes state.
 */
class HubConnector extends EventEmitter {
  constructor(options = {}) {
    super();
    // The e2e harness must not steal the real PulseNX slot on the user's hub —
    // "newest hello wins", so a test run would evict the app they are using.
    this.suppressed = !!options.suppressed;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.minIntervalMs = num(options.minIntervalMs, MIN_INTERVAL_MS);
    // Injectable so tests can drive the service without a real socket.
    this.connectFn = typeof options.connect === 'function' ? options.connect : nx.connect;

    this.bus = null;
    this.pending = { hr: null, connected: false };
    this.lastSent = null;
    this.lastSentAt = null;
    this.flushTimer = null;
  }

  start(options = {}) {
    if (this.bus || this.suppressed) return false;

    try {
      this.bus = this.connectFn({ app: APP_ID, version: options.version });
    } catch (err) {
      // A missing or broken connector must never cost PulseNX its startup.
      this.bus = null;
      return false;
    }
    if (!this.bus) return false;

    this.bus.on('connected', (info) => {
      console.log(`[connector] on the NX Hub bus (hub ${(info && info.hub) || '?'})`);
      // A fresh slot starts empty and merge semantics have nothing to merge
      // onto, so forget what we believed the hub knew and restate it in full.
      this.lastSent = null;
      this.lastSentAt = null;
      this.push();
    });

    this.bus.on('disconnected', () => {
      console.log('[connector] NX Hub went away, retrying in the background');
      this.lastSent = null;
      this.lastSentAt = null;
      this.cancelFlush();
    });

    this.bus.on('shutdown-request', () => this.emit('shutdown-request'));

    // Protocol errors are the hub's business, not the user's. The client keeps
    // the connection or drops it on its own; we stay quiet either way.
    this.bus.on('error', () => {});

    return true;
  }

  /** One processed vitals sample landed: the stream is live at this bpm. */
  setVitals(processed) {
    this.pending = { hr: processed ? processed.bpm : null, connected: true };
    this.push();
  }

  /** The phone signed off, or the stream went stale. */
  setOffline() {
    this.pending = { hr: null, connected: false };
    this.push();
  }

  /** Sends the pending status if it is both new and due; otherwise defers it. */
  push() {
    if (!this.bus || !this.bus.connected()) return false;

    const now = this.now();
    const decision = decideStatus(
      { lastSent: this.lastSent, lastSentAt: this.lastSentAt },
      this.pending,
      now,
      this.minIntervalMs
    );

    if (!decision.shouldSend) {
      if (decision.waitMs > 0) this.scheduleFlush(decision.waitMs);
      return false;
    }

    this.cancelFlush();
    // False means the socket went away between the guard and here; leaving
    // lastSent untouched makes the next attempt restate it.
    if (!this.bus.sendStatus(decision.payload)) return false;

    this.lastSent = decision.payload;
    this.lastSentAt = now;
    return true;
  }

  scheduleFlush(waitMs) {
    if (this.flushTimer) return; // the pending value is read at fire time
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.push();
    }, Math.max(0, waitMs));
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  cancelFlush() {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  stop() {
    this.cancelFlush();
    if (!this.bus) return;
    const bus = this.bus;
    this.bus = null;
    try { bus.close(); } catch (err) { /* already gone */ }
  }
}

module.exports = { HubConnector, decideStatus, statusFor, sameStatus, APP_ID, MIN_INTERVAL_MS };
