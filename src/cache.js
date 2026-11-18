import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './store.js';
import { sha1 } from './util.js';

export const ENTRY_LIMIT = 40 * 1024 * 1024; // skip caching single responses above 40 MB
const KEEP_HEADERS = ['content-type', 'content-encoding', 'content-language'];

export function cacheDir(id) { return path.join(DIRS.cache, id); }

export function cacheKey(reqPath) { return sha1(reqPath); }

export function cachePut(id, reqPath, status, headers, body) {
  try {
    const dir = cacheDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const key = cacheKey(reqPath);
    const meta = { path: reqPath, status, size: body.length, ts: Date.now(), headers: {} };
    for (const h of KEEP_HEADERS) if (headers[h]) meta.headers[h] = headers[h];
    fs.writeFileSync(path.join(dir, `${key}.bin`), body);
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(meta));
  } catch { /* cache is best effort */ }
}

export function cacheGet(id, reqPath) {
  const dir = cacheDir(id);
  const key = cacheKey(reqPath);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    return { meta, file: path.join(dir, `${key}.bin`) };
  } catch { return null; }
}

export function cacheStats(id) {
  try {
    const files = fs.readdirSync(cacheDir(id)).filter(f => f.endsWith('.json'));
    let bytes = 0, newest = 0;
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(cacheDir(id), f), 'utf8'));
        bytes += m.size || 0; newest = Math.max(newest, m.ts || 0);
      } catch { /* skip */ }
    }
    return { entries: files.length, bytes, newest };
  } catch { return { entries: 0, bytes: 0, newest: 0 }; }
}

export function cacheClear(id) {
  try { fs.rmSync(cacheDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
}
