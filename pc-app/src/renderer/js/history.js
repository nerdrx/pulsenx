/* PulseNX — session history: read a CSV with FileReader, parse it in main
   (history:parseCsv), then render stats + the dual-axis chart. */

import { $, setText, isNum, num, hhmmss } from './util.js';
import { api } from './ipc.js';
import { renderHistoryChart } from './charts.js';

export function initHistory() {
  const pick = $('btn-pick-csv');
  const input = $('history-file');
  if (!pick || !input) return;

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    setText('history-filename', file.name);
    readFile(file);
    input.value = '';
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onerror = () => setText('history-filename', `${file.name} — could not be read`);
  reader.onload = async () => {
    const text = String(reader.result || '');
    const parsed = await api.parseCsv(text);
    if (!parsed || !parsed.labels) {
      setText('history-filename', `${file.name} — not a PulseNX session CSV`);
      return;
    }
    render(parsed);
  };
  reader.readAsText(file);
}

function render(parsed) {
  const stats = parsed.stats || {};
  const panel = $('history-stats');
  if (panel) panel.classList.remove('hidden');

  setText('hist-hr-min', isNum(stats.min) ? Math.round(stats.min) : '--');
  setText('hist-hr-avg', isNum(stats.avg) ? Math.round(stats.avg) : '--');
  setText('hist-hr-max', isNum(stats.max) ? Math.round(stats.max) : '--');
  setText('hist-stress-avg', isNum(stats.stressAvg) ? `${num(stats.stressAvg, 0)}%` : '--');
  setText('hist-duration', formatDuration(stats.duration));

  renderHistoryChart(parsed.labels, parsed.hr || [], parsed.stress || []);
}

/** duration may arrive as seconds or as a pre-formatted string. */
function formatDuration(duration) {
  if (isNum(duration)) return hhmmss(duration);
  if (typeof duration === 'string' && duration.trim()) return duration;
  return '--';
}
