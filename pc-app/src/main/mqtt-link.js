'use strict';

/**
 * PulseNX — cloud transport.
 *
 * The phone and the PC meet on a public MQTT broker over WSS. The rendezvous is
 * a per-launch link code the user types into the phone; the topic derived from
 * it is the only shared secret, so the code is 6 characters (~2.2 G keyspace)
 * rather than the 4 the previous build used.
 */

const { EventEmitter } = require('events');

const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

function generateLinkCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

function topicForCode(code) {
  return `pulsenx/vitals/pc-${code}`;
}

class MqttLink extends EventEmitter {
  constructor(options = {}) {
    super();
    this.brokerUrl = options.brokerUrl || BROKER_URL;
    this.code = options.code || generateLinkCode();
    this.topic = topicForCode(this.code);
    this.client = null;
    this.connected = false;
  }

  start() {
    let mqtt;
    try {
      mqtt = require('mqtt');
    } catch (err) {
      console.warn('[mqtt] module unavailable, cloud transport disabled:', err.message);
      this.emit('status', { state: 'offline', detail: 'MQTT module unavailable' });
      return false;
    }

    try {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `pulsenx-pc-${this.code}-${Math.floor(Math.random() * 1e6)}`,
        reconnectPeriod: 5000,
        connectTimeout: 15000,
        clean: true
      });
    } catch (err) {
      console.warn('[mqtt] connect failed:', err.message || err);
      this.emit('status', { state: 'offline', detail: err.message || String(err) });
      return false;
    }

    this.client.on('connect', () => {
      this.connected = true;
      this.client.subscribe(this.topic, (err) => {
        if (err) {
          console.warn('[mqtt] subscribe failed:', err.message || err);
          this.emit('status', { state: 'offline', detail: 'Subscribe failed' });
          return;
        }
        console.log(`MQTT cloud link subscribed to ${this.topic}`);
        this.emit('status', { state: 'awaiting' });
      });
    });

    this.client.on('message', (topic, message) => {
      if (topic !== this.topic) return;
      this.handleMessage(message.toString());
    });

    this.client.on('error', (err) => {
      console.warn('[mqtt] client error:', err.message || err);
      this.emit('status', { state: 'offline', detail: err.message || String(err) });
    });

    this.client.on('offline', () => {
      this.connected = false;
      this.emit('status', { state: 'offline', detail: 'Broker offline' });
    });

    this.client.on('reconnect', () => {
      this.emit('status', { state: 'offline', detail: 'Reconnecting…' });
    });

    return true;
  }

  handleMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Handshake frames are published as JSON strings ("HELLO"), but tolerate a
    // bare payload too so a hand-rolled publisher still links.
    const bare = trimmed.replace(/^"|"$/g, '');
    if (bare === 'HELLO') {
      this.emit('hello', { source: 'cloud' });
      return;
    }
    if (bare === 'BYE') {
      this.emit('bye', { source: 'cloud' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      console.warn('[mqtt] dropped unparsable payload:', trimmed.slice(0, 80));
      return;
    }

    if (parsed && typeof parsed === 'object') {
      this.emit('vitals', parsed, { source: 'cloud' });
    }
  }

  stop() {
    if (!this.client) return;
    try {
      this.client.end(true);
    } catch (err) {
      console.warn('[mqtt] shutdown error:', err.message || err);
    }
    this.client = null;
    this.connected = false;
  }
}

module.exports = { MqttLink, generateLinkCode, topicForCode, BROKER_URL, CODE_LENGTH };
