'use strict';

/**
 * PulseNX — TEST-ONLY DOM PROBE
 *
 * Enabled exclusively by the --e2e-hooks command line argument and bound to the
 * loopback interface. It runs a FIXED introspection expression and a fixed set
 * of actions; it never evaluates code supplied by the caller.
 *
 * Routes:
 *   GET /dom                     -> snapshot of the dashboard's key readouts
 *                                   (live vitals + the Daily Health card)
 *   GET /action/record-start     -> clicks Start Recording
 *   GET /action/record-stop      -> clicks Stop Recording
 *   GET /inject?bpm=NN&rr=NN     -> feeds one synthetic sample through the
 *                                   normal vitals pipeline (no phone needed)
 */

const http = require('http');

const E2E_HOOKS_PORT = 9010;

// Fixed expression: read-only property access on well-known element ids.
const DOM_SNAPSHOT = `(() => {
  const txt = (id) => { const el = document.getElementById(id); return el ? el.innerText : null; };
  const rec = document.getElementById('rec-indicator');
  const exportBtn = document.getElementById('btn-export-csv');
  const startBtn = document.getElementById('btn-record-start');
  const warmup = document.getElementById('zone-bar-warmup');
  return {
    bpm: txt('bpm-val'),
    hrv: txt('hrv-val'),
    rr: txt('rr-val'),
    stress: txt('stress-val'),
    zone: txt('zone-badge'),
    avgBpm: txt('stat-avg-bpm'),
    minBpm: txt('stat-min-bpm'),
    maxBpm: txt('stat-max-bpm'),
    kcal: txt('kcal-val'),
    sessionTimer: txt('session-timer'),
    coherence: txt('lbl-flow-coherence'),
    zoneWarmupPct: txt('lbl-pct-warm'),
    zoneWarmupWidth: warmup ? warmup.style.width : null,
    healthSteps: txt('health-steps'),
    healthDistance: txt('health-distance'),
    healthActiveKcal: txt('health-active-kcal'),
    healthTotalKcal: txt('health-total-kcal'),
    healthSleep: txt('health-sleep'),
    healthRestingBpm: txt('health-resting-bpm'),
    healthMinBpm: txt('health-min-bpm'),
    healthAvgBpm: txt('health-avg-bpm'),
    healthMaxBpm: txt('health-max-bpm'),
    healthSpo2: txt('health-spo2'),
    healthSource: txt('health-source'),
    healthUpdated: txt('health-updated'),
    recording: !!(rec && rec.classList.contains('active')),
    recordStartEnabled: !!(startBtn && !startBtn.disabled),
    exportEnabled: !!(exportBtn && !exportBtn.disabled)
  };
})()`;

const ACTIONS = {
  'record-start': `(() => { const b = document.getElementById('btn-record-start'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  'record-stop': `(() => { const b = document.getElementById('btn-record-stop'); if (!b) return false; b.click(); return true; })()`
};

/**
 * @param {object} deps
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {(sample:object) => object|null} deps.inject  feeds the real pipeline
 */
function startE2eHooks({ getWindow, inject, port = E2E_HOOKS_PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    const [route, query] = (req.url || '').split('?');
    const params = new URLSearchParams(query || '');

    const respond = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      // The injector runs entirely in main, so it works before (and without)
      // any window being ready.
      if (route === '/inject') {
        const bpm = Number(params.get('bpm'));
        if (!Number.isFinite(bpm) || bpm <= 0) {
          return respond(400, { error: 'bpm query parameter required' });
        }
        const rr = Number(params.get('rr'));
        const sample = {
          bpm,
          rr: Number.isFinite(rr) && rr > 0 ? rr : Math.round(60000 / bpm),
          contact: params.get('contact') !== 'false',
          battery: Number(params.get('battery')) || 88,
          rssi: Number(params.get('rssi')) || -55
        };
        const processed = inject ? inject(sample) : null;
        return respond(200, { ok: !!processed, sample, processed });
      }

      const win = getWindow ? getWindow() : null;
      if (!win || win.isDestroyed()) {
        return respond(503, { error: 'main window unavailable' });
      }

      if (route === '/dom') {
        return respond(200, await win.webContents.executeJavaScript(DOM_SNAPSHOT));
      }

      // GET /screenshot?path=/abs/file.png[&view=dashboard|osc|alarms|breathing|history|settings][&fullHeight=1]
      // Captures the main window to a PNG on disk (loopback/test only).
      // fullHeight=1 temporarily grows the window to the page's scroll height
      // so cards below the fold land in the capture, then restores the bounds.
      if (route === '/screenshot') {
        const outPath = params.get('path');
        if (!outPath || !outPath.startsWith('/')) {
          return respond(400, { error: 'absolute path query parameter required' });
        }
        const view = params.get('view');
        if (view && /^[a-z]+$/.test(view)) {
          await win.webContents.executeJavaScript(
            `(() => { const b = document.querySelector('[data-view="${view}"]'); if (b) b.click(); return true; })()`
          );
          await new Promise((r) => setTimeout(r, 350));
        }
        const restoreBounds = params.get('fullHeight') === '1' ? win.getBounds() : null;
        if (restoreBounds) {
          const pageHeight = await win.webContents.executeJavaScript(
            '(document.querySelector(".view.active") || document.documentElement).scrollHeight'
          );
          const [w] = win.getContentSize();
          win.setContentSize(w, Math.min(pageHeight + 90, 4000));
          await new Promise((r) => setTimeout(r, 300));
        }
        const image = await win.webContents.capturePage();
        if (restoreBounds) win.setBounds(restoreBounds);
        require('fs').writeFileSync(outPath, image.toPNG());
        return respond(200, { ok: true, path: outPath });
      }

      if (route.startsWith('/action/')) {
        const expression = ACTIONS[route.slice('/action/'.length)];
        if (!expression) return respond(404, { error: 'unknown action' });
        return respond(200, { ok: await win.webContents.executeJavaScript(expression) });
      }
    } catch (err) {
      return respond(500, { error: String((err && err.message) || err) });
    }

    respond(404, { error: 'not found' });
  });

  server.on('error', (err) => console.warn('[e2e] hook server error:', err.message || err));
  server.listen(port, '127.0.0.1', () => {
    console.log(`E2E test hooks listening on http://127.0.0.1:${port}`);
  });

  return server;
}

module.exports = { startE2eHooks, E2E_HOOKS_PORT, DOM_SNAPSHOT, ACTIONS };
