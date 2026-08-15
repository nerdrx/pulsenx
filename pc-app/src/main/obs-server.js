'use strict';

/**
 * PulseNX — OBS browser-source server on :9005.
 *
 * Serves one self-contained widget page: no webfonts, no CDN, no external
 * requests of any kind, because an OBS machine is often offline and the old
 * build's Google-Fonts link left the widget rendering in a fallback face.
 *
 * The page subscribes to the LAN WebSocket hub on :9000, where main broadcasts
 * processed vitals to every consumer socket. Both ports are overridable (a test
 * instance must be able to run beside a production one), so the page is
 * rendered per server rather than kept as one frozen string.
 */

const http = require('http');

const OBS_PORT = 9005;
const DEFAULT_WS_PORT = 9000;

function widgetHtml(wsPort) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PulseNX — OBS Source</title>
<style>
  :root {
    --nx-violet: #7700FF;
    --nx-cyan: #00e5ff;
    --nx-red: #ff2d55;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    /* System stack only — the widget must render identically offline. */
    font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif;
    color: #fff;
    user-select: none;
    -webkit-user-select: none;
  }
  body { display: flex; align-items: center; padding: 14px 18px; }
  .card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 20px;
    border-radius: 18px;
    background: rgba(10, 5, 18, 0.72);
    border: 1px solid rgba(119, 0, 255, 0.45);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45), 0 0 24px rgba(119, 0, 255, 0.18);
    backdrop-filter: blur(12px);
  }
  .card.stale { opacity: 0.55; border-color: rgba(255, 255, 255, 0.12); }
  .heart {
    width: 34px; height: 34px;
    color: var(--nx-red);
    filter: drop-shadow(0 0 8px rgba(255, 45, 85, 0.75));
    animation: beat 1s infinite ease-in-out;
    transform-origin: center;
  }
  .card.stale .heart { animation: none; opacity: 0.5; }
  .readout { display: flex; flex-direction: column; line-height: 1; }
  .row { display: flex; align-items: baseline; gap: 8px; }
  .bpm {
    font-size: 40px;
    font-weight: 800;
    letter-spacing: -1px;
    background: linear-gradient(135deg, #ffffff 0%, var(--nx-cyan) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .stress {
    font-size: 15px;
    font-weight: 700;
    color: var(--nx-violet);
    text-shadow: 0 0 10px rgba(119, 0, 255, 0.7);
  }
  .stress.hidden { display: none; }
  .label {
    margin-top: 5px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--nx-cyan);
    text-transform: uppercase;
  }
  @keyframes beat {
    0%, 100% { transform: scale(1); }
    14% { transform: scale(1.22); }
    28% { transform: scale(1); }
    42% { transform: scale(1.12); }
  }
</style>
</head>
<body>
  <div class="card stale" id="card">
    <svg class="heart" id="heart" viewBox="0 0 32 29" aria-hidden="true">
      <path fill="currentColor" d="M16 28.5 3.6 16.2A7.6 7.6 0 0 1 16 7.2 7.6 7.6 0 0 1 28.4 16.2Z"/>
    </svg>
    <div class="readout">
      <div class="row">
        <span class="bpm" id="bpm">--</span>
        <span class="stress hidden" id="stress"></span>
      </div>
      <div class="label">BPM &middot; PulseNX</div>
    </div>
  </div>
<script>
(function () {
  var card = document.getElementById('card');
  var bpmEl = document.getElementById('bpm');
  var stressEl = document.getElementById('stress');
  var heart = document.getElementById('heart');
  var socket = null;
  var staleTimer = null;

  function markStale() {
    card.classList.add('stale');
    bpmEl.textContent = '--';
  }

  function apply(data) {
    if (typeof data.bpm === 'number' && data.bpm > 0) {
      card.classList.remove('stale');
      bpmEl.textContent = String(data.bpm);
      heart.style.animationDuration = Math.max(0.3, 60 / data.bpm) + 's';
    }
    if (typeof data.stress === 'number') {
      stressEl.textContent = data.stress + '%';
      stressEl.classList.remove('hidden');
    }
    clearTimeout(staleTimer);
    // The stream is only trustworthy while packets keep arriving.
    staleTimer = setTimeout(markStale, 10000);
  }

  function connect() {
    try {
      socket = new WebSocket('ws://' + (location.hostname || '127.0.0.1') + ':${wsPort}');
    } catch (e) {
      setTimeout(connect, 3000);
      return;
    }
    socket.onmessage = function (event) {
      try { apply(JSON.parse(event.data)); } catch (e) { /* ignore malformed frame */ }
    };
    // OBS keeps the page alive across app restarts, so always retry.
    socket.onclose = function () { markStale(); setTimeout(connect, 3000); };
    socket.onerror = function () { try { socket.close(); } catch (e) {} };
  }

  connect();
})();
</script>
</body>
</html>`;
}

// The page as served by a default-configured app; kept as a named export so
// tooling can inspect it without standing a server up.
const WIDGET_HTML = widgetHtml(DEFAULT_WS_PORT);

class ObsServer {
  constructor(options = {}) {
    this.port = options.port || OBS_PORT;
    this.wsPort = options.wsPort || DEFAULT_WS_PORT;
    this.html = widgetHtml(this.wsPort);
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      const route = (req.url || '/').split('?')[0];

      if (route === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'pulsenx-obs' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(this.html);
    });

    // A busy port must degrade to "no OBS source", never to a crashed app.
    this.server.on('error', (err) => {
      console.warn('[obs] server error:', err.message || err);
    });

    this.server.listen(this.port, () => {
      console.log(`OBS browser-source server listening on http://localhost:${this.port}`);
    });

    return this.server;
  }

  url() {
    return `http://localhost:${this.port}`;
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); } catch (e) { /* already closed */ }
    this.server = null;
  }
}

module.exports = { ObsServer, OBS_PORT, DEFAULT_WS_PORT, WIDGET_HTML, widgetHtml };
