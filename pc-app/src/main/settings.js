'use strict';

/**
 * PulseNX — settings store.
 *
 * A single JSON document in userData. The renderer never touches disk: it reads
 * through `settings:get` and writes partial patches through `settings:set`,
 * which main merges, validates and persists before reacting to the change.
 *
 * The store takes its directory from the caller instead of importing electron,
 * so it can be exercised without an app instance.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  profile: { age: 25, gender: 'male', weightKg: 70, maxHr: 190 },
  osc: {
    enabled: true,
    host: '127.0.0.1',
    port: 9000,
    vrchatFullSet: true,
    customPath: '/avatar/parameters/HeartRate',
    preset: 'standard',
    minHr: 0,
    maxHr: 150,
    beatPulse: true,
    chatbox: false,
    chatboxFormat: '❤️ {bpm} BPM | 〰️ {hrv} HRV'
  },
  discord: {
    enabled: false,
    details: '❤️ {bpm} BPM • {zone}',
    state: 'Stress: {stresstext} ({stress}%)',
    clientId: ''
  },
  alarms: {
    highHrTone: true,
    bpmLimit: 130,
    durationSec: 3,
    audio: true,
    oscFlag: true
  },
  overlay: { showBpm: true, showStress: false },
  pacer: { sound: false },
  stressOffset: 0
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Merges `patch` onto `base` shaped by `defaults`: unknown keys are dropped and
 * every value is coerced to the type of its default, because HTML controls hand
 * back strings for numbers and the OSC engine must never be fed "9000" as a port.
 */
function mergeShaped(defaults, base, patch) {
  const out = Array.isArray(defaults) ? [] : {};

  for (const [key, def] of Object.entries(defaults)) {
    const current = base && Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined;
    const incoming = patch && Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : undefined;

    if (def !== null && typeof def === 'object') {
      out[key] = mergeShaped(def, current === undefined ? {} : current, incoming);
      continue;
    }

    const chosen = incoming !== undefined ? incoming : current;
    out[key] = coerce(def, chosen);
  }

  return out;
}

function coerce(def, value) {
  if (value === undefined || value === null) return def;

  if (typeof def === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }
  if (typeof def === 'boolean') {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return !!value;
  }
  if (typeof def === 'string') return String(value);
  return value;
}

class SettingsStore {
  constructor(dir, fileName = 'settings.json') {
    this.filePath = path.join(dir, fileName);
    this.data = clone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = mergeShaped(DEFAULTS, DEFAULTS, parsed);
    } catch (err) {
      // Missing or corrupt file: fall back to defaults rather than refusing to
      // start. A corrupt file is overwritten on the next save.
      if (err && err.code !== 'ENOENT') {
        console.warn('[settings] could not read store, using defaults:', err.message);
      }
      this.data = clone(DEFAULTS);
    }
    return this.data;
  }

  get() {
    return clone(this.data);
  }

  /** Merges a partial patch, persists, and returns the full merged object. */
  set(patch) {
    this.data = mergeShaped(DEFAULTS, this.data, patch || {});
    this.save();
    return this.get();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the store.
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[settings] could not persist store:', err.message);
    }
  }
}

module.exports = { SettingsStore, DEFAULTS, mergeShaped };
