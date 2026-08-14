'use strict';

/**
 * PulseNX — preload bridge.
 *
 * The renderer is sandboxed (contextIsolation: true, nodeIntegration: false,
 * sandbox: true) and reaches the main process only through `window.pulsenx`.
 * Both the channel list and the event list are closed sets: anything not named
 * here cannot be invoked or subscribed to.
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'settings:get',
  'settings:set',
  'session:start',
  'session:stop',
  'session:exportCsv',
  'history:parseCsv',
  'overlay:toggle',
  'app:info'
];

// Main -> renderer events. 'vitals-update' is the overlay window's feed.
const EVENT_CHANNELS = [
  'vitals',
  'link',
  'overlay',
  'alarm',
  'breath',
  'discord',
  'vitals-update'
];

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

const api = {
  // --- renderer -> main -------------------------------------------------
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  startSession: () => invoke('session:start'),
  stopSession: () => invoke('session:stop'),
  exportCsv: () => invoke('session:exportCsv'),
  parseHistoryCsv: (text) => invoke('history:parseCsv', text),
  toggleOverlay: (show) => invoke('overlay:toggle', !!show),
  getAppInfo: () => invoke('app:info'),

  /** Escape hatch for the same closed channel list, if a caller prefers it. */
  invoke,

  // --- main -> renderer -------------------------------------------------
  /**
   * Subscribes to one allowed event channel.
   * @returns {() => void} unsubscribe
   */
  on(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') {
      return () => {};
    }
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  channels: Object.freeze({
    invoke: Object.freeze([...INVOKE_CHANNELS]),
    events: Object.freeze([...EVENT_CHANNELS])
  }),

  // True only when the app was started by the automated test harness.
  isE2E: process.argv.includes('--e2e-hooks')
};

contextBridge.exposeInMainWorld('pulsenx', api);
