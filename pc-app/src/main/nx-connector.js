// ---------------------------------------------------------------------------
// VENDORED FILE — DO NOT EDIT.
//
// Copied verbatim from nerdrx/nx-hub, docs/connector/nx-connector.js (protocol
// v0.5). It is upstream's reference client, not ours: fixes and features belong
// in nx-hub, and this copy is refreshed by re-copying the file whole. Anything
// PulseNX-specific goes in connector.js next door.
// ---------------------------------------------------------------------------
"use strict";
/**
 * nx-connector — drop-in NX Hub connector client.
 *
 *   Vendored file. Copy it into your app, require it, done. CommonJS, zero
 *   dependencies, works in plain node and in an electron main process.
 *   Wire format: docs/connector/PROTOCOL.md in the nx-hub repo.
 *
 *   const nx = require("./nx-connector");
 *   const bus = nx.connect({ app: "pulsenx", version: "1.2.1" });
 *   bus.on("connected", () => console.log("hub is up"));
 *   bus.on("shutdown-request", () => app.quit());
 *   setInterval(() => bus.sendStatus({ hr: 72, connected: true }), 1000);
 *
 * Contract:
 *   - Never throws and never logs. If no hub is running it retries quietly
 *     forever (1s -> 30s backoff); your app must not care either way.
 *   - sendStatus() buffers nothing. While disconnected it drops the update and
 *     returns false — status is a live gauge, not a queue.
 *   - The token is re-read on every connect attempt, so an app may legitimately
 *     start before the hub has ever run.
 *
 * The RFC 6455 bits are hand-rolled below so this file stays dependency-free.
 */

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const MAX_MESSAGE = 16 * 1024; // matches the hub's cap
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/** The hub's data dir — keep in sync with nx-hub src/main/config.js. */
function defaultTokenPath() {
  const dir = process.env.NX_HUB_DATA_DIR || path.join(os.homedir(), ".local", "share", "nx-hub");
  return path.join(dir, "connector.token");
}

/** Encode one masked client frame (RFC 6455 §5.1: clients ALWAYS mask). */
function encodeMasked(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""), "utf8");
  const len = body.length;
  const lenBytes = len >= 65536 ? 8 : len >= 126 ? 2 : 0;
  const header = Buffer.alloc(2 + lenBytes + 4);
  header[0] = 0x80 | opcode; // FIN, no RSV
  if (lenBytes === 0) header[1] = 0x80 | len;
  else if (lenBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const key = crypto.randomBytes(4);
  key.copy(header, 2 + lenBytes);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

/**
 * Minimal parser for server -> client frames (which are never masked).
 * Calls onFrame(opcode, payload) per complete message; onError() on anything
 * malformed, oversized, or masked.
 */
function makeParser(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let parts = null; // fragmented message in flight
  let partsOp = 0;
  let partsLen = 0;
  let dead = false;

  return function push(chunk) {
    if (dead) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return void ((dead = true), onError("frame too large"));
        len = buf.readUInt32BE(6);
        off = 10;
      }
      // A masked server frame is a protocol violation; so is an over-cap one.
      if (masked) return void ((dead = true), onError("server frame was masked"));
      if (len > MAX_MESSAGE || partsLen + len > MAX_MESSAGE) {
        return void ((dead = true), onError("frame too large"));
      }
      if (buf.length < off + len) return; // wait for the rest
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);

      if (opcode & 0x08) {
        onFrame(opcode, Buffer.from(payload)); // control frames are never split
      } else if (opcode === 0x0) {
        if (!parts) return void ((dead = true), onError("continuation without start"));
        parts.push(Buffer.from(payload));
        partsLen += len;
        if (fin) {
          const whole = Buffer.concat(parts, partsLen);
          const op = partsOp;
          parts = null;
          partsLen = 0;
          onFrame(op, whole);
        }
      } else if (fin) {
        onFrame(opcode, Buffer.from(payload));
      } else {
        parts = [Buffer.from(payload)];
        partsOp = opcode;
        partsLen = len;
      }
    }
  };
}

/**
 * Connect to the hub and keep the connection up.
 *
 * @param {object} o
 * @param {string} o.app        app id (lowercased by the hub)
 * @param {string} [o.version]
 * @param {string} [o.url]      default ws://127.0.0.1:9021
 * @param {string} [o.tokenPath] default <hub data dir>/connector.token
 * @param {string[]} [o.caps]   default ["status"]
 * @param {number} [o.minBackoffMs] advanced/test knob (default 1000)
 * @param {number} [o.maxBackoffMs] advanced/test knob (default 30000)
 * @returns {{sendStatus: function, close: function, on: function, connected: function}}
 */
