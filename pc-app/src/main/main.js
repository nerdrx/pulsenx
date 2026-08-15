'use strict';

/**
 * PulseNX — Electron main process.
 *
 * Every node/system concern lives here: the LAN hub, the cloud link, discovery,
 * OSC, OBS, Discord, settings and the vitals pipeline. The renderer is a
 * sandboxed view that talks to exactly one preload bridge (see
 * src/renderer/preload.js) — the previous build ran all of this inside the
 * renderer with nodeIntegration enabled.
 *
 * Data flow:
 *   phone --(ws :9000 | mqtt)--> main --> state.js --> IPC 'vitals' --> renderer
 *                                     \-> ws broadcast --> OBS widget
 *                                     \-> OSC engine   --> VRChat
 *                                     \-> Discord RPC
 *                                     \-> connector.js --> NX Hub bus (:9021)
 *
 *   phone {type:'health'} -------> main --> normalizeHealth --> IPC 'health'
 *   (Health Connect daily summary; shares the transports, not the pipeline)
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const { VitalsState, normalizeHealth } = require('./state');
const { SettingsStore } = require('./settings');
const { LanServer, DEFAULT_PORT: DEFAULT_LAN_PORT } = require('./ws-server');
const { DiscoveryBeacon, localIpAddress, BEACON_PORT: DEFAULT_BEACON_PORT } = require('./discovery');
const { MqttLink, generateLinkCode } = require('./mqtt-link');
const { OscEngine } = require('./osc-engine');
const { ObsServer, OBS_PORT: DEFAULT_OBS_PORT } = require('./obs-server');
const { DiscordLink } = require('./discord-rpc');
const { HubConnector } = require('./connector');
const csv = require('./csv');
const { startE2eHooks, E2E_HOOKS_PORT: DEFAULT_E2E_PORT } = require('./e2e-hooks');

const E2E_MODE = process.argv.includes('--e2e-hooks');

/**
 * Every listening port is overridable from the environment so an automated run
 * can stand the whole app up beside a production instance that already owns the
 * defaults. Unset (or nonsense) means the documented default, so a normal launch
 * behaves exactly as before. Read once, at startup.
 */
function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`[main] ignoring ${name}="${raw}" (not a valid port), using ${fallback}`);
    return fallback;
  }
  return port;
}

const LAN_PORT = envPort('PULSENX_PORT_WS', DEFAULT_LAN_PORT);
const BEACON_PORT = envPort('PULSENX_PORT_DISCOVERY', DEFAULT_BEACON_PORT);
const OBS_PORT = envPort('PULSENX_PORT_OBS', DEFAULT_OBS_PORT);
const E2E_PORT = envPort('PULSENX_PORT_E2E', DEFAULT_E2E_PORT);
// A test instance must never advertise itself to the user's real phone app.
const BEACON_ENABLED = process.env.PULSENX_NO_BEACON !== '1';

const HIGH_HR_TONE_BPM = 165;
const LIVE_WATCHDOG_MS = 1000;
const BREATH_TICK_MS = 250;

let mainWindow = null;
let overlayWindow = null;

let settings = null;
// Hot copy of the settings document. Vitals arrive several times a second and
// every one of them consults it; re-cloning the store per sample is waste.
let cfg = null;
let state = null;
let lanServer = null;
let beacon = null;
let mqttLink = null;
let oscEngine = null;
let obsServer = null;
let discord = null;
let hub = null;
let e2eServer = null;

// Last valid daily health summary, replayed whenever the dashboard (re)loads.
let lastHealth = null;

let liveWatchdog = null;
let breathTicker = null;
let wasLive = false;
let highHrActive = false;
let linkCode = generateLinkCode();

// ==========================================================================
// Renderer messaging
// ==========================================================================
function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function sendToOverlay(payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!overlayWindow.webContents || overlayWindow.webContents.isDestroyed()) return;
  overlayWindow.webContents.send('vitals-update', payload);
}

function overlayPayloadFor(processed) {
  const overlay = (cfg || settings.get()).overlay;
  return {
    bpm: processed ? processed.bpm : null,
    stress: processed ? processed.stress : null,
    showBpm: overlay.showBpm,
    showStress: overlay.showStress
  };
}

