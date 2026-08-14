/* PulseNX — overlay widget renderer. Listens for 'vitals-update' on window.pulsenx. */

import { on } from './ipc.js';
import { $, setText, clamp, isNum } from './util.js';

const heart = $('overlay-heart');
const bpmGroup = $('overlay-bpm-group');
const stressGroup = $('overlay-stress-group');

function apply(data) {
  if (!data) return;

  const bpm = isNum(data.bpm) ? data.bpm : Number(data.bpm);
  const live = Number.isFinite(bpm) && bpm > 0;

  setText('overlay-bpm', live ? Math.round(bpm) : '--');
  if (live) {
    const duration = clamp(60 / bpm, 0.3, 2.4);
    document.documentElement.style.setProperty('--beat-duration', `${duration.toFixed(3)}s`);
  }
  if (heart) heart.classList.toggle('is-idle', !live);

  const stress = isNum(data.stress) ? data.stress : Number(data.stress);
  setText('overlay-stress', Number.isFinite(stress) ? `${Math.round(stress)}%` : '--');

  if (bpmGroup) bpmGroup.classList.toggle('hidden', data.showBpm === false);
  if (stressGroup) stressGroup.classList.toggle('hidden', data.showStress === false);
}

on('vitals-update', apply);
