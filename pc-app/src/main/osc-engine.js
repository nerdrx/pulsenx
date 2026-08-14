'use strict';

/**
 * PulseNX — VRChat OSC engine.
 *
 * Ownership rules (do not add a second sender for any of these):
 *   - sendAvatarParams() is the ONLY producer of the avatar parameter set, and
 *     it is driven exclusively by the 1 Hz broadcaster loop. Sending per
 *     incoming packet would flood VRChat at the notification rate.
 *   - beatTick() is the ONLY producer of the beat-pulse bools.
 *   - setWarning() is the ONLY producer of HeartRateWarning.
 *
 * Nothing is transmitted unless a live sample exists: isHRConnected must never
 * claim a watch is attached when the stream is stale.
 */

const OSC_ERROR_LOG_INTERVAL_MS = 5000;
const BEAT_HOLD_MS = 120;
const BEAT_MIN_MS = 250;
const BEAT_MAX_MS = 2000;
const CHATBOX_INTERVAL_MS = 3000;
const BROADCAST_INTERVAL_MS = 1000;

const PRESET_PATHS = {
  standard: '/avatar/parameters/HeartRate',
  vrcosc: '/avatar/parameters/VRCOSC/Heartrate'
};

class OscEngine {
  constructor(options = {}) {
    this.osc = null;
    try {
      this.osc = require('node-osc');
    } catch (err) {
      console.warn('[osc] node-osc unavailable, OSC disabled:', err.message);
    }

    this.config = {
      enabled: false,
      host: '127.0.0.1',
      port: 9000,
      vrchatFullSet: true,
      customPath: PRESET_PATHS.standard,
      preset: 'standard',
      minHr: 0,
      maxHr: 150,
      beatPulse: true,
      chatbox: false,
      chatboxFormat: '❤️ {bpm} BPM | 〰️ {hrv} HRV'
    };

    this.client = null;
    this.clientHost = null;
    this.clientPort = null;

    this.live = false;
    this.vitals = { bpm: null, hrv: null, stress: 0, stressText: 'Relaxed' };

    this.broadcastTimer = null;
    this.chatboxTimer = null;
    this.beatTimer = null;
    this.beatHoldTimer = null;
    this.warningActive = false;

    this.errorLastLoggedAt = 0;
    this.errorSuppressed = 0;

    this.onSend = typeof options.onSend === 'function' ? options.onSend : null;
  }

  // -----------------------------------------------------------------------
  // Transport plumbing
  // -----------------------------------------------------------------------
  /**
   * Rate-limits error reporting: a dead socket would otherwise log once per
   * message, twenty times a second.
   */
  reportError(context, err) {
    const now = Date.now();
    if (now - this.errorLastLoggedAt < OSC_ERROR_LOG_INTERVAL_MS) {
      this.errorSuppressed++;
      return;
    }
    const suppressed = this.errorSuppressed;
    this.errorLastLoggedAt = now;
    this.errorSuppressed = 0;

    const detail = (err && err.message) ? err.message : err;
    const tail = suppressed > 0 ? ` (${suppressed} further OSC error(s) suppressed)` : '';
    console.warn(`[osc] error [${context}]: ${detail}${tail}`);
  }

  ensureClient() {
    if (!this.osc) return null;

    const host = this.config.host || '127.0.0.1';
    const port = Number(this.config.port) || 9000;

    if (this.client && this.clientHost === host && this.clientPort === port) {
      return this.client;
    }

    this.closeClient();

    try {
      this.client = new this.osc.Client(host, port);
      this.clientHost = host;
      this.clientPort = port;
      if (typeof this.client.on === 'function') {
        // node-osc re-emits socket errors on the client; an unhandled 'error'
        // event on an EventEmitter would terminate the process.
        this.client.on('error', (err) => this.reportError('socket', err));
      }
      console.log(`OSC client targeting ${host}:${port}`);
    } catch (err) {
      this.client = null;
      this.clientHost = null;
      this.clientPort = null;
      this.reportError('client-init', err);
    }

    return this.client;
  }

  closeClient() {
    if (!this.client) return;
    try {
      // Always pass a callback: without one node-osc hands back a promise that
      // rejects outside any try/catch.
      this.client.close(() => {});
    } catch (err) {
      // Socket already torn down.
    }
    this.client = null;
    this.clientHost = null;
    this.clientPort = null;
  }

