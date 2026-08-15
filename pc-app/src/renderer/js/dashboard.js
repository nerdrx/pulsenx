/* PulseNX — dashboard: live vitals readouts, heart beat, ECG canvas,
   zone distribution and the session recorder. */

import { $, setText, setWidth, toggleClass, clamp, isNum, num, hhmmss, pick, zoneKeyOf, zoneLabel, ZONE_KEYS } from './util.js';
import { api } from './ipc.js';
import { store } from './store.js';
import { pushPoint, setSeries, initLiveChart } from './charts.js';

const ZONE_CLASSES = ZONE_KEYS.map((k) => `zone-${k}`);
const ZONE_PCT_ALIASES = {
  warmup: ['warmup', 'warmUp', 'warm', 'WarmUp'],
  fatburn: ['fatburn', 'fatBurn', 'burn', 'FatBurn'],
  aerobic: ['aerobic', 'Aerobic'],
  anaerobic: ['anaerobic', 'anAerobic', 'Anaerobic'],
  extreme: ['extreme', 'Extreme', 'vo2', 'max']
};
const PCT_LABEL_IDS = {
  warmup: 'lbl-pct-warm',
  fatburn: 'lbl-pct-burn',
  aerobic: 'lbl-pct-aero',
  anaerobic: 'lbl-pct-anar',
  extreme: 'lbl-pct-extreme'
};

let timerHandle = 0;
let recordStartedAt = 0;
let lastElapsedFromMain = null;
let lastBpm = 0;

/* ------------------------------------------------------------------ boot */

export function initDashboard() {
  initLiveChart();
  initEcg();
  wireChartTabs();
  wireRecorder();
  applyLink('offline');
}

function wireChartTabs() {
  const group = $('chart-tabs');
  if (!group) return;
  group.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg');
    if (btn && btn.dataset.series) setSeries(btn.dataset.series);
  });
}

/* --------------------------------------------------------------- vitals */

export function applyVitals(v) {
  if (!v) return;

  const connected = store.link === 'connected';
  const bpm = isNum(v.bpm) ? v.bpm : Number(v.bpm);
  const hasBpm = connected && Number.isFinite(bpm) && bpm > 0;
  store.live = hasBpm;
  lastBpm = hasBpm ? bpm : 0;

  setText('bpm-val', hasBpm ? Math.round(bpm) : '--');
  setHeart(hasBpm, bpm);

  setText('rr-val', isNum(v.rrMs) && v.rrMs > 0 ? `${Math.round(v.rrMs)} ms` : '--');
  setText('contact-val', v.contact === undefined || v.contact === null ? '--' : (v.contact ? 'Yes' : 'No'));

  // HRV — '--' until a real rMSSD exists (never faked)
  const hrv = isNum(v.hrv) ? v.hrv : null;
  setText('hrv-val', hrv === null ? '--' : Math.round(hrv));
  setWidth('hrv-bar', hrv === null ? 0 : clamp((hrv / 120) * 100, 0, 100));

  // Stress
  const stress = isNum(v.stress) ? v.stress : null;
  setText('stress-val', stress === null ? '--' : Math.round(stress));
  setText('stress-desc', v.stressText || '--');
  setWidth('stress-bar', stress === null ? 0 : stress);

  // Zone
  const zk = zoneKeyOf(v.zoneKey || v.zone);
  const badge = $('zone-badge');
  if (badge) {
    badge.classList.remove(...ZONE_CLASSES);
    badge.classList.add(`zone-${zk || 'warmup'}`);
    setText(badge, (v.zone || zoneLabel(zk)).toUpperCase());
  }
  setText('zone-inline', v.zone || zoneLabel(zk));

  // Stats
  const stats = v.stats || {};
  setText('stat-min-bpm', isNum(stats.min) ? Math.round(stats.min) : '--');
  setText('stat-avg-bpm', isNum(stats.avg) ? Math.round(stats.avg) : '--');
  setText('stat-max-bpm', isNum(stats.max) ? Math.round(stats.max) : '--');
  setText('kcal-val', isNum(stats.kcal) ? num(stats.kcal, 1) : '0.0');

  const ss = v.stressStats || {};
  setText('stat-min-stress', isNum(ss.min) ? Math.round(ss.min) : '--');
  setText('stat-avg-stress', isNum(ss.avg) ? Math.round(ss.avg) : '--');
  setText('stat-max-stress', isNum(ss.max) ? Math.round(ss.max) : '--');

  applyZoneDistribution(v.zonePct);

  // Recording state mirrored from main (authoritative)
  if (typeof v.recording === 'boolean') setRecordingUi(v.recording);
  if (isNum(v.elapsedRecSec)) {
    lastElapsedFromMain = v.elapsedRecSec;
    setText('session-timer', hhmmss(v.elapsedRecSec));
  }

  if (v.chartPoint) pushPoint(v.chartPoint);
}

function applyZoneDistribution(zonePct) {
  ZONE_KEYS.forEach((key) => {
    const raw = pick(zonePct, ZONE_PCT_ALIASES[key], 0);
    const pct = clamp(Number(raw) || 0, 0, 100);
    setWidth(`zone-bar-${key}`, pct);
    setText(PCT_LABEL_IDS[key], `${Math.round(pct)}%`);
  });
}

function setHeart(live, bpm) {
  const heart = $('svg-heart');
  if (!heart) return;
  if (live) {
    const duration = clamp(60 / bpm, 0.3, 2.4);
    document.documentElement.style.setProperty('--beat-duration', `${duration.toFixed(3)}s`);
    heart.classList.remove('is-idle');
  } else {
    heart.classList.add('is-idle');
  }
}

/* ----------------------------------------------------------------- link */

