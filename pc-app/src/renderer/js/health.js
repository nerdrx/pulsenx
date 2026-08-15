/* PulseNX — Daily Health card: the phone's Health Connect daily summary
   (steps, distance, energy, sleep, resting HR, today's BPM range, SpO2).
   Every field is nullable by contract, so each one falls back to a placeholder
   on its own — a missing SpO2 sample never blanks the step count. */

import { setText, isNum, num } from './util.js';

const PLACEHOLDER = '--';
const NO_STAMP = `updated ${PLACEHOLDER}:${PLACEHOLDER}`;

/* summary field -> element id */
const FIELD_IDS = {
  steps: 'health-steps',
  distanceKm: 'health-distance',
  activeKcal: 'health-active-kcal',
  totalKcal: 'health-total-kcal',
  restingBpm: 'health-resting-bpm',
  minBpm: 'health-min-bpm',
  avgBpm: 'health-avg-bpm',
  maxBpm: 'health-max-bpm',
  spo2Pct: 'health-spo2'
};

/* Rendered with one decimal; everything else is a whole unit. */
const DECIMAL_FIELDS = new Set(['distanceKm', 'activeKcal', 'totalKcal', 'spo2Pct']);

/* ------------------------------------------------------------------ boot */

export function initHealth() {
  // The card starts in its placeholder state and stays there until the phone
  // pushes a summary (link-up, then every 5 minutes).
  applyHealth(null);
}

/* ---------------------------------------------------------------- render */

export function applyHealth(summary) {
  const s = summary && typeof summary === 'object' ? summary : null;

  Object.keys(FIELD_IDS).forEach((key) => {
    const value = s ? s[key] : null;
    setText(FIELD_IDS[key], isNum(value)
      ? (DECIMAL_FIELDS.has(key) ? num(value, 1) : String(Math.round(value)))
      : PLACEHOLDER);
  });

  setText('health-sleep', s ? sleepLabel(s.sleepMin) : PLACEHOLDER);
  setText('health-source', s && s.source === 'huawei' ? 'via Huawei Health' : 'via Health Connect');
  setText('health-updated', s && isNum(s.ts) ? `updated ${hhmm(s.ts)}` : NO_STAMP);
}

/** Minutes → "7 h 12 m". The card never shows a bare minute count. */
function sleepLabel(minutes) {
  if (!isNum(minutes) || minutes < 0) return PLACEHOLDER;
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} m`;
}

/** Epoch ms → local "HH:MM". */
function hhmm(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return `${PLACEHOLDER}:${PLACEHOLDER}`;
  return [d.getHours(), d.getMinutes()].map((v) => String(v).padStart(2, '0')).join(':');
}