// ==========================================================================
// Windows
// ==========================================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0a0512',
    titleBarStyle: 'hiddenInset',
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Lets the renderer skip side effects that leave the app during tests.
      additionalArguments: E2E_MODE ? ['--e2e-hooks'] : []
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    // Same repaint contract as the overlay: the daily summary only arrives
    // every few minutes, so a freshly loaded dashboard is handed the cached one
    // instead of sitting on placeholders until the next push.
    if (lastHealth) sendToRenderer('health', lastHealth);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeOverlay();
  });
}

function openOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  overlayWindow = new BrowserWindow({
    width: 260,
    height: 90,
    minWidth: 140,
    minHeight: 50,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    // Paint the widget immediately instead of leaving it blank until the next
    // sample arrives.
    sendToOverlay(overlayPayloadFor(state.lastPayload));
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    // The widget can also be dismissed from its own frame; keep the dashboard
    // switch in sync no matter which path closed it.
    sendToRenderer('overlay', { active: false });
  });
}

function closeOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = null;
    return;
  }
  const win = overlayWindow;
  overlayWindow = null;
  try { win.close(); } catch (err) { /* already gone */ }
}

// ==========================================================================
// Vitals pipeline
// ==========================================================================
function handleVitals(raw, meta) {
  // Daily health summaries ride the same socket/topic as vitals but must never
  // touch the vitals pipeline — no OSC, no Discord, no alarms, no recording.
  if (raw && raw.type === 'health') return handleHealth(raw, meta);

  const now = Date.now();
  const processed = state.ingest(raw, now);
  if (!processed) return null;

  // 1. Dashboard.
  sendToRenderer('vitals', processed);

  // 2. Floating overlay widget.
  sendToOverlay(overlayPayloadFor(processed));

  // 3. OBS browser source and any other consumer on the LAN hub.
  if (lanServer) {
    lanServer.broadcast({
      bpm: processed.bpm,
      hrv: processed.hrv,
      stress: processed.stress,
      zone: processed.zone,
      zoneKey: processed.zoneKey,
      ts: now
    }, meta && meta.socket);
  }

  // 4. VRChat.
  if (oscEngine) {
    oscEngine.setLive(true);
    oscEngine.update(processed);
  }
  wasLive = true;

  // 5. Discord.
  if (discord && cfg.discord.enabled) discord.update(processed);

  // 6. NX Hub. Self-throttling and change-gated — a sample that says nothing
  // new never reaches the bus.
  if (hub) hub.setVitals(processed);

  // 7. Link status (battery / RSSI readout, plus which sensor the phone is
  // reading). Vitals arrive several times a second; the status line only needs
  // repainting when something in it moves.
  publishLinkStatus((meta && meta.source) || 'lan', processed, raw && raw.src);

  // 8. Alarms.
  evaluateAlarms(processed, cfg, now);

  return processed;
}

let lastLinkKey = '';
let lastLinkSentAt = 0;

function publishLinkStatus(source, processed, srcArg) {
  // `source` is the transport (lan | cloud); `src` is the sensor the phone read
  // the sample from. Absent means the watch BLE profile, per the protocol.
  const src = srcArg === 'health' ? 'health' : 'ble';
  const key = `${source}|${src}|${processed.battery}|${processed.rssi}`;
  const now = Date.now();
  // Refresh at least every 5 s so a reconnected dashboard is never left stale.
  if (key === lastLinkKey && (now - lastLinkSentAt) < 5000) return;

  lastLinkKey = key;
  lastLinkSentAt = now;
  sendToRenderer('link', {
    state: 'connected',
    source,
    src,
    phone: { battery: processed.battery, rssi: processed.rssi }
  });
}

// ==========================================================================
// Health pipeline (Health Connect daily summary)
// ==========================================================================
/**
 * Handles one `{type:'health'}` message. The summary is a five-minutely
 * readout, not a live sample: it is normalised, cached for dashboard reloads
 * and pushed to the renderer, and nothing else in the app hears about it.
 *
 * @param {object} raw   parsed message off the transport
 * @param {object} meta  transport metadata (unused — a summary is the same
 *                       whichever way it arrived)
 * @returns {?object} the normalised summary, or null if the message was junk
 */
