/* PulseNX — all sound lives in the renderer via WebAudio (no IPC, no assets). */

let ctx = null;
let beeperOn = false;
let beeperTimer = 0;
let beeperGate = () => true;

function ensureCtx() {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch (err) {
    console.warn('[PulseNX] WebAudio unavailable:', err);
    return null;
  }
}

/** Browsers gate audio until a gesture — warm the context on the first interaction. */
export function primeOnFirstGesture() {
  const prime = () => { ensureCtx(); };
  window.addEventListener('pointerdown', prime, { once: true });
  window.addEventListener('keydown', prime, { once: true });
}

/** Short 880 Hz sawtooth blip — the "Test Audio" sound and the alarm tick. */
export function blip({ freq = 880, type = 'sawtooth', gain = 0.08, duration = 0.15 } = {}) {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.connect(amp);
    amp.connect(ac.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime);
    amp.gain.setValueAtTime(gain, ac.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
    osc.start();
    osc.stop(ac.currentTime + duration);
  } catch (err) {
    console.warn('[PulseNX] blip failed:', err);
  }
}

export function testAlarm() {
  blip();
  setTimeout(() => blip({ freq: 1046 }), 190);
}

/** Repeating warning beeper while an alarm is active. `gate` re-checks the user toggle. */
export function startBeeper(gate) {
  if (typeof gate === 'function') beeperGate = gate;
  if (beeperOn) return;
  beeperOn = true;
  const tick = () => {
    if (!beeperOn) return;
    if (beeperGate()) blip({ freq: 880, gain: 0.08, duration: 0.15 });
    beeperTimer = setTimeout(tick, 1000);
  };
  tick();
}

export function stopBeeper() {
  beeperOn = false;
  clearTimeout(beeperTimer);
  beeperTimer = 0;
}

export function isBeeping() { return beeperOn; }

/** Soft meditation chime: rising E4→G4 on inhale, falling D4→B3 on exhale. */
export function chime(isInhale) {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.connect(amp);
    amp.connect(ac.destination);
    osc.type = 'sine';

    const t = ac.currentTime;
    const from = isInhale ? 329.63 : 293.66;  // E4 / D4
    const to = isInhale ? 392.00 : 246.94;    // G4 / B3
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + 0.4);

    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.04, t + 0.15);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);

    osc.start();
    osc.stop(t + 0.55);
  } catch (err) {
    console.warn('[PulseNX] chime failed:', err);
  }
}
