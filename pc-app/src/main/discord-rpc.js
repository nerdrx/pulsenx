'use strict';

/**
 * PulseNX — Discord Rich Presence.
 *
 * Templates support {bpm} {hrv} {zone} {stress} {stresstext} and every
 * occurrence is replaced (the old build used String.replace with a plain string
 * needle, so only the first one ever changed).
 */

const { EventEmitter } = require('events');
const fs = require('fs');

const CLIENT_ID = '1528026708052283452';
const UPDATE_MIN_INTERVAL_MS = 4000; // Discord rate-limits presence updates

/** Replaces every placeholder occurrence. */
function applyTemplate(template, values) {
  let out = String(template == null ? '' : template);
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/**
 * Flatpak and Snap Discord place their IPC socket outside the default runtime
 * directory; point XDG_RUNTIME_DIR at whichever one actually exists.
 */
function fixLinuxIpcPath() {
  if (process.platform !== 'linux') return null;

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const candidates = [
    `/run/user/${uid}`,
    `/run/user/${uid}/app/com.discordapp.Discord`,
    `/run/user/${uid}/snap.discord`,
    '/tmp'
  ];

  for (const dir of candidates) {
    for (let i = 0; i < 10; i++) {
      try {
        if (fs.existsSync(`${dir}/discord-ipc-${i}`)) {
          process.env.XDG_RUNTIME_DIR = dir;
          console.log(`[discord] IPC socket located in ${dir}`);
          return dir;
        }
      } catch (err) {
        // Unreadable path; try the next candidate.
      }
    }
  }

  return null;
}

class DiscordLink extends EventEmitter {
  constructor(options = {}) {
    super();
    // The e2e harness must never hijack the developer's real presence.
    this.suppressed = !!options.suppressed;
    this.clientId = options.clientId || CLIENT_ID;
    this.client = null;
    this.ready = false;
    this.templates = { details: '', state: '' };
    this.lastUpdateAt = 0;
    this.pendingActivity = null;
    this.flushTimer = null;
  }

  setTemplates(templates) {
    this.templates = {
      details: (templates && templates.details) || '',
      state: (templates && templates.state) || ''
    };

    // Optional user-supplied application ID (Settings → Discord). Changing it
    // while connected forces a fresh login under the new application.
    const nextId = String((templates && templates.clientId) || CLIENT_ID).trim() || CLIENT_ID;
    if (nextId !== this.clientId) {
      const wasActive = !!this.client;
      this.clientId = nextId;
      if (wasActive) {
        this.destroyClient();
        this.enable();
      }
    }
  }

  enable() {
    if (this.suppressed) {
      this.emit('status', { state: 'off', message: 'Suppressed in test mode' });
      return;
    }
    if (this.client) return;

    let DiscordRPC;
    try {
      DiscordRPC = require('discord-rpc');
    } catch (err) {
      this.emit('status', { state: 'error', message: 'discord-rpc module unavailable' });
      return;
    }

    fixLinuxIpcPath();
    this.emit('status', { state: 'connecting' });

    try {
      this.client = new DiscordRPC.Client({ transport: 'ipc' });
    } catch (err) {
      this.client = null;
      this.emit('status', { state: 'error', message: err.message || String(err) });
      return;
    }

    this.client.on('ready', () => {
      this.ready = true;
      const user = (this.client.user && this.client.user.username) || 'Discord';
      console.log(`[discord] connected as ${user}`);
      this.emit('status', { state: 'connected', user });
      // Without an activity Discord displays nothing at all, so an idle
      // presence goes up immediately; live vitals replace it when they flow.
      if (this.pendingActivity) this.flush();
      else this.setIdle();
    });

    // discord-rpc emits 'disconnected' when the client goes away mid-session.
    this.client.on('disconnected', () => {
      this.ready = false;
      this.emit('status', { state: 'error', message: 'Discord disconnected' });
    });

    this.client.login({ clientId: this.clientId }).catch((err) => {
      this.ready = false;
      const text = String(err && err.message ? err.message : err);
      let message = 'Discord not running';
      if (/Invalid Client ?ID|4000/i.test(text)) message = 'Invalid Discord application ID';
      console.warn('[discord] login failed:', text);
      this.emit('status', { state: 'error', message });
      this.destroyClient();
    });
  }

  disable() {
    this.destroyClient();
    this.emit('status', { state: 'off' });
  }

  destroyClient() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingActivity = null;
    this.ready = false;
    if (!this.client) return;
    try { this.client.destroy(); } catch (err) { /* already gone */ }
    this.client = null;
  }

  /** Queues the no-vitals presence (shown while no watch is streaming). */
  setIdle() {
    if (!this.client || this.suppressed) return;
    this.pendingActivity = {
      details: 'PulseNX',
      state: 'Awaiting heart-rate link',
      largeImageKey: 'heart',
      largeImageText: 'PulseNX — made with Claude',
      instance: false
    };
    this.scheduleFlush();
  }

  /** Queues a presence update built from the current templates. */
  update(vitals) {
    if (!this.client || this.suppressed) return;

    const values = {
      bpm: vitals && Number.isFinite(vitals.bpm) ? vitals.bpm : '--',
      hrv: vitals && Number.isFinite(vitals.hrv) ? vitals.hrv : '--',
      zone: (vitals && vitals.zone) || '--',
      stress: vitals && Number.isFinite(vitals.stress) ? vitals.stress : '--',
      stresstext: (vitals && vitals.stressText) || '--'
    };

    this.pendingActivity = {
      details: applyTemplate(this.templates.details, values) || 'PulseNX',
      state: applyTemplate(this.templates.state, values) || ' ',
      largeImageKey: 'heart',
      largeImageText: `BPM: ${values.bpm} | HRV: ${values.hrv} ms`,
      instance: false
    };

    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer || !this.ready) return;
    const wait = Math.max(0, UPDATE_MIN_INTERVAL_MS - (Date.now() - this.lastUpdateAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  flush() {
    if (!this.client || !this.ready || !this.pendingActivity) return;
    const activity = this.pendingActivity;
    this.pendingActivity = null;
    this.lastUpdateAt = Date.now();

    try {
      const result = this.client.setActivity(activity);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.warn('[discord] setActivity failed:', err.message || err));
      }
    } catch (err) {
      console.warn('[discord] setActivity threw:', err.message || err);
    }
  }

  stop() {
    this.destroyClient();
  }
}

module.exports = { DiscordLink, applyTemplate, fixLinuxIpcPath, CLIENT_ID };
