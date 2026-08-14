/* PulseNX — every control is bound to a settings path: initialised from
   settings:get and autosaved through settings:set with a partial object. */

import { $, setText, get, partial, debounce, toggleClass } from './util.js';
import { api } from './ipc.js';
import { mergeSettings, patchSettings } from './store.js';

export const DEFAULTS = {
  profile: { age: 25, gender: 'male', weightKg: 70, maxHr: 190 },
  osc: {
    enabled: true, host: '127.0.0.1', port: 9000, vrchatFullSet: true,
    customPath: '/avatar/parameters/HeartRate', preset: 'standard',
    minHr: 0, maxHr: 150, beatPulse: true, chatbox: false,
    chatboxFormat: '❤️ {bpm} BPM | 〰️ {hrv} HRV'
  },
  discord: { enabled: false, details: '❤️ {bpm} BPM • {zone}', state: 'Stress: {stresstext} ({stress}%)' },
  alarms: { highHrTone: true, bpmLimit: 130, durationSec: 3, audio: true, oscFlag: true },
  overlay: { showBpm: true, showStress: false },
  pacer: { sound: false },
  stressOffset: 0
};

const PRESET_PATHS = {
  standard: '/avatar/parameters/HeartRate',
  vrcosc: '/avatar/parameters/VRCOSC/Heartrate'
};

const BINDINGS = [
  { id: 'profile-age',        path: 'profile.age',        kind: 'number' },
  { id: 'profile-gender',     path: 'profile.gender',     kind: 'text' },
  { id: 'profile-weight',     path: 'profile.weightKg',   kind: 'number' },
  { id: 'profile-maxhr',      path: 'profile.maxHr',      kind: 'number' },
  { id: 'stress-offset',      path: 'stressOffset',       kind: 'number' },

  { id: 'osc-enabled',        path: 'osc.enabled',        kind: 'bool' },
  { id: 'osc-host',           path: 'osc.host',           kind: 'text' },
  { id: 'osc-port',           path: 'osc.port',           kind: 'number' },
  { id: 'osc-fullset',        path: 'osc.vrchatFullSet',  kind: 'bool' },
  { id: 'osc-preset',         path: 'osc.preset',         kind: 'text' },
  { id: 'osc-path',           path: 'osc.customPath',     kind: 'text' },
  { id: 'osc-min-hr',         path: 'osc.minHr',          kind: 'number' },
  { id: 'osc-max-hr',         path: 'osc.maxHr',          kind: 'number' },
  { id: 'osc-beatpulse',      path: 'osc.beatPulse',      kind: 'bool' },
  { id: 'osc-chatbox',        path: 'osc.chatbox',        kind: 'bool' },
  { id: 'osc-chatbox-format', path: 'osc.chatboxFormat',  kind: 'text' },

  { id: 'discord-enabled',    path: 'discord.enabled',    kind: 'bool' },
  { id: 'discord-details',    path: 'discord.details',    kind: 'text' },
  { id: 'discord-state',      path: 'discord.state',      kind: 'text' },

  { id: 'alarm-high-tone',    path: 'alarms.highHrTone',  kind: 'bool' },
  { id: 'alarm-bpm-limit',    path: 'alarms.bpmLimit',    kind: 'number' },
  { id: 'alarm-duration',     path: 'alarms.durationSec', kind: 'number' },
  { id: 'alarm-audio',        path: 'alarms.audio',       kind: 'bool' },
  { id: 'alarm-osc-flag',     path: 'alarms.oscFlag',     kind: 'bool' },

  { id: 'overlay-show-bpm',   path: 'overlay.showBpm',    kind: 'bool' },
  { id: 'overlay-show-stress',path: 'overlay.showStress', kind: 'bool' },

  { id: 'pacer-sound',        path: 'pacer.sound',        kind: 'bool' }
];

/** Load settings from main (or fall back to the spec defaults) and paint every control. */
export async function initSettingsUi() {
  const loaded = await api.getSettings();
  const settings = withDefaults(loaded);
  mergeSettings(settings);
  paint(settings);
  wire();
  return settings;
}

