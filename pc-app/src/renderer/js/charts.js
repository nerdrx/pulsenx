/* PulseNX — Chart.js wiring (local vendor copy, loaded by index.html).
   Real values only: no cosmetic jitter is ever added to plotted data. */

import { $, $$, clockLabel } from './util.js';

const WINDOW = 35;
/* Canvas cannot read CSS custom properties, so the NX tokens are mirrored here:
   --font / --mono, --line (grid), --muted (ticks), heart red for the BPM series
   (the vitals identity), cyan for live stress, violet for historical stress. */
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Cantarell, sans-serif';
const MONO = 'ui-monospace, JetBrains Mono, Fira Code, Consolas, monospace';
const HEART = '#ff2d55';
const CYAN = '#00e5ff';
const VIOLET = '#7700ff';

let live = null;
let history = null;

const chartLib = () => (typeof window !== 'undefined' ? window.Chart : undefined);

const gridStyle = { color: 'rgba(42,31,69,0.85)', drawTicks: false };      // --line
const tickStyle = { color: '#9a8fc0', font: { family: MONO, size: 10 } };  // --muted

/* Tier-2 in a tooltip: the fill carries the legibility, the lit edge finishes it. */
function tooltipStyle() {
  return {
    backgroundColor: 'rgba(19,12,34,0.96)',
    borderColor: 'rgba(154,60,255,0.45)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 6,  /* --radius: canvas cannot read the token, so it is mirrored */
    titleColor: '#efeaff',
    bodyColor: '#efeaff',
    titleFont: { family: FONT, size: 11, weight: '600' },
    bodyFont: { family: MONO, size: 11 },
    displayColors: true
  };
}

export function initLiveChart() {
  const Chart = chartLib();
  const canvas = $('live-chart');
  if (!Chart || !canvas || live) return live;

  const ctx = canvas.getContext('2d');
  const hrFill = ctx.createLinearGradient(0, 0, 0, 240);
  hrFill.addColorStop(0, 'rgba(255,45,85,0.34)');
  hrFill.addColorStop(1, 'rgba(255,45,85,0)');
  const stressFill = ctx.createLinearGradient(0, 0, 0, 240);
  stressFill.addColorStop(0, 'rgba(0,229,255,0.26)');
  stressFill.addColorStop(1, 'rgba(0,229,255,0)');

  live = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Heart Rate (BPM)',
          data: [],
          borderColor: HEART,
          backgroundColor: hrFill,
          borderWidth: 2.4,
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: HEART,
          pointHoverBorderColor: '#fff',
          yAxisID: 'y'
        },
        {
          label: 'Stress Index (%)',
          data: [],
          borderColor: CYAN,
          backgroundColor: stressFill,
          borderWidth: 2,
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: CYAN,
          pointHoverBorderColor: '#fff',
          hidden: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: {
        x: { grid: { display: false }, ticks: { ...tickStyle, maxTicksLimit: 7, maxRotation: 0 } },
        y: { position: 'left', grid: gridStyle, ticks: tickStyle, suggestedMin: 40, suggestedMax: 160 },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: tickStyle, display: false }
      }
    }
  });
  return live;
}

/** chartPoint {t, bpm, stress} straight off the 'vitals' event. */
export function pushPoint(point) {
  if (!live) initLiveChart();
  if (!live || !point) return;

  const label = clockLabel(point.t);
  const [hr, stress] = live.data.datasets;
  live.data.labels.push(label);
  hr.data.push(typeof point.bpm === 'number' ? point.bpm : null);
  stress.data.push(typeof point.stress === 'number' ? point.stress : null);

  while (live.data.labels.length > WINDOW) {
    live.data.labels.shift();
    hr.data.shift();
    stress.data.shift();
  }
  live.update('none');
}

export function setSeries(mode) {
  $$('#chart-tabs .seg').forEach((btn) => btn.classList.toggle('active', btn.dataset.series === mode));
  if (!live) return;
  const [hr, stress] = live.data.datasets;
  hr.hidden = mode === 'stress';
  stress.hidden = mode === 'bpm';
  live.options.scales.y.display = !hr.hidden;
  live.options.scales.y1.display = !stress.hidden;
  live.update();
}

export function clearLiveChart() {
  if (!live) return;
  live.data.labels = [];
  live.data.datasets.forEach((set) => { set.data = []; });
  live.update('none');
}

/** History view: HR on the left axis (red), stress on the right axis 0-100 (violet). */
export function renderHistoryChart(labels, hrData, stressData) {
  const Chart = chartLib();
  const canvas = $('history-chart');
  if (!Chart || !canvas) return;

  if (history) { history.destroy(); history = null; }
  const hasStress = Array.isArray(stressData) && stressData.some((v) => typeof v === 'number');

  history = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels || [],
      datasets: [
        {
          label: 'Heart Rate (BPM)',
          data: hrData || [],
          borderColor: HEART,
          backgroundColor: 'rgba(255,45,85,0.10)',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Stress Index (%)',
          data: hasStress ? stressData : [],
          borderColor: VIOLET,
          backgroundColor: 'rgba(119,0,255,0.14)',
          borderWidth: 1.8,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          fill: false,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: {
        x: { grid: { display: false }, ticks: { ...tickStyle, maxTicksLimit: 12, maxRotation: 0 } },
        y: { position: 'left', grid: gridStyle, ticks: tickStyle },
        y1: {
          position: 'right',
          min: 0,
          max: 100,
          display: hasStress,
          grid: { drawOnChartArea: false },
          // The history view's stress axis is violet, matching its series.
          ticks: { ...tickStyle, color: '#c9a6ff' }
        }
      }
    }
  });
}
