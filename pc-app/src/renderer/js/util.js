/* PulseNX — tiny DOM/format helpers (no node APIs) */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function setText(el, value) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node && node.textContent !== String(value)) node.textContent = String(value);
}

export function setWidth(el, pct) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.style.width = `${clamp(pct, 0, 100)}%`;
}

export function toggleClass(el, cls, on) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.classList.toggle(cls, !!on);
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Number formatting that degrades to a placeholder. */
export function num(value, digits = 0, fallback = '--') {
  if (!isNum(value)) {
    const parsed = Number(value);
    if (value === null || value === undefined || value === '' || Number.isNaN(parsed)) return fallback;
    return parsed.toFixed(digits);
  }
  return value.toFixed(digits);
}

/** Seconds → HH:MM:SS */
export function hhmmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

/** Timestamp (ms | ISO string | label) → HH:MM:SS clock label. */
export function clockLabel(t) {
  if (typeof t === 'string' && !/^\d+$/.test(t)) {
    const parsed = Date.parse(t);
    if (Number.isNaN(parsed)) return t;
    t = parsed;
  }
  const d = new Date(Number(t) || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((v) => String(v).padStart(2, '0')).join(':');
}

/** Build a nested partial object from a dotted path: 'osc.enabled' → {osc:{enabled:v}} */
export function partial(path, value) {
  const keys = path.split('.');
  const root = {};
  let cursor = root;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) cursor[key] = value;
    else cursor = (cursor[key] = {});
  });
  return root;
}

/** Read a dotted path out of an object. */
export function get(obj, path, fallback) {
  const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  return value === undefined || value === null ? fallback : value;
}

/** First defined value for any of the candidate keys. */
export function pick(obj, keys, fallback) {
  if (!obj) return fallback;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

const ZONE_KEYS = ['warmup', 'fatburn', 'aerobic', 'anaerobic', 'extreme'];
const ZONE_LABELS = {
  warmup: 'Warm Up',
  fatburn: 'Fat Burn',
  aerobic: 'Aerobic',
  anaerobic: 'Anaerobic',
  extreme: 'Extreme'
};

/** Normalise any zone spelling ('WarmUp', 'warm_up', 'Fat Burn') to a canonical key. */
export function zoneKeyOf(raw) {
  const flat = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return '';
  const direct = ZONE_KEYS.find((k) => flat === k);
  if (direct) return direct;
  if (flat.startsWith('warm')) return 'warmup';
  if (flat.startsWith('fat') || flat.startsWith('burn')) return 'fatburn';
  if (flat.startsWith('anaerob')) return 'anaerobic';
  if (flat.startsWith('aerob')) return 'aerobic';
  if (flat.startsWith('extrem') || flat.startsWith('vo2') || flat.startsWith('max')) return 'extreme';
  return '';
}

export function zoneLabel(key) { return ZONE_LABELS[key] || '--'; }
export { ZONE_KEYS, ZONE_LABELS };

/** Debounce for chatty input handlers. */
export function debounce(fn, ms = 180) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
