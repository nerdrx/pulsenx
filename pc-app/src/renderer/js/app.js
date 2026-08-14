/* PulseNX — renderer boot: navigation, header state, IPC event fan-out.
   The renderer only ever talks to the backend through window.pulsenx. */

import { $, $$, setText, toggleClass } from './util.js';
import { api, on, hasBridge } from './ipc.js';
import { store } from './store.js';
import { initSettingsUi, applyDiscord } from './settings-ui.js';
import { initDashboard, applyVitals, applyLink } from './dashboard.js';
import { initBreathing, applyBreath, applyCoherence } from './breathing.js';
import { initAlarms, applyAlarm } from './alarms.js';
import { initHistory } from './history.js';
import { primeOnFirstGesture } from './audio.js';

let overlayActive = false;

/* --------------------------------------------------------------- routing */

function initNav() {
  const nav = $('side-nav');
  if (!nav) return;
  nav.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.nav-item');
    if (btn && btn.dataset.view) showView(btn.dataset.view);
  });
}

function showView(name) {
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  const main = $('app-main') || document.querySelector('.app-main');
  if (main) main.scrollTop = 0;
}

/* ---------------------------------------------------------------- header */

async function loadInfo() {
  const info = await api.appInfo();
  if (!info) {
    setText('status-text', hasBridge ? 'Starting…' : 'Backend offline');
    return;
  }
  store.info = { ...store.info, ...info };

  const code = info.linkCode || '------';
  setText('link-code', code);
  setText('info-link-code', code);
  setText('info-lan', info.lanEndpoint || '--');
  setText('info-obs', info.obsUrl || '--');
  setText('app-version', info.version ? `v${info.version}` : 'v--');
  setText('about-version', info.version ? `v${info.version}` : 'v--');

  const obsInput = $('obs-url');
  if (obsInput && info.obsUrl) obsInput.value = info.obsUrl;
}

function applyLinkState(payload) {
  const state = (payload && payload.state) || 'offline';
  const pill = $('status-pill');
  const chips = $('status-chips');

  if (pill) {
    pill.classList.remove('is-awaiting', 'is-connected', 'is-offline');
    pill.classList.add(`is-${state === 'connected' ? 'connected' : state === 'awaiting' ? 'awaiting' : 'offline'}`);
  }

  const source = payload && payload.source ? ` · ${String(payload.source).toUpperCase()}` : '';
  const label = state === 'connected'
    ? `Phone Linked${source}`
    : state === 'awaiting'
      ? 'Awaiting Link'
      : (payload && payload.detail) || 'Offline';
  setText('status-text', label);

  const phone = payload && payload.phone;
  const hasPhone = state === 'connected' && phone && (phone.battery !== undefined || phone.rssi !== undefined);
  if (chips) chips.hidden = !hasPhone;
  if (hasPhone) {
    setText('chip-battery', phone.battery === null || phone.battery === undefined ? '-- %' : `${Math.round(phone.battery)} %`);
    setText('chip-rssi', phone.rssi === null || phone.rssi === undefined ? '-- dBm' : `${Math.round(phone.rssi)} dBm`);
  }

  applyLink(state);
}

function initOverlayButton() {
  const btn = $('btn-overlay-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const res = await api.toggleOverlay(!overlayActive);
    if (res && typeof res.active === 'boolean') setOverlayState(res.active);
    else setOverlayState(!overlayActive);
  });
}

function setOverlayState(active) {
  overlayActive = !!active;
  toggleClass('btn-overlay-toggle', 'is-on', overlayActive);
  setText('overlay-btn-label', overlayActive ? 'Overlay On' : 'Overlay');
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  initNav();
  initOverlayButton();
  initDashboard();
  initBreathing();
  initAlarms();
  initHistory();
  primeOnFirstGesture();

  await initSettingsUi();
  await loadInfo();

  on('vitals', (payload) => {
    applyVitals(payload);
    if (payload) {
      applyCoherence(payload.coherence);
      if (payload.breathPhase) applyBreath({ phase: payload.breathPhase });
    }
  });
  on('link', applyLinkState);
  on('overlay', (payload) => setOverlayState(payload && payload.active));
  on('alarm', applyAlarm);
  on('breath', applyBreath);
  on('discord', applyDiscord);

  if (!hasBridge) {
    console.warn('[PulseNX] window.pulsenx is unavailable — running in inert UI mode.');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
