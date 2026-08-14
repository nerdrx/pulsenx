/* PulseNX — shared renderer runtime state (settings snapshot + link/session flags). */

import { get } from './util.js';

const listeners = new Set();

export const store = {
  settings: {},
  link: 'offline',        // 'awaiting' | 'connected' | 'offline'
  live: false,            // link connected AND vitals flowing
  recording: false,
  hasStoppedSession: false,
  info: { version: '', linkCode: '', lanEndpoint: '', obsUrl: '' }
};

export function setting(path, fallback) {
  return get(store.settings, path, fallback);
}

export function mergeSettings(next) {
  if (next && typeof next === 'object') store.settings = next;
  emit();
}

export function patchSettings(path, value) {
  const keys = path.split('.');
  let cursor = store.settings;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) cursor[key] = value;
    else cursor = (cursor[key] = cursor[key] || {});
  });
  emit();
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try { fn(store.settings); } catch (err) { console.error('[PulseNX] settings listener:', err); }
  });
}
