'use strict';

/**
 * PulseNX — vitals processing core.
 *
 * PURE LOGIC ONLY. This module must not require electron or touch any socket:
 * it is the unit-testable heart of the app (see test/state.test.js) and main.js
 * is the only place that wires transports into it.
 *
 * Everything time dependent takes an explicit timestamp (or uses the injectable
 * `now` clock) so tests can drive the pacer, the calorie integrator and the
 * threshold-alarm timer deterministically.
 */

const RR_WINDOW = 30;            // samples kept for the rMSSD calculation
const COHERENCE_WINDOW = 15;     // samples averaged into the flow score
const BREATH_HALF_CYCLE_MS = 5000; // 5 s inhale / 5 s exhale => 6 breaths/min
const LIVE_TIMEOUT_MS = 10000;   // no sample for this long => stream is not live
const KCAL_MAX_GAP_S = 10;       // ignore integration steps longer than this

// Canonical zone table. `key` is the identity used everywhere (tick buckets,
// IPC payloads, CSS classes); the display name is derived from it, never parsed
// back — the old build matched zones with string-includes and lost ticks.
const ZONES = [
  { key: 'warmup', name: 'Warm Up', minPct: 0 },
  { key: 'fatburn', name: 'Fat Burn', minPct: 60 },
  { key: 'aerobic', name: 'Aerobic', minPct: 70 },
  { key: 'anaerobic', name: 'Anaerobic', minPct: 80 },
  { key: 'extreme', name: 'Extreme', minPct: 90 }
];

const ZONE_KEYS = ZONES.map((z) => z.key);

const DEFAULT_PROFILE = { age: 25, gender: 'male', weightKg: 70, maxHr: 190 };

// Number(null) is 0 and Number('') is 0, which would silently turn "no reading"
// into a real measurement — an absent value must always take the fallback.
function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Training zone for a heart rate, as a share of the user's max HR. */
function zoneFor(bpm, maxHr) {
  const max = num(maxHr, DEFAULT_PROFILE.maxHr) > 0 ? num(maxHr, DEFAULT_PROFILE.maxHr) : DEFAULT_PROFILE.maxHr;
  const pct = (num(bpm, 0) / max) * 100;
  let zone = ZONES[0];
  for (const candidate of ZONES) {
    if (pct >= candidate.minPct) zone = candidate;
  }
  return { key: zone.key, name: zone.name, pct };
}

/**
 * rMSSD over the RR window, in ms.
 * Returns null when fewer than two RR intervals are known — the old build
 * synthesised a sine wave here, which made the HRV readout a lie.
 */
function rmssd(rrList) {
  if (!Array.isArray(rrList) || rrList.length < 2) return null;

  let squaredSum = 0;
  let pairs = 0;
  for (let i = 1; i < rrList.length; i++) {
    const diff = rrList[i] - rrList[i - 1];
    // Differences beyond half a second are artefacts (dropped beats), not HRV.
    if (Math.abs(diff) < 500) {
      squaredSum += diff * diff;
      pairs++;
    }
  }

  if (pairs === 0) return null;
  return Math.round(Math.sqrt(squaredSum / pairs));
}

/** Keytel et al. energy expenditure estimate, kcal per minute. */
function kcalPerMinute(bpm, profile) {
  const age = num(profile && profile.age, DEFAULT_PROFILE.age);
  const weight = num(profile && profile.weightKg, DEFAULT_PROFILE.weightKg);
  const gender = (profile && profile.gender) === 'female' ? 'female' : 'male';
  const hr = num(bpm, 0);

  let perMin = gender === 'female'
    ? ((age * 0.074) - (weight * 0.05741) + (hr * 0.4472) - 20.4022) / 4.184
    : ((age * 0.2017) - (weight * 0.09036) + (hr * 0.6309) - 55.0969) / 4.184;

  // At rest the regression goes negative; fall back to a basal-rate floor that
  // still tracks heart rate instead of clamping flat.
  if (perMin < 1.2) perMin = 1.2 + ((hr - 50) * 0.02);

  return Math.max(0, perMin);
}