function connect(o = {}) {
  const app = String(o.app || "").trim();
  const version = o.version == null ? null : String(o.version);
  const url = String(o.url || "ws://127.0.0.1:9021");
  const tokenFile = o.tokenPath || defaultTokenPath();
  const caps = Array.isArray(o.caps) ? o.caps : ["status"];
  const minBackoff = Number(o.minBackoffMs) > 0 ? Number(o.minBackoffMs) : MIN_BACKOFF_MS;
  const maxBackoff = Number(o.maxBackoffMs) > 0 ? Number(o.maxBackoffMs) : MAX_BACKOFF_MS;

  const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url) || [];
  const host = m[1] || "127.0.0.1";
  const port = Number(m[2] || 9021);
  const resource = m[3] || "/";

  const listeners = new Map(); // event -> Set<fn>
  let socket = null;
  let live = false; // true once `welcome` has landed
  let stopped = false;
  let retryTimer = null;
  let backoff = minBackoff;

  const fire = (event, arg) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(arg);
      } catch (_) {
        /* a listener must never break the client */
      }
    }
  };

  const write = (buf) => {
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(buf);
      return true;
    } catch (_) {
      return false;
    }
  };
  const sendJson = (obj) => write(encodeMasked(OP_TEXT, Buffer.from(JSON.stringify(obj), "utf8")));

  /** Drop the current socket, if any, without touching reconnect state. */
  function killSocket() {
    if (!socket) return;
    const s = socket;
    socket = null;
    s.removeAllListeners(); // so its own close event cannot re-enter teardown
    try {
      s.destroy();
    } catch (_) {
      /* already gone */
    }
  }

  /** Tear down the current socket and schedule the next attempt. */
  function teardown() {
    const wasLive = live;
    live = false;
    killSocket();
    if (wasLive) fire("disconnected");
    if (!stopped) schedule();
  }

  function schedule() {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt();
    }, backoff);
    // Never hold the host process open just to retry.
    if (retryTimer.unref) retryTimer.unref();
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  function attempt() {
    if (stopped || socket) return;

    // Read the token lazily: the hub may have been installed (or restarted with
    // a fresh secret) since the last attempt. No token yet == no hub yet.
    let token;
    try {
      token = fs.readFileSync(tokenFile, "utf8").trim();
    } catch (_) {
      return void schedule();
    }
    if (!token) return void schedule();

    const key = crypto.randomBytes(16).toString("base64");
    const expect = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const s = net.connect({ host, port });
    socket = s;
    s.setNoDelay(true);

    let handshakeDone = false;
    let head = Buffer.alloc(0);
    const push = makeParser(onFrame, () => teardown());

    s.on("connect", () => {
      s.write(
        `GET ${resource} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });

    s.on("data", (chunk) => {
      if (socket !== s) return;
      if (handshakeDone) return void push(chunk);

      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return void (head.length > 8192 && teardown());

      const headerText = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(headerText);
      if (!/^HTTP\/1\.1 101/i.test(headerText) || !accept || accept[1] !== expect) {
        return void teardown(); // wrong server, or a stale/foreign listener
      }
      handshakeDone = true;
      sendJson({ type: "hello", app, version, pid: process.pid, token, caps });
      if (rest.length) push(rest);
    });

    s.on("error", () => teardown());
    s.on("close", () => {
      if (socket === s) teardown();
    });
  }

  function onFrame(opcode, payload) {
    if (opcode === OP_CLOSE) return void teardown();
    if (opcode === OP_PING) return void write(encodeMasked(OP_PONG, payload));
    if (opcode !== OP_TEXT) return;

    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "welcome") {
      live = true;
      backoff = minBackoff; // a good connection resets the ladder
      fire("connected", { hub: msg.hub });
    } else if (msg.type === "ping") {
      // Application-level keepalive: answer or the hub reaps us after 90s.
      sendJson({ type: "pong" });
    } else if (msg.type === "shutdown-request") {
      fire("shutdown-request");
    } else if (msg.type === "error") {
      fire("error", new Error(String(msg.message || "connector error")));
    }
  }

  attempt(); // first try is immediate

  return {
    /** Push a status snapshot. Fields merge hub-side. False = dropped. */
    sendStatus(fields) {
      if (!live || !fields || typeof fields !== "object") return false;
      return sendJson({ type: "status", fields });
    },
    /** Say goodbye and stop reconnecting. Safe to call more than once. */
    close() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (live) {
        sendJson({ type: "bye" });
        write(encodeMasked(OP_CLOSE, Buffer.from([0x03, 0xe8]))); // 1000
      }
      live = false;
      killSocket();
    },
    /** on("connected"|"disconnected"|"shutdown-request"|"error", cb) */
    on(event, cb) {
      if (typeof cb !== "function") return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    },
    /** Are we on the bus right now? */
    connected() {
      return live;
    },
  };
}

module.exports = { connect, defaultTokenPath };
