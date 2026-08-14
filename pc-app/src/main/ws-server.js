'use strict';

/**
 * PulseNX — LAN WebSocket hub on :9000.
 *
 * The same port serves two kinds of peer:
 *   - PRODUCERS: the Android bridge, pushing raw vitals up.
 *   - CONSUMERS: the OBS browser source (and anything else), reading processed
 *     vitals back down.
 *
 * They are told apart by behaviour, not by a handshake: a socket that has ever
 * sent us a message is a producer, everything else is a consumer. Broadcasts go
 * to every socket that is not the origin of the data, so the phone never has
 * its own numbers echoed back at it.
 */

const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_PORT = 9000;

class LanServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || DEFAULT_PORT;
    this.wss = null;
    this.producers = new Set();
  }

  start() {
    try {
      this.wss = new WebSocketServer({ port: this.port });
    } catch (err) {
      // A port clash must not take the app down; the cloud transport still works.
      this.emit('error', err);
      return false;
    }

    this.wss.on('listening', () => {
      console.log(`LAN WebSocket server listening on ws://0.0.0.0:${this.port}`);
      this.emit('listening', this.port);
    });

    this.wss.on('error', (err) => {
      console.warn('[ws] server error:', err.message || err);
      this.emit('error', err);
    });

    this.wss.on('connection', (socket, req) => {
      const peer = (req && req.socket && req.socket.remoteAddress) || 'unknown';

      socket.on('message', (data) => {
        if (!this.producers.has(socket)) {
          this.producers.add(socket);
          this.emit('producer-connected', { peer });
        }
        this.handleMessage(socket, data);
      });

      socket.on('error', (err) => {
        console.warn('[ws] socket error:', err.message || err);
      });

      socket.on('close', () => {
        if (this.producers.delete(socket)) {
          this.emit('producer-disconnected', { peer });
        }
      });
    });

    return true;
  }

  handleMessage(socket, data) {
    const text = data.toString().trim();
    if (!text) return;

    // Handshake frames arrive either bare or JSON-quoted depending on client.
    const bare = text.replace(/^"|"$/g, '');
    if (bare === 'HELLO') {
      this.emit('hello', { source: 'lan' });
      return;
    }
    if (bare === 'BYE') {
      this.emit('bye', { source: 'lan' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn('[ws] dropped unparsable frame:', text.slice(0, 80));
      return;
    }

    if (parsed && typeof parsed === 'object') {
      this.emit('vitals', parsed, { source: 'lan', socket });
    }
  }

  /** Pushes processed vitals to every consumer (i.e. non-producer) socket. */
  broadcast(payload, exclude) {
    if (!this.wss) return 0;
    const text = JSON.stringify(payload);
    let sent = 0;

    for (const socket of this.wss.clients) {
      if (socket === exclude) continue;
      if (this.producers.has(socket)) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(text);
        sent++;
      } catch (err) {
        console.warn('[ws] broadcast failed:', err.message || err);
      }
    }

    return sent;
  }

  stop() {
    if (!this.wss) return;
    try {
      for (const socket of this.wss.clients) {
        try { socket.terminate(); } catch (e) { /* already gone */ }
      }
      this.wss.close();
    } catch (err) {
      console.warn('[ws] shutdown error:', err.message || err);
    }
    this.wss = null;
    this.producers.clear();
  }
}

module.exports = { LanServer, DEFAULT_PORT };
