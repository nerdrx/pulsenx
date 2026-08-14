/* PulseNX — alarm reactions: WebAudio beeper + visual flash driven by 'alarm' events. */

import { $, setText, toggleClass } from './util.js';
import { setting } from './store.js';
import { testAlarm, startBeeper, stopBeeper } from './audio.js';

const active = { highHr: false, threshold: false };

export function initAlarms() {
  const testBtn = $('btn-test-audio');
  if (testBtn) testBtn.addEventListener('click', () => testAlarm());
  render();
}

/** 'alarm' event → {type:'highHr'|'threshold', active:boolean} */
export function applyAlarm(payload) {
  if (!payload || !payload.type) return;
  if (!(payload.type in active)) return;
  active[payload.type] = !!payload.active;
  render();
}

function audioAllowed() {
  if (active.threshold && setting('alarms.audio', true)) return true;
  if (active.highHr && setting('alarms.highHrTone', true)) return true;
  return false;
}

function render() {
  const anyActive = active.highHr || active.threshold;

  toggleClass('alarm-flash', 'active', anyActive);

  const label = !anyActive
    ? 'Idle'
    : [active.highHr ? 'High HR tone' : null, active.threshold ? 'Threshold exceeded' : null]
        .filter(Boolean).join(' · ');
  const el = $('alarm-state');
  if (el) {
    setText(el, label);
    el.classList.toggle('err', anyActive);
  }

  if (anyActive && audioAllowed()) startBeeper(audioAllowed);
  else stopBeeper();
}