export function applyLink(state) {
  store.link = state;
  const connected = state === 'connected';
  if (!connected) {
    store.live = false;
    lastBpm = 0;
    setText('bpm-val', '--');
    setHeart(false, 0);
  }
  const startBtn = $('btn-record-start');
  if (startBtn) startBtn.disabled = !connected || store.recording;
  const hint = $('recorder-hint');
  if (hint) {
    setText(hint, connected
      ? 'Recording captures every sample. Export writes a CSV you can reload in History.'
      : 'Recording unlocks once a phone is linked. Export writes a CSV you can reload in History.');
  }
}

/* ------------------------------------------------------------- recorder */

function wireRecorder() {
  const start = $('btn-record-start');
  const stop = $('btn-record-stop');
  const exportBtn = $('btn-export-csv');

  if (start) {
    start.addEventListener('click', async () => {
      start.disabled = true;
      const res = await api.sessionStart();
      if (res === null || res.ok !== false) {
        recordStartedAt = Date.now();
        lastElapsedFromMain = null;
        setRecordingUi(true);
      } else {
        start.disabled = false;
      }
    });
  }

  if (stop) {
    stop.addEventListener('click', async () => {
      const res = await api.sessionStop();
      if (res === null || res.ok !== false) {
        setRecordingUi(false);
        store.hasStoppedSession = true;
        if (exportBtn) exportBtn.disabled = false;
      }
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      const res = await api.exportCsv();
      exportBtn.disabled = false;
      const hint = $('recorder-hint');
      if (!hint) return;
      if (res && res.ok && res.path) setText(hint, `Saved to ${res.path}`);
      else if (res && res.canceled) setText(hint, 'Export canceled.');
      else if (res && res.ok === false) setText(hint, 'Export failed — nothing was written.');
    });
  }
}

function setRecordingUi(recording) {
  if (store.recording === recording) return;
  store.recording = recording;

  toggleClass('rec-indicator', 'active', recording);
  const start = $('btn-record-start');
  const stop = $('btn-record-stop');
  if (start) {
    start.classList.toggle('hidden', recording);
    start.disabled = recording || store.link !== 'connected';
  }
  if (stop) stop.classList.toggle('hidden', !recording);

  if (recording) {
    if (!recordStartedAt) recordStartedAt = Date.now();
    startTimer();
  } else {
    stopTimer();
    recordStartedAt = 0;
    store.hasStoppedSession = true;
    const exportBtn = $('btn-export-csv');
    if (exportBtn) exportBtn.disabled = false;
  }
}

function startTimer() {
  stopTimer();
  const tick = () => {
    const elapsed = lastElapsedFromMain !== null
      ? lastElapsedFromMain
      : (Date.now() - recordStartedAt) / 1000;
    setText('session-timer', hhmmss(elapsed));
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = 0;
}

/* ------------------------------------------------------------ ECG canvas */

function initEcg() {
  const canvas = $('ecg-canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;
  let x = 0;
  let phase = 0;
  let prevY = 0;
  let last = 0;
  let rafId = 0;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth || 600;
    height = canvas.clientHeight || 74;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    x = 0;
    prevY = height / 2;
  };
  resize();
  window.addEventListener('resize', resize);

  const bell = (p, center, w) => Math.exp(-((p - center) ** 2) / (2 * w * w));

  // Idealised PQRST complex over one normalised beat cycle.
  const wave = (p) => (
    0.13 * bell(p, 0.13, 0.022) -
    0.14 * bell(p, 0.285, 0.008) +
    1.00 * bell(p, 0.315, 0.010) -
    0.30 * bell(p, 0.352, 0.012) +
    0.26 * bell(p, 0.560, 0.045)
  );

  const frame = (ts) => {
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;

    const live = store.live && lastBpm > 0;
    const speed = 130;                                   // px per second
    const beatsPerSec = live ? clamp(lastBpm / 60, 0.4, 3.4) : 0.55;
    const step = speed * dt;

    // wipe the region just ahead of the trace head (classic monitor sweep)
    ctx.clearRect(x, 0, step + 24, height);

    ctx.strokeStyle = live ? '#00e5ff' : 'rgba(154,143,192,0.5)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = live ? 'rgba(0,229,255,0.85)' : 'transparent';
    ctx.shadowBlur = live ? 8 : 0;

    const amplitude = height * 0.36;
    const mid = height * 0.58;
    phase = (phase + beatsPerSec * dt) % 1;
    const y = live
      ? mid - wave(phase) * amplitude
      : mid - Math.sin(ts / 420) * 1.4;

    const nextX = x + step;
    ctx.beginPath();
    if (nextX >= width) {
      ctx.moveTo(x, prevY);
      ctx.lineTo(width, y);
      ctx.stroke();
      x = 0;
      prevY = y;
    } else {
      ctx.moveTo(x, prevY);
      ctx.lineTo(nextX, y);
      ctx.stroke();
      x = nextX;
      prevY = y;
    }

    if (live) {
      ctx.fillStyle = '#eafcff';
      ctx.beginPath();
      ctx.arc(x, prevY, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    rafId = requestAnimationFrame(frame);
  };

  // The one custom canvas in the app, so it gets the §3 budget treatment: the
  // rAF loop is parked whenever the document is hidden, and reduced motion
  // freezes it outright to a single static baseline.
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  const drawStatic = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(154,143,192,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.58);
    ctx.lineTo(width, height * 0.58);
    ctx.stroke();
  };

  const stopLoop = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };
  const startLoop = () => {
    if (rafId || document.hidden) return;
    last = 0;
    rafId = requestAnimationFrame(frame);
  };

  if (reduced && reduced.matches) {
    drawStatic();
    window.addEventListener('resize', drawStatic);
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else startLoop();
  });
  startLoop();
}