  send(address, ...args) {
    if (this.onSend) this.onSend(address, args);
    if (!this.client) return;
    try {
      this.client.send(address, ...args, (err) => {
        if (err) this.reportError(address, err);
      });
    } catch (err) {
      this.reportError(address, err);
    }
  }

  // -----------------------------------------------------------------------
  // Configuration & data
  // -----------------------------------------------------------------------
  configure(oscSettings) {
    const previous = this.config;
    this.config = { ...this.config, ...(oscSettings || {}) };
    this.config.port = Number(this.config.port) || 9000;
    this.config.minHr = Number(this.config.minHr) || 0;
    this.config.maxHr = Number(this.config.maxHr) || 150;

    if (previous.host !== this.config.host || previous.port !== this.config.port) {
      // Retarget immediately rather than waiting for the next tick.
      this.closeClient();
      if (this.config.enabled) this.ensureClient();
    }

    if (this.config.enabled) {
      this.startBroadcaster();
    } else {
      this.stopBroadcaster();
      this.stopBeat();
      this.stopChatbox();
      this.closeClient();
      return;
    }

    if (this.config.chatbox) this.startChatbox();
    else this.stopChatbox();

    if (!this.config.beatPulse) this.stopBeat();
    else this.kickBeat();
  }

  setLive(live) {
    const was = this.live;
    this.live = !!live;
    if (was && !this.live) {
      // Stream went stale: stop the beat and drop the warning flag so the
      // avatar does not freeze mid-pulse.
      this.stopBeat();
      if (this.warningActive) this.setWarning(false);
    }
    if (!was && this.live) this.kickBeat();
  }

  update(payload) {
    if (!payload) return;
    this.vitals = {
      bpm: Number.isFinite(payload.bpm) ? payload.bpm : this.vitals.bpm,
      hrv: Number.isFinite(payload.hrv) ? payload.hrv : null,
      stress: Number.isFinite(payload.stress) ? payload.stress : 0,
      stressText: payload.stressText || this.vitals.stressText
    };
    this.kickBeat();
  }

