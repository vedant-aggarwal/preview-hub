import crypto from 'node:crypto';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function mediaKind(file) {
  const m = mimeOf(file);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/plain') || m.startsWith('application/json')) return 'text';
  if (m.startsWith('text/html')) return 'html';
  return 'file';
}

// "30m" "4h" "2d" "1w" "90s" "never" "0" -> ms (0 = never expires)
export function parseTtl(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'never' || s === '0' || s === 'none' || s === 'forever') return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/);
  if (!m) throw new Error(`bad ttl "${v}" (use 30m, 4h, 2d, 1w or never)`);
  const n = parseFloat(m[1]);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2] || 'h'];
  const ms = Math.round(n * unit);
  if (ms < 6e4) throw new Error('ttl must be at least 1m');
  if (ms > 90 * 864e5) throw new Error('ttl max is 90d; use never for no expiry');
  return ms;
}

export function fmtDur(ms) {
  if (ms === null || ms === undefined) return '';
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 6e4), h = Math.floor(m / 60), d = Math.floor(h / 24);
  let out;
  if (d >= 1) out = `${d}d ${h % 24}h`;
  else if (h >= 1) out = `${h}h ${m % 60}m`;
  else if (m >= 1) out = `${m}m`;
  else out = `${Math.max(1, Math.floor(ms / 1000))}s`;
  return neg ? `-${out}` : out;
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .replace(/[_\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28).replace(/-$/, '');
}

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomTag(n = 4) {
  const b = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHA[b[i] % ALPHA.length];
  return out;
}

export function passcodeGen() {
  return `${randomTag(4)}-${randomTag(4)}-${randomTag(4)}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}