function handleHealth(raw, meta) {
  const summary = normalizeHealth(raw);
  if (!summary) return null;

  lastHealth = summary;
  sendToRenderer('health', summary);
  return summary;
}

function evaluateAlarms(processed, cfg, now) {
  // High-HR tone: edge triggered so the renderer is not asked to replay the
  // tone on every packet.
  const highHr = processed.bpm > HIGH_HR_TONE_BPM;
  if (highHr !== highHrActive) {
    highHrActive = highHr;
    sendToRenderer('alarm', {
      type: 'highHr',
      active: highHr,
      sound: !!cfg.alarms.highHrTone
    });
  }

  const threshold = state.checkThreshold(processed.bpm, now);
  if (threshold.changed) {
    sendToRenderer('alarm', {
      type: 'threshold',
      active: threshold.active,
      sound: !!cfg.alarms.audio
    });
    if (oscEngine && cfg.alarms.oscFlag) oscEngine.setWarning(threshold.active);
  }
}

/** The phone left, or the stream went stale: nothing may pretend to be live. */
function goOffline(detail, source) {
  const wasRecording = state.recording;
  state.clearLive();
  if (wasRecording) state.stopRecording();

  wasLive = false;
  if (oscEngine) {
    oscEngine.setLive(false);
    oscEngine.setWarning(false);
  }
  if (highHrActive) {
    highHrActive = false;
    sendToRenderer('alarm', { type: 'highHr', active: false, sound: false });
  }

  // Presence must not freeze at the last live BPM once the stream is gone.
  if (discord && cfg.discord.enabled) discord.setIdle();
  if (hub) hub.setOffline();

  sendToRenderer('link', {
    state: 'awaiting',
    source,
    detail,
    recordingStopped: wasRecording
  });
}

function startTimers() {
  // Live watchdog: a sample older than the state's live window means the OSC
  // producers must fall silent, even if no BYE ever arrived.
  liveWatchdog = setInterval(() => {
    const live = state.isLive(Date.now());
    if (wasLive && !live) goOffline('Vitals stream stalled');
    wasLive = live;
    if (oscEngine) oscEngine.setLive(live);
  }, LIVE_WATCHDOG_MS);
  if (liveWatchdog.unref) liveWatchdog.unref();

  // Breathing pacer clock. It runs continuously (the pacer is a guided
  // exercise, not a readout), and only phase changes are pushed.
  breathTicker = setInterval(() => {
    const { phase, changed } = state.tickBreath(Date.now());
    if (changed) sendToRenderer('breath', { phase });
  }, BREATH_TICK_MS);
  if (breathTicker.unref) breathTicker.unref();
}

// ==========================================================================
// Settings application
// ==========================================================================
function applySettings(next) {
  cfg = next;

  state.setProfile(cfg.profile);
  state.setStressOffset(cfg.stressOffset);
  state.setAlarmConfig(cfg.alarms);

  if (oscEngine) oscEngine.configure(cfg.osc);

  if (discord) {
    discord.setTemplates(cfg.discord);
    if (cfg.discord.enabled) {
      discord.enable();
      if (state.lastPayload) discord.update(state.lastPayload);
    } else {
      discord.disable();
    }
  }

  // Overlay visibility flags take effect immediately, not on the next sample.
  sendToOverlay(overlayPayloadFor(state.lastPayload));
}

