/* PulseNX — coherent breathing pacer. The 5 s in / 5 s out rhythm is driven by
   'breath' events from main, never by a local timer. */

import { $, setText, setWidth, isNum, clamp } from './util.js';
import { setting } from './store.js';
import { chime } from './audio.js';

let lastPhase = '';

export function initBreathing() {
  setPhase('exhale', { silent: true });
  applyCoherence(null);
}

/** 'breath' event → {phase:'inhale'|'exhale'} */
export function applyBreath(payload) {
  const phase = payload && payload.phase === 'inhale' ? 'inhale' : 'exhale';
  setPhase(phase);
}

function setPhase(phase, { silent = false } = {}) {
  const circle = $('breathing-circle');
  if (circle) {
    circle.classList.toggle('inhale', phase === 'inhale');
    circle.classList.toggle('exhale', phase !== 'inhale');
  }
  setText('lbl-breathing-pacer', phase === 'inhale' ? 'INHALE (5s)' : 'EXHALE (5s)');

  if (!silent && phase !== lastPhase && setting('pacer.sound', false)) {
    chime(phase === 'inhale');
  }
  lastPhase = phase;
}

/** Coherence flow score 0–100 (from the 'vitals' payload). */
export function applyCoherence(value) {
  const circle = $('breathing-circle');
  const halo = $('pacer-halo');

  if (!isNum(value)) {
    setText('lbl-flow-coherence', '--%');
    setWidth('coherence-bar', 0);
    if (circle) circle.classList.remove('flow-mid', 'flow-high');
    if (halo) halo.style.opacity = '0.28';
    return;
  }

  const score = clamp(Math.round(value), 0, 100);
  setText('lbl-flow-coherence', `${score}%`);
  setWidth('coherence-bar', score);

  if (circle) {
    circle.classList.toggle('flow-high', score >= 70);
    circle.classList.toggle('flow-mid', score >= 40 && score < 70);
  }
  if (halo) halo.style.opacity = String(0.25 + (score / 100) * 0.55);
}