  // -----------------------------------------------------------------------
  // 1 Hz avatar parameter broadcaster
  // -----------------------------------------------------------------------
  startBroadcaster() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setInterval(() => this.sendAvatarParams(), BROADCAST_INTERVAL_MS);
    if (this.broadcastTimer.unref) this.broadcastTimer.unref();
  }

  stopBroadcaster() {
    if (!this.broadcastTimer) return;
    clearInterval(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  sendAvatarParams() {
    if (!this.config.enabled || !this.live) return;
    const bpm = this.vitals.bpm;
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    if (!this.ensureClient()) return;

    if (!this.config.vrchatFullSet) {
      // Custom single-parameter mode.
      const path = this.config.customPath || PRESET_PATHS.standard;
      this.send(path, bpm);
      return;
    }

    const minHr = this.config.minHr;
    const maxHr = this.config.maxHr;
    const range = (maxHr - minHr) || 1;
    const clamped = Math.max(minHr, Math.min(bpm, maxHr));
    const normalized = (clamped - minHr) / range;
    const fullPercent = (2 * normalized) - 1;

    const hrv = Number.isFinite(this.vitals.hrv) ? this.vitals.hrv : 50;
    const stress = Number.isFinite(this.vitals.stress) ? this.vitals.stress : 0;

    this.send('/avatar/parameters/HRPercent', { type: 'f', value: normalized });
    this.send('/avatar/parameters/FullHRPercent', { type: 'f', value: fullPercent });
    this.send('/avatar/parameters/HR', { type: 'i', value: bpm });
    this.send('/avatar/parameters/onesHR', { type: 'i', value: bpm % 10 });
    this.send('/avatar/parameters/tensHR', { type: 'i', value: Math.floor(bpm / 10) % 10 });
    this.send('/avatar/parameters/hundredsHR', { type: 'i', value: Math.floor(bpm / 100) });
    this.send('/avatar/parameters/isHRConnected', true);
    this.send('/avatar/parameters/isHRActive', true);
    // isHRBeat is deliberately absent here: the beat pulse owns it, and pinning
    // it true would race the pulse back to a constant.

    this.send('/avatar/parameters/Heartrate', { type: 'i', value: bpm });
    this.send('/avatar/parameters/Heartrate2', { type: 'f', value: bpm / 255 });
    this.send('/avatar/parameters/Heartrate3', { type: 'i', value: bpm });
    this.send('/avatar/parameters/HeartRate', { type: 'i', value: bpm });
    this.send('/avatar/parameters/HeartRateFloat', { type: 'f', value: normalized });
    this.send('/avatar/parameters/HeartRateInt', { type: 'i', value: bpm });
    this.send('/avatar/parameters/HRV', { type: 'f', value: Math.max(0, Math.min(1, hrv / 100)) });
    this.send('/avatar/parameters/Stress', { type: 'f', value: Math.max(0, Math.min(1, stress / 100)) });
    this.send('/avatar/parameters/StressInt', { type: 'i', value: Math.round(stress) });
    this.send('/avatar/parameters/HeartrateBeat', { type: 'f', value: normalized });
    this.send('/avatar/parameters/HeartRateBPM', { type: 'i', value: bpm });
    this.send('/avatar/parameters/VRCOSC/Heartrate', { type: 'i', value: bpm });
  }

  // -----------------------------------------------------------------------
  // Beat pulse
  // -----------------------------------------------------------------------
  beatEnabled() {
    return !!(this.config.enabled && this.config.beatPulse && this.live
      && Number.isFinite(this.vitals.bpm) && this.vitals.bpm > 0);
  }

  /** Starts the pulse chain if it should be running and is not already. */
  kickBeat() {
    if (!this.beatEnabled()) {
      this.stopBeat();
      return;
    }
    if (this.beatTimer) return;
    this.beatTick();
  }

  beatTick() {
    if (!this.beatEnabled()) {
      this.beatTimer = null;
      return;
    }

    if (this.ensureClient()) {
      this.send('/avatar/parameters/HeartBeatPulse', true);
      this.send('/avatar/parameters/HeartBeat', true);
      this.send('/avatar/parameters/isHRBeat', true);
      this.send('/avatar/parameters/HBListen', true);
    }

    this.beatHoldTimer = setTimeout(() => {
      this.beatHoldTimer = null;
      if (this.client && this.beatEnabled()) {
        this.send('/avatar/parameters/HeartBeatPulse', false);
        this.send('/avatar/parameters/HeartBeat', false);
        this.send('/avatar/parameters/isHRBeat', false);
        this.send('/avatar/parameters/HBListen', false);
      }
    }, BEAT_HOLD_MS);
    if (this.beatHoldTimer.unref) this.beatHoldTimer.unref();

    const interval = Math.max(BEAT_MIN_MS, Math.min(BEAT_MAX_MS, Math.round(60000 / this.vitals.bpm)));
    this.beatTimer = setTimeout(() => {
      this.beatTimer = null;
      this.beatTick();
    }, interval);
    if (this.beatTimer.unref) this.beatTimer.unref();
  }

  stopBeat() {
    if (this.beatTimer) {
      clearTimeout(this.beatTimer);
      this.beatTimer = null;
    }
    if (this.beatHoldTimer) {
      clearTimeout(this.beatHoldTimer);
      this.beatHoldTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Chatbox
  // -----------------------------------------------------------------------
  startChatbox() {
    if (this.chatboxTimer) return;
    this.chatboxTimer = setInterval(() => this.sendChatbox(), CHATBOX_INTERVAL_MS);
    if (this.chatboxTimer.unref) this.chatboxTimer.unref();
  }

  stopChatbox() {
    if (!this.chatboxTimer) return;
    clearInterval(this.chatboxTimer);
    this.chatboxTimer = null;
  }

  sendChatbox() {
    if (!this.config.enabled || !this.config.chatbox || !this.live) return;
    if (!Number.isFinite(this.vitals.bpm)) return;
    if (!this.ensureClient()) return;

    const template = this.config.chatboxFormat || '❤️ {bpm} BPM | 〰️ {hrv} HRV';
    const message = template
      .replace(/\{bpm\}/g, String(this.vitals.bpm))
      .replace(/\{hrv\}/g, Number.isFinite(this.vitals.hrv) ? String(this.vitals.hrv) : '--')
      .replace(/\{stress\}/g, String(this.vitals.stress))
      .replace(/\{stresstext\}/g, String(this.vitals.stressText));

    this.send('/chatbox/input', message, true);
  }

  // -----------------------------------------------------------------------
  // Threshold alarm flag
  // -----------------------------------------------------------------------
  setWarning(active) {
    this.warningActive = !!active;
    if (!this.config.enabled) return;
    if (!this.ensureClient()) return;
    this.send('/avatar/parameters/HeartRateWarning', this.warningActive);
  }

  stop() {
    this.stopBroadcaster();
    this.stopBeat();
    this.stopChatbox();
    this.closeClient();
  }
}

module.exports = { OscEngine, PRESET_PATHS };