// ==========================================================================
// Transports
// ==========================================================================
function startTransports() {
  lanServer = new LanServer({ port: LAN_PORT });
  lanServer.on('vitals', (raw, meta) => handleVitals(raw, meta));
  lanServer.on('hello', () => sendToRenderer('link', { state: 'connected', source: 'lan' }));
  lanServer.on('bye', () => goOffline('Phone signed off', 'lan'));
  lanServer.on('producer-connected', () => {
    sendToRenderer('link', { state: 'connected', source: 'lan' });
  });
  lanServer.on('producer-disconnected', () => goOffline('Phone disconnected', 'lan'));
  lanServer.on('error', (err) => {
    sendToRenderer('link', { state: 'offline', source: 'lan', detail: err.message || String(err) });
  });
  lanServer.start();

  if (BEACON_ENABLED) {
    beacon = new DiscoveryBeacon({ servicePort: LAN_PORT, beaconPort: BEACON_PORT });
    beacon.start();
  } else {
    console.log('Discovery beacon disabled (PULSENX_NO_BEACON=1)');
  }

  mqttLink = new MqttLink({ code: linkCode });
  mqttLink.on('vitals', (raw, meta) => handleVitals(raw, meta));
  mqttLink.on('hello', () => {
    // A fresh phone session starts from clean statistics.
    state.resetStats(Date.now());
    sendToRenderer('link', { state: 'connected', source: 'cloud' });
  });
  mqttLink.on('bye', () => goOffline('Phone signed off', 'cloud'));
  mqttLink.on('status', (status) => sendToRenderer('link', { ...status, source: 'cloud' }));
  mqttLink.start();

  // The widget page connects back to the LAN hub, so it has to be told which
  // port that actually is.
  obsServer = new ObsServer({ port: OBS_PORT, wsPort: LAN_PORT });
  obsServer.start();

  oscEngine = new OscEngine();
  discord = new DiscordLink({ suppressed: E2E_MODE });
  discord.on('status', (status) => sendToRenderer('discord', status));
}

// ==========================================================================
// IPC contract (see SPEC.md)
// ==========================================================================
function registerIpc() {
  ipcMain.handle('settings:get', () => settings.get());

  ipcMain.handle('settings:set', (event, patch) => {
    const merged = settings.set(patch);
    applySettings(merged);
    return merged;
  });

  ipcMain.handle('session:start', () => {
    state.startRecording(Date.now());
    return { ok: true };
  });

  ipcMain.handle('session:stop', () => {
    const result = state.stopRecording();
    return { ok: true, rows: result.rows };
  });

  ipcMain.handle('session:exportCsv', async () => {
    return csv.exportSession(state.rows(), { dialog, app, window: mainWindow });
  });

  ipcMain.handle('history:parseCsv', (event, text) => csv.parseSessionCsv(text));

  ipcMain.handle('overlay:toggle', (event, show) => {
    if (show) openOverlay();
    else closeOverlay();
    const active = !!(overlayWindow && !overlayWindow.isDestroyed());
    sendToRenderer('overlay', { active });
    return { active };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    linkCode,
    lanEndpoint: `ws://${localIpAddress()}:${LAN_PORT}`,
    obsUrl: obsServer ? obsServer.url() : `http://localhost:${OBS_PORT}`
  }));
}

// ==========================================================================
// Lifecycle
// ==========================================================================
function bootstrap() {
  settings = new SettingsStore(app.getPath('userData'));
  state = new VitalsState();

  startTransports();
  registerIpc();
  applySettings(settings.get());
  startTimers();

  // NX Hub presence. Not a transport — it carries no vitals into the app, it
  // only reports outward — and it is inert when NX Hub is not installed.
  hub = new HubConnector({ suppressed: E2E_MODE });
  hub.on('shutdown-request', () => app.quit());
  hub.start({ version: app.getVersion() });

  createMainWindow();

  if (E2E_MODE) {
    e2eServer = startE2eHooks({
      getWindow: () => mainWindow,
      // Synthetic samples go through the exact same path as phone traffic.
      inject: (sample) => handleVitals(sample, { source: 'e2e' }),
      port: E2E_PORT
    });
  }

  // Nothing is live until a sample arrives.
  sendToRenderer('link', { state: 'awaiting' });
}

function shutdown() {
  if (liveWatchdog) clearInterval(liveWatchdog);
  if (breathTicker) clearInterval(breathTicker);
  liveWatchdog = null;
  breathTicker = null;

  if (oscEngine) oscEngine.stop();
  if (discord) discord.stop();
  if (hub) hub.stop();
  if (mqttLink) mqttLink.stop();
  if (lanServer) lanServer.stop();
  if (beacon) beacon.stop();
  if (obsServer) obsServer.stop();
  if (e2eServer) {
    try { e2eServer.close(); } catch (err) { /* already closed */ }
    e2eServer = null;
  }
}

// A second instance sharing this user-data directory could never bind the same
// ports anyway; hand focus back to the window that owns them instead of failing
// halfway through boot. (A test instance runs off its own --user-data-dir and
// its own PULSENX_PORT_* overrides, so it takes its own lock.)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', shutdown);
}

// A transport fault must never take the app down mid-session.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});