function withDefaults(loaded) {
  const merged = JSON.parse(JSON.stringify(DEFAULTS));
  if (loaded && typeof loaded === 'object') {
    Object.keys(loaded).forEach((key) => {
      const value = loaded[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        merged[key] = { ...(merged[key] || {}), ...value };
      } else if (value !== undefined) {
        merged[key] = value;
      }
    });
  }
  return merged;
}

function paint(settings) {
  BINDINGS.forEach(({ id, path, kind }) => {
    const el = $(id);
    if (!el) return;
    const value = get(settings, path, get(DEFAULTS, path, ''));
    if (kind === 'bool') el.checked = !!value;
    else el.value = value === null || value === undefined ? '' : String(value);
  });
  reflectDerived();
}

function wire() {
  BINDINGS.forEach(({ id, path, kind }) => {
    const el = $(id);
    if (!el) return;

    if (kind === 'bool' || el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        const value = kind === 'bool' ? el.checked : el.value;
        save(path, value);
        if (id === 'osc-preset') applyPreset(el.value);
        reflectDerived();
      });
      return;
    }

    const commit = debounce(() => {
      const value = kind === 'number' ? readNumber(el) : el.value;
      if (value === null) return;
      save(path, value);
    }, 200);

    el.addEventListener('input', () => {
      reflectDerived();
      commit();
    });
    el.addEventListener('change', () => {
      const value = kind === 'number' ? readNumber(el) : el.value;
      if (value !== null) save(path, value);
    });
  });

  const copyBtn = $('btn-copy-obs');
  const obsInput = $('obs-url');
  if (copyBtn && obsInput) {
    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(obsInput.value);
        } else {
          obsInput.select();
          document.execCommand('copy');
        }
        setText(copyBtn, 'Copied');
      } catch (err) {
        setText(copyBtn, 'Copy failed');
      }
      setTimeout(() => setText(copyBtn, 'Copy'), 1400);
    });
  }
}

function readNumber(el) {
  if (el.value === '') return null;
  const value = Number(el.value);
  return Number.isFinite(value) ? value : null;
}

function save(path, value) {
  patchSettings(path, value);
  api.setSettings(partial(path, value));
}

function applyPreset(preset) {
  const nextPath = PRESET_PATHS[preset];
  if (!nextPath) return;
  const input = $('osc-path');
  if (input) input.value = nextPath;
  save('osc.customPath', nextPath);
}

/** UI-only consequences of the current control values. */
function reflectDerived() {
  const offset = $('stress-offset');
  if (offset) {
    const value = Number(offset.value) || 0;
    setText('lbl-stress-offset', `${value > 0 ? '+' : ''}${value}`);
  }

  const fullSet = $('osc-fullset');
  const presetField = $('osc-preset');
  const pathField = $('osc-path');
  const muted = !!(fullSet && fullSet.checked);
  [presetField, pathField].forEach((el) => {
    if (el && el.parentElement) el.parentElement.classList.toggle('is-muted', muted);
  });

  const oscEnabled = $('osc-enabled');
  toggleClass('osc-body', 'is-muted', !!(oscEnabled && !oscEnabled.checked));
}

/** 'discord' event → {state, user?, message?} */
export function applyDiscord(payload) {
  const el = $('discord-status');
  if (!el) return;
  const state = (payload && payload.state) || 'off';
  const text = {
    off: 'Off',
    connecting: 'Connecting…',
    connected: payload && payload.user ? `Connected · ${payload.user}` : 'Connected',
    error: payload && payload.message ? `Error: ${payload.message}` : 'Error'
  }[state] || state;

  setText(el, text);
  el.classList.remove('ok', 'warn', 'err');
  if (state === 'connected') el.classList.add('ok');
  else if (state === 'connecting') el.classList.add('warn');
  else if (state === 'error') el.classList.add('err');
}
