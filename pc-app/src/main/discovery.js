'use strict';

/**
 * PulseNX — LAN discovery beacon.
 *
 * Broadcasts {service, port, hostname} to UDP :9001 every 2 s so the phone can
 * find this PC without the user typing an IP address.
 */

const dgram = require('dgram');
const os = require('os');

const BEACON_PORT = 9001;
const BEACON_INTERVAL_MS = 2000;

/** First non-internal IPv4 address, or loopback if the host is offline. */
function localIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const alias of interfaces[name] || []) {
        if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
          return alias.address;
        }
      }
    }
  } catch (err) {
    console.warn('[discovery] could not enumerate interfaces:', err.message || err);
  }
  return '127.0.0.1';
}

class DiscoveryBeacon {
  constructor(options = {}) {
    this.servicePort = options.servicePort || 9000;
    this.beaconPort = options.beaconPort || BEACON_PORT;
    this.intervalMs = options.intervalMs || BEACON_INTERVAL_MS;
    this.socket = null;
    this.timer = null;
  }

  start() {
    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      console.warn('[discovery] socket creation failed:', err.message || err);
      return false;
    }

    // Without this listener a transient network error would be thrown as an
    // uncaught 'error' event and end the process.
    this.socket.on('error', (err) => {
      console.warn('[discovery] socket error:', err.message || err);
    });

    const message = Buffer.from(JSON.stringify({
      service: 'pulsenx',
      port: this.servicePort,
      hostname: os.hostname()
    }));

    this.socket.bind(() => {
      try {
        this.socket.setBroadcast(true);
      } catch (err) {
        console.warn('[discovery] could not enable broadcast:', err.message || err);
      }
    });

    this.timer = setInterval(() => {
      if (!this.socket) return;
      try {
        this.socket.send(message, 0, message.length, this.beaconPort, '255.255.255.255', (err) => {
          // Networks without a broadcast route (VPN-only, container) fail here
          // on every tick; log nothing, the beacon is best effort.
          if (err && process.env.PULSENX_DEBUG) {
            console.warn('[discovery] send failed:', err.message);
          }
        });
      } catch (err) {
        // Socket torn down between the guard and the send.
      }
    }, this.intervalMs);

    if (this.timer.unref) this.timer.unref();
    console.log(`Discovery beacon broadcasting on udp/${this.beaconPort} every ${this.intervalMs} ms`);
    return true;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* already closed */ }
      this.socket = null;
    }
  }
}

module.exports = { DiscoveryBeacon, localIpAddress, BEACON_PORT };
