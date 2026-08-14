/* PulseNX — the ONLY bridge to the backend: window.pulsenx (preload contextBridge).
   No node, no require, no process anywhere in the renderer. If the bridge is
   missing (page opened outside Electron) every call resolves to null and every
   subscription is a no-op, so the UI still renders instead of throwing. */

const bridge = (typeof window !== 'undefined' && window.pulsenx) ? window.pulsenx : null;

export const hasBridge = !!bridge;

/** Prefers the preload's named method, falls back to its generic invoke(). */
async function call(channel, method, arg) {
  if (!bridge) return null;
  try {
    if (typeof bridge[method] === 'function') return await bridge[method](arg);
    if (typeof bridge.invoke === 'function') return await bridge.invoke(channel, arg);
    console.warn(`[PulseNX] no bridge handler for "${channel}"`);
  } catch (err) {
    console.warn(`[PulseNX] ipc "${channel}" failed:`, err);
  }
  return null;
}

/** Subscribe to a main→renderer channel. Tolerates both cb(payload) and cb(event, payload). */
export function on(channel, handler) {
  if (!bridge || typeof bridge.on !== 'function') return () => {};
  const wrapped = (...args) => {
    const payload = args.length > 1 ? args[args.length - 1] : args[0];
    try { handler(payload); } catch (err) { console.error(`[PulseNX] "${channel}" handler:`, err); }
  };
  try {
    const off = bridge.on(channel, wrapped);
    return typeof off === 'function' ? off : () => {};
  } catch (err) {
    console.warn(`[PulseNX] cannot subscribe to "${channel}":`, err);
    return () => {};
  }
}

export const api = {
  getSettings:   ()       => call('settings:get',      'getSettings'),
  setSettings:   (patch)  => call('settings:set',      'setSettings', patch),
  sessionStart:  ()       => call('session:start',     'startSession'),
  sessionStop:   ()       => call('session:stop',      'stopSession'),
  exportCsv:     ()       => call('session:exportCsv', 'exportCsv'),
  parseCsv:      (text)   => call('history:parseCsv',  'parseHistoryCsv', text),
  toggleOverlay: (active) => call('overlay:toggle',    'toggleOverlay', active),
  appInfo:       ()       => call('app:info',          'getAppInfo')
};