/** Stress index 0..100 from HR elevation, HRV suppression and the user offset. */
function stressIndex(bpm, hrv, offset) {
  const hrComponent = Math.max(0, num(bpm, 0) - 60) * 0.9;
  // A null HRV means "not measured yet"; 50 ms is the neutral midpoint so the
  // component contributes neither calm nor strain until real data exists.
  const hrvComponent = Math.max(0, 100 - num(hrv, 50)) * 0.4;
  return Math.round(clamp(hrComponent + hrvComponent + num(offset, 0), 0, 100));
}

function stressText(stress) {
  if (stress > 70) return 'Stressed';
  if (stress > 50) return 'Tense';
  if (stress > 25) return 'Normal';
  return 'Relaxed';
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(num(totalSeconds, 0)));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function timeLabel(ms) {
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Session-scoped vitals state: statistics, HRV, calories, zone distribution,
 * breathing pacer, coherence, recorder buffer and the threshold-alarm timer.
 */
class VitalsState {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.liveTimeoutMs = num(options.liveTimeoutMs, LIVE_TIMEOUT_MS);

    this.profile = { ...DEFAULT_PROFILE };
    this.stressOffset = 0;
    this.alarm = { bpmLimit: 130, durationSec: 3 };

    this.recording = false;
    this.recordStartAt = null;
    this.sessionRows = [];

    this.resetStats(this.now());
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------
  setProfile(profile) {
    if (!profile) return;
    this.profile = {
      age: num(profile.age, this.profile.age),
      gender: profile.gender === 'female' ? 'female' : 'male',
      weightKg: num(profile.weightKg, this.profile.weightKg),
      maxHr: num(profile.maxHr, this.profile.maxHr) || DEFAULT_PROFILE.maxHr
    };
  }

  setStressOffset(offset) {
    this.stressOffset = num(offset, 0);
  }

  setAlarmConfig(config) {
    if (!config) return;
    this.alarm = {
      bpmLimit: num(config.bpmLimit, this.alarm.bpmLimit),
      durationSec: Math.max(0, num(config.durationSec, this.alarm.durationSec))
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------
  /**
   * Clears every accumulator. Calories are part of the statistics, so they
   * reset here and nowhere else — the old build kept the calorie clock running
   * across sessions and silently accrued between recordings.
   */
  resetStats(tsArg) {
    const ts = num(tsArg, this.now());

    this.lastSampleAt = null;
    this.lastBpm = null;
    this.lastRrMs = null;
    this.lastHrv = null;
    this.lastStress = 0;
    this.lastStressText = stressText(0);
    this.lastZone = { key: 'warmup', name: 'Warm Up' };
    this.lastContact = null;
    this.lastBattery = null;
    this.lastRssi = null;
    this.lastPayload = null;

    this.rrHistory = [];

    this.bpmMin = null;
    this.bpmMax = null;
    this.bpmSum = 0;
    this.bpmCount = 0;

    this.stressMin = null;
    this.stressMax = null;
    this.stressSum = 0;
    this.stressCount = 0;

    this.kcal = 0;
    this.lastKcalAt = null;

    this.zoneTicks = Object.fromEntries(ZONE_KEYS.map((k) => [k, 0]));
    this.zoneTickTotal = 0;

    this.breathStartAt = ts;
    this.breathPhase = 'inhale';
    this.breathCycleHrStart = null;
    this.coherenceScores = [];

    this.thresholdStartedAt = null;
    this.thresholdActive = false;
  }

  /** True while a sample has arrived recently enough to be trusted as live. */
  isLive(tsArg) {
    const ts = num(tsArg, this.now());
    return this.lastSampleAt !== null && (ts - this.lastSampleAt) <= this.liveTimeoutMs;
  }

  /** Phone said BYE / the socket dropped: nothing may claim to be live. */
  clearLive() {
    this.lastSampleAt = null;
    this.lastKcalAt = null;
    this.thresholdStartedAt = null;
    this.thresholdActive = false;
  }

  // -----------------------------------------------------------------------
  // Breathing pacer
  // -----------------------------------------------------------------------
  phaseAt(tsArg) {
    const ts = num(tsArg, this.now());
    const halfCycles = Math.floor((ts - this.breathStartAt) / BREATH_HALF_CYCLE_MS);
    return halfCycles % 2 === 0 ? 'inhale' : 'exhale';
  }

  /**
   * Advances the pacer clock. Returns `{phase, changed}`; on a change the
   * heart rate at the phase boundary becomes the coherence baseline.
   */
  tickBreath(tsArg) {
    const ts = num(tsArg, this.now());
    const phase = this.phaseAt(ts);
    const changed = phase !== this.breathPhase;
    if (changed) {
      this.breathPhase = phase;
      this.breathCycleHrStart = this.lastBpm;
    }
    return { phase, changed };
  }

  coherence() {
    if (this.coherenceScores.length === 0) return 0;
    const sum = this.coherenceScores.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.coherenceScores.length);
  }

  // -----------------------------------------------------------------------
  // Recorder
  // -----------------------------------------------------------------------
  startRecording(tsArg) {
    const ts = num(tsArg, this.now());
    this.recording = true;
    this.recordStartAt = ts;
    this.sessionRows = [];
    // A recording starts from a clean calorie budget, and the integrator
    // baseline is dropped so the pause before the first sample is not counted.
    this.kcal = 0;
    this.lastKcalAt = null;
    return { ok: true };
  }

  stopRecording() {
    this.recording = false;
    // recordStartAt is kept so a stopped session can still report its length.
    return { ok: true, rows: this.sessionRows.length };
  }

  elapsedRecSec(tsArg) {
    if (!this.recording || this.recordStartAt === null) return null;
    return Math.max(0, Math.round((num(tsArg, this.now()) - this.recordStartAt) / 1000));
  }

  // -----------------------------------------------------------------------
  // Threshold alarm
  // -----------------------------------------------------------------------
  /**
   * Sustained-overshoot alarm: the heart rate has to stay at or above the limit
   * for the whole duration filter before the alarm latches, and one sample below
   * the limit clears it.
   */
  checkThreshold(bpm, tsArg) {
    const ts = num(tsArg, this.now());
    const limit = this.alarm.bpmLimit;
    const durationMs = this.alarm.durationSec * 1000;
    const was = this.thresholdActive;

    if (num(bpm, 0) >= limit) {
      if (this.thresholdStartedAt === null) this.thresholdStartedAt = ts;
      this.thresholdActive = (ts - this.thresholdStartedAt) >= durationMs;
    } else {
      this.thresholdStartedAt = null;
      this.thresholdActive = false;
    }

    return { active: this.thresholdActive, changed: this.thresholdActive !== was };
  }

  // -----------------------------------------------------------------------
  // Ingest
  // -----------------------------------------------------------------------
  /**
   * Feeds one raw phone sample `{bpm, rr, contact, battery, rssi}` through the
   * whole pipeline and returns the processed payload broadcast over IPC.
   * Returns null for samples without a usable heart rate.
   */
  ingest(raw, tsArg) {
    const ts = num(tsArg, this.now());
    const bpm = Math.round(num(raw && raw.bpm, NaN));
    if (!Number.isFinite(bpm) || bpm <= 0) return null;

    // Advance the pacer before lastBpm moves, so a phase that flips on this
    // sample takes the previous heart rate as its baseline.
    this.tickBreath(ts);

    const rawRr = num(raw.rr, 0);
    const rrMs = rawRr > 0 ? Math.round(rawRr) : Math.round(60000 / bpm);

    this.lastSampleAt = ts;
    this.lastRrMs = rrMs;
    this.lastContact = typeof raw.contact === 'boolean' ? raw.contact : this.lastContact;
    this.lastBattery = Number.isFinite(num(raw.battery, NaN)) ? Math.round(num(raw.battery, 0)) : this.lastBattery;
    this.lastRssi = Number.isFinite(num(raw.rssi, NaN)) ? Math.round(num(raw.rssi, 0)) : this.lastRssi;

    // --- HRV -------------------------------------------------------------
    this.rrHistory.push(rrMs);
    if (this.rrHistory.length > RR_WINDOW) this.rrHistory.shift();
    const hrv = rmssd(this.rrHistory);
    this.lastHrv = hrv;

    // --- BPM statistics --------------------------------------------------
    this.bpmMin = this.bpmMin === null ? bpm : Math.min(this.bpmMin, bpm);
    this.bpmMax = this.bpmMax === null ? bpm : Math.max(this.bpmMax, bpm);
    this.bpmSum += bpm;
    this.bpmCount++;

    // --- Calories (integrated exactly once per sample) --------------------
    this.accumulateCalories(bpm, ts);

    // --- Stress ----------------------------------------------------------
    const stress = stressIndex(bpm, hrv, this.stressOffset);
    this.lastStress = stress;
    this.lastStressText = stressText(stress);
    this.stressMin = this.stressMin === null ? stress : Math.min(this.stressMin, stress);
    this.stressMax = this.stressMax === null ? stress : Math.max(this.stressMax, stress);
    this.stressSum += stress;
    this.stressCount++;

    // --- Zone + distribution ---------------------------------------------
    const zone = zoneFor(bpm, this.profile.maxHr);
    this.lastZone = zone;
    this.zoneTicks[zone.key]++;
    this.zoneTickTotal++;

    // --- Coherence --------------------------------------------------------
    if (this.breathCycleHrStart === null) this.breathCycleHrStart = bpm;
    const delta = bpm - this.breathCycleHrStart;
    const score = this.breathPhase === 'inhale' ? (delta >= 0 ? 100 : 0) : (delta <= 0 ? 100 : 0);
    this.coherenceScores.push(score);
    if (this.coherenceScores.length > COHERENCE_WINDOW) this.coherenceScores.shift();

    this.lastBpm = bpm;

    // --- Recorder ---------------------------------------------------------
    const elapsedRecSec = this.elapsedRecSec(ts);
    if (this.recording) {
      this.sessionRows.push({
        time: new Date(ts).toISOString(),
        elapsed: elapsedRecSec,
        bpm,
        rr: rrMs,
        zone: zone.name,
        stress
      });
    }

    const payload = {
      bpm,
      rrMs,
      hrv,
      stress,
      stressText: this.lastStressText,
      zone: zone.name,
      zoneKey: zone.key,
      contact: this.lastContact,
      battery: this.lastBattery,
      rssi: this.lastRssi,
      stats: {
        min: this.bpmMin,
        max: this.bpmMax,
        avg: this.bpmCount ? Math.round(this.bpmSum / this.bpmCount) : null,
        kcal: Math.round(this.kcal * 10) / 10
      },
      stressStats: {
        min: this.stressMin,
        max: this.stressMax,
        avg: this.stressCount ? Math.round(this.stressSum / this.stressCount) : null
      },
      zonePct: this.zonePct(),
      coherence: this.coherence(),
      breathPhase: this.breathPhase,
      elapsedRecSec,
      recording: this.recording,
      // `t` is a ready-to-plot HH:MM:SS label; `ts` is the raw epoch time.
      chartPoint: { t: timeLabel(ts), ts, bpm, stress }
    };

    this.lastPayload = payload;
    return payload;
  }

  /**
   * Integrates energy expenditure over the gap since the previous sample.
   * Called from exactly one place (ingest) — the old build called it twice per
   * sample while recording and doubled every recorded session's calories.
   */
  accumulateCalories(bpm, tsArg) {
    const ts = num(tsArg, this.now());
    if (this.lastKcalAt === null) {
      this.lastKcalAt = ts;
      return 0;
    }

    const elapsedSec = (ts - this.lastKcalAt) / 1000;
    this.lastKcalAt = ts;
    if (!(elapsedSec > 0) || elapsedSec > KCAL_MAX_GAP_S) return 0;

    const burned = (kcalPerMinute(bpm, this.profile) / 60) * elapsedSec;
    this.kcal += burned;
    return burned;
  }

  zonePct() {
    const out = {};
    for (const key of ZONE_KEYS) {
      out[key] = this.zoneTickTotal ? Math.round((this.zoneTicks[key] / this.zoneTickTotal) * 100) : 0;
    }
    return out;
  }

  /** Rows for the CSV exporter. */
  rows() {
    return this.sessionRows.slice();
  }
}

module.exports = {
  VitalsState,
  ZONES,
  ZONE_KEYS,
  RR_WINDOW,
  COHERENCE_WINDOW,
  BREATH_HALF_CYCLE_MS,
  LIVE_TIMEOUT_MS,
  DEFAULT_PROFILE,
  zoneFor,
  rmssd,
  kcalPerMinute,
  stressIndex,
  stressText,
  formatClock,
  timeLabel,
  clamp
};
