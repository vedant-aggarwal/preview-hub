#!/usr/bin/env node
// Preview hub: serves <public-url>/<id>/ for local servers, files and folders.
// Public listener (PUBLIC_PORT) is what the Cloudflare tunnel points at: dashboard needs login.
// Local listener (LOCAL_PORT, loopback only, never tunnelled) is trusted: the CLI and screenshots use it.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, loadConfig, saveConfig, DATA, DIRS, PUBLIC_PORT, LOCAL_PORT } from './store.js';
import {
  mimeOf, mediaKind, parseTtl, fmtDur, slugify, randomTag, parseCookies, escapeHtml, stripAnsi, hmac, safeEqual,
} from './util.js';
import { spawnCmd, killTree, pidAlive, imageName, tcpUp, bootTime, listenerPid, procStartTime } from './procs.js';
import { cachePut, cacheGet, cacheStats, cacheClear, ENTRY_LIMIT } from './cache.js';
import { rawCall } from './client.js';
import { createMcpServer, UPLOADS } from './mcp.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const IS_WIN = process.platform === 'win32';
const DEFAULT_TTL = { proxy: 4 * 36e5, static: 7 * 864e5 };
const RESERVED_IDS = new Set(['_hub', 'favicon.ico', 'robots.txt', 'api', 'login']);
const SESSION_DAYS = 365;

const store = new Store();
let cfg = loadConfig();
const health = new Map();      // id -> { up, at }
const children = new Map();    // id -> ChildProcess (only while this hub instance spawned it)
const starting = new Map();    // id -> promise of an in-flight start
const loginFails = new Map();  // ip -> [timestamps]
const bootedAt = Date.now();

const HUB_LOG = path.join(DIRS.logs, 'hub.log');
try { if (fs.statSync(HUB_LOG).size > 5e6) fs.renameSync(HUB_LOG, `${HUB_LOG}.1`); } catch { /* none yet */ }
const log = (...a) => {
  const line = [new Date().toISOString(), ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))].join(' ');
  try { fs.appendFileSync(HUB_LOG, `${line}\n`); } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line);
};

// ---------------------------------------------------------------- records

function logFile(id) { return path.join(DIRS.logs, `${id}.log`); }
function shotFile(id) { return path.join(DIRS.shots, `${id}.jpg`); }
// Public base URL (Cloudflare Tunnel, ngrok, ...). Before onboarding sets one, links point at this machine.
function baseUrl() { return cfg.publicBase || `http://localhost:${PUBLIC_PORT}`; }
function publicUrl(rec) { return `${baseUrl()}/${rec.id}${rec.entry || '/'}`; }

function statusOf(rec) {
  if (rec.stopped) return 'stopped';
  if (rec.kind === 'static') return fs.existsSync(rec.path) ? 'live' : 'down';
  const h = health.get(rec.id);
  if (h?.up) return 'live';
  const procUp = rec.pid && pidAlive(rec.pid);
  if ((procUp || starting.has(rec.id)) && Date.now() - (rec.spawnedAt || 0) < 180e3) return 'starting';
  return 'down';
}

function view(rec, detail = false) {
  const status = statusOf(rec);
  const now = Date.now();
  const v = {
    id: rec.id, name: rec.name, kind: rec.kind, status, url: publicUrl(rec),
    target: rec.target || null, path: rec.path || null, entry: rec.entry || '/',
    cmd: rec.cmd || null, cwd: rec.cwd || null, managed: !!rec.managed, private: !!rec.private,
    by: rec.by || null, note: rec.note || null,
    createdAt: rec.createdAt, startedAt: rec.startedAt || null, expiresAt: rec.expiresAt || null,
    stoppedAt: rec.stoppedAt || null, stopReason: rec.stopReason || null,
    ttl: rec.ttl, expiresIn: rec.expiresAt && !rec.stopped ? Math.max(0, rec.expiresAt - now) : null,
    hits: rec.hits || 0, lastHitAt: rec.lastHitAt || null, shotAt: rec.shotAt || null,
    pid: rec.pid && pidAlive(rec.pid) ? rec.pid : null,
    canStart: rec.kind === 'static' || !!rec.cmd || status !== 'down',
  };
  if (detail) v.snapshot = cacheStats(rec.id);
  return v;
}

function uniqueId(base) {
  const b = slugify(base) || 'preview';
  for (let i = 0; i < 20; i++) {
    const id = `${b}-${randomTag(4)}`;
    if (!store.get(id)) return id;
  }
  return `${b}-${randomTag(8)}`;
}

function normTarget(t) {
  if (t === undefined || t === null || t === '') return null;
  const s = String(t).trim();
  if (/^\d{2,5}$/.test(s)) return { target: `http://localhost:${s}`, entry: null };
  if (/^:\d{2,5}$/.test(s)) return { target: `http://localhost:${s.slice(1)}`, entry: null };
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/.test(s)) return normTarget(`http://${s}`);
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = 'localhost';
    if (u.protocol === 'https:') throw new Error('https targets are not supported; point at the plain http dev server');
    const port = Number(u.port || 80);
    if (port === PUBLIC_PORT || port === LOCAL_PORT) throw new Error('that is the hub itself');
    const entry = (u.pathname && u.pathname !== '/') || u.search ? `${u.pathname}${u.search}` : null;
    return { target: `http://${u.host}`, entry };
  }
  return null;
}

function targetHostPort(rec) {
  const u = new URL(rec.target);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80) };
}

async function isUp(rec) {
  if (rec.kind !== 'proxy' || !rec.target) return false;
  const { host, port } = targetHostPort(rec);
  const up = await tcpUp(host, port);
  const prev = health.get(rec.id);
  health.set(rec.id, { up, at: Date.now() });
  if (up && !prev?.up) onCameUp(rec);
  return up;
}

function onCameUp(rec) {
  if (!rec.shotAt || Date.now() - rec.shotAt > 10 * 6e4) setTimeout(() => takeShot(rec).catch(() => {}), 3500);
  if (rec.managed) recordPortOwner(rec).catch(() => {});
}

// Remember which process owns the server port, so stop can kill it even if its cmd.exe parent died.
async function recordPortOwner(rec) {
  if (!rec.target || !rec.spawnedAt) return;
  const { port } = targetHostPort(rec);
  const pid = await listenerPid(port);
  if (!pid || pid === rec.portPid) return;
  const started = await procStartTime(pid);
  if (started && started >= rec.spawnedAt - 3000) { rec.portPid = pid; store.save(); }
}

function findDuplicate(kind, target, filePath, cmd, cwd) {
  const same = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
  return store.all().find(r => {
    if (r.kind !== kind) return false;
    if (kind === 'static') return same(path.resolve(r.path), path.resolve(filePath));
    if (target && r.target) return same(r.target, target);
    return !target && cmd && same(r.cmd, cmd) && same(r.cwd, cwd);
  });
}

async function createPreview(b) {
  const now = Date.now();
  let kind, target = null, entry = null, filePath = null;
  const nt = normTarget(b.target);
  if (nt) { kind = 'proxy'; target = nt.target; entry = nt.entry; }
  else if (b.target && fs.existsSync(path.resolve(String(b.target)))) { kind = 'static'; filePath = path.resolve(String(b.target)); }
  else if (!b.target && b.cmd && b.start) kind = 'proxy';
  else if (b.target) throw httpErr(400, `target "${b.target}" is not a port, http URL or existing path`);
  else throw httpErr(400, 'give a target: a port, an http://localhost URL, or a file/folder path');
  if (b.entry) entry = String(b.entry).startsWith('/') ? String(b.entry) : `/${b.entry}`;

  const cwd = b.cwd ? path.resolve(String(b.cwd)) : null;
  if (cwd && !fs.existsSync(cwd)) throw httpErr(400, `cwd does not exist: ${cwd}`);
  if (b.start && !b.cmd) throw httpErr(400, '--start needs --cmd');
  let ttl;
  try { ttl = parseTtl(b.ttl); } catch (e) { throw httpErr(400, e.message); }

  if (!b.fresh) {
    const dup = findDuplicate(kind, target, filePath, b.cmd, cwd);
    if (dup) {
      if (b.name) dup.name = String(b.name);
      if (ttl !== undefined) dup.ttl = ttl;
      if (b.cmd) dup.cmd = String(b.cmd);
      if (cwd) dup.cwd = cwd;
      if (entry) dup.entry = entry;
      if (b.private !== undefined) dup.private = !!b.private;
      if (b.by) dup.by = String(b.by);
      if (dup.stopped || statusOf(dup) === 'down') {
        await startPreview(dup, { wait: b.wait });
        return { rec: dup, already: false, restarted: true };
      }
      if (ttl !== undefined) dup.expiresAt = dup.ttl ? now + dup.ttl : null;
      store.save();
      return { rec: dup, already: true };
    }
  }

  let id;
  if (b.id) {
    id = slugify(b.id);
    if (!id || RESERVED_IDS.has(id)) throw httpErr(400, `bad id "${b.id}"`);
    if (store.get(id)) throw httpErr(409, `id "${id}" already exists`);
  } else {
    const base = b.name || (filePath ? path.parse(filePath).name : cwd ? path.basename(cwd) : target ? `port-${new URL(target).port || 80}` : 'preview');
    id = uniqueId(base);
  }
  const name = b.name ? String(b.name) : (filePath ? path.basename(filePath) : cwd ? path.basename(cwd) : target ? `localhost:${new URL(target).port}` : id);
  if (ttl === undefined) ttl = DEFAULT_TTL[kind];

  const rec = {
    id, name, kind, target, entry, path: filePath, cmd: b.cmd ? String(b.cmd) : null, cwd,
    managed: false, pid: null, private: !!b.private, by: b.by ? String(b.by) : null, note: b.note ? String(b.note) : null,
    ttl, createdAt: now, startedAt: now, expiresAt: ttl ? now + ttl : null,
    stopped: false, stoppedAt: null, stopReason: null, hits: 0, lastHitAt: null, shotAt: null,
  };
  store.put(rec);
  log('create', id, kind, target || filePath || rec.cmd);

  if (kind === 'static') { setTimeout(() => takeShot(rec).catch(() => {}), 500); return { rec, already: false }; }
  if (b.start) {
    if (target && await isUp(rec)) return { rec, already: false, note: 'server already running on that port; not started again' };
    spawnFor(rec);
    if (b.wait) await waitLive(rec, Number(b.wait));
  } else if (target) {
    await isUp(rec);
  }
  return { rec, already: false };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function spawnFor(rec) {
  const file = logFile(rec.id);
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch { /* new */ }
  const env = {};
  if (rec.target) env.PORT = String(new URL(rec.target).port || '');
  const child = spawnCmd(rec.cmd, rec.cwd || os.homedir(), file, env);
  rec.pid = child.pid; rec.managed = true; rec.spawnedAt = Date.now();
  store.save();
  children.set(rec.id, child);
  child.on('exit', code => {
    if (children.get(rec.id) === child) children.delete(rec.id);
    try { fs.appendFileSync(file, `\n--- ${new Date().toISOString()} exit code ${code}\n`); } catch { /* ignore */ }
    if (rec.pid === child.pid) { rec.pid = null; rec.lastExit = { code, at: Date.now() }; store.save(); }
  });
  log('spawn', rec.id, child.pid, rec.cmd);
  if (!rec.target) detectPort(rec, file, offset);
  return child;
}

function detectPort(rec, file, offset) {
  const t0 = Date.now();
  const re = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):(\d{2,5})/i;
  const timer = setInterval(() => {
    if (rec.target || Date.now() - t0 > 120e3 || rec.stopped) return clearInterval(timer);
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size - offset, 256 * 1024);
      if (len > 0) { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, offset); text = stripAnsi(buf.toString('utf8')); }
      fs.closeSync(fd);
    } catch { return; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) {
        const port = Number(m[1]);
        if (port === PUBLIC_PORT || port === LOCAL_PORT) continue;
        rec.target = `http://localhost:${port}`;
        store.save();
        log('detected port', rec.id, port);
        isUp(rec);
        return clearInterval(timer);
      }
    }
  }, 600);
}

async function waitLive(rec, seconds = 60) {
  const until = Date.now() + Math.min(seconds, 300) * 1000;
  while (Date.now() < until) {
    if (rec.stopped) return false;
    if (rec.target && await isUp(rec)) return true;
    if (rec.managed && rec.pid === null && rec.lastExit && rec.lastExit.at > (rec.spawnedAt || 0)) return false;
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

async function startPreview(rec, { wait } = {}) {
  if (starting.has(rec.id)) return starting.get(rec.id);
  const p = (async () => {
    const now = Date.now();
    if (rec.kind === 'proxy') {
      const up = rec.target ? await isUp(rec) : false;
      if (!up && !rec.cmd) throw httpErr(409, 'server is not running and this preview has no start command; start it yourself or set one with `preview edit <id> --cmd "..." --cwd <dir>`');
      if (!up && !(rec.pid && pidAlive(rec.pid))) spawnFor(rec);
    }
    rec.stopped = false; rec.stoppedAt = null; rec.stopReason = null;
    rec.startedAt = now; rec.expiresAt = rec.ttl ? now + rec.ttl : null;
    store.save();
    log('start', rec.id);
    if (rec.kind === 'proxy' && wait) await waitLive(rec, Number(wait));
    return rec;
  })();
  starting.set(rec.id, p);
  try { return await p; } finally { starting.delete(rec.id); }
}

async function safeKill(rec) {
  let killed = false;
  const fromBeforeReboot = (rec.spawnedAt || 0) < bootTime() - 5000;
  const pid = rec.pid;
  if (pid && !fromBeforeReboot) {
    const img = await imageName(pid);
    const expected = IS_WIN ? 'cmd.exe' : null;
    if (img && (!expected || img === expected)) { await killTree(pid); killed = true; }
  }
  rec.pid = null;
  // The server process itself (node, python...) can outlive its cmd.exe parent. Kill the recorded
  // port owner too, but only if it is the same process (started after our spawn, still on that port).
  const owner = rec.portPid;
  rec.portPid = null;
  if (owner && !fromBeforeReboot && pidAlive(owner) && rec.target) {
    const { port } = targetHostPort(rec);
    const [onPort, started] = await Promise.all([listenerPid(port), procStartTime(owner)]);
    if (onPort === owner && started && started >= (rec.spawnedAt || 0) - 3000) { await killTree(owner); killed = true; }
  }
  return killed;
}

async function stopPreview(rec, reason = 'manual') {
  if (rec.stopped) return { already: true };
  if (rec.kind === 'proxy' && statusOf(rec) === 'live') {
    await Promise.race([takeShot(rec).catch(() => {}), new Promise(r => setTimeout(r, 30e3))]);
  }
  rec.stopped = true; rec.stoppedAt = Date.now(); rec.stopReason = reason;
  const killed = rec.managed ? await safeKill(rec) : false;
  health.delete(rec.id);
  store.save();
  log('stop', rec.id, reason, killed ? 'killed' : '');
  return { already: false, killed };
}

async function deletePreview(rec) {
  if (!rec.stopped) await stopPreview(rec, 'deleted');
  store.remove(rec.id);
  cacheClear(rec.id);
  for (const f of [shotFile(rec.id), logFile(rec.id)]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  // Content uploaded through MCP (preview_publish_content) lives in the hub's data folder; remove it with the preview.
  if (rec.kind === 'static' && rec.path) {
    const rel = path.relative(UPLOADS, path.resolve(rec.path));
    const top = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(/[\\/]/)[0] : null;
    const dir = top ? path.join(UPLOADS, top) : null;
    if (dir && !store.all().some(r => r.path && (path.resolve(r.path) === dir || path.resolve(r.path).startsWith(dir + path.sep)))) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  log('delete', rec.id);
}

async function editPreview(rec, b) {
  const changed = [];
  if (b.name !== undefined) { rec.name = String(b.name); changed.push('name'); }
  if (b.note !== undefined) { rec.note = b.note ? String(b.note) : null; changed.push('note'); }
  if (b.private !== undefined) { rec.private = b.private === true || b.private === 'true'; changed.push('private'); }
  if (b.ttl !== undefined) {
    let ttl; try { ttl = parseTtl(b.ttl); } catch (e) { throw httpErr(400, e.message); }
    rec.ttl = ttl; changed.push('ttl');
    if (!rec.stopped) rec.expiresAt = ttl ? Date.now() + ttl : null;
  }
  if (b.target !== undefined) {
    if (rec.kind === 'static') {
      const p = path.resolve(String(b.target));
      if (!fs.existsSync(p)) throw httpErr(400, `path does not exist: ${p}`);
      rec.path = p;
    } else {
      const nt = normTarget(b.target);
      if (!nt) throw httpErr(400, 'target must be a port or http://localhost URL');
      rec.target = nt.target; if (nt.entry) rec.entry = nt.entry;
      health.delete(rec.id);
    }
    changed.push('target');
  }
  if (b.entry !== undefined) { rec.entry = b.entry ? (String(b.entry).startsWith('/') ? String(b.entry) : `/${b.entry}`) : null; changed.push('entry'); }
  if (b.cmd !== undefined) { rec.cmd = b.cmd ? String(b.cmd) : null; changed.push('cmd'); }
  if (b.cwd !== undefined) {
    const c = b.cwd ? path.resolve(String(b.cwd)) : null;
    if (c && !fs.existsSync(c)) throw httpErr(400, `cwd does not exist: ${c}`);
    rec.cwd = c; changed.push('cwd');
  }
  store.save();
  return changed;
}

// ---------------------------------------------------------------- screenshots

const CHROME = [
  process.env.PREVIEW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
].find(p => p && fs.existsSync(p));
let shotChain = Promise.resolve();

function takeShot(rec) {
  const p = shotChain.then(() => doShot(rec));
  shotChain = p.catch(() => {});
  return p;
}

function doShot(rec) {
  return new Promise((resolve, reject) => {
    if (!CHROME) return reject(new Error('no chrome'));
    if (!store.get(rec.id)) return resolve(false);
    const tmp = path.join(DIRS.shots, `${rec.id}.new.jpg`);
    const profile = path.join(DIRS.run, `chrome-${randomTag(6)}`);
    const url = `http://127.0.0.1:${LOCAL_PORT}/${rec.id}${rec.entry || '/'}`;
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
      `--user-data-dir=${profile}`, '--window-size=1280,800', '--virtual-time-budget=7000', `--screenshot=${tmp}`, url,
    ];
    execFile(CHROME, args, { timeout: 45e3, windowsHide: true }, () => {
      fs.rm(profile, { recursive: true, force: true }, () => {});
      try {
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          fs.renameSync(tmp, shotFile(rec.id));
          rec.shotAt = Date.now();
          store.save();
          return resolve(true);
        }
      } catch (e) { return reject(e); }
      reject(new Error('screenshot failed'));
    });
  });
}

// ---------------------------------------------------------------- tunnel (cloudflared, token mode)

const tunnel = { status: 'not-configured', pid: null, restarts: 0, startedAt: null, logOffset: 0, child: null, backoff: 2000 };
const TUNNEL_LOG = path.join(DIRS.logs, 'tunnel.log');
const TUNNEL_PID = path.join(DIRS.run, 'cloudflared.pid');

function findCloudflared() {
  return [process.env.PREVIEW_CLOUDFLARED, 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'].filter(Boolean)
    .find(p => fs.existsSync(p)) || 'cloudflared';
}

async function killStaleTunnel() {
  let pid;
  try { pid = Number(fs.readFileSync(TUNNEL_PID, 'utf8').trim()); } catch { return; }
  if (!pid || !pidAlive(pid)) return;
  const img = await imageName(pid);
  if (img && img.startsWith('cloudflared')) { log('killing stale tunnel', pid); await killTree(pid); }
}

async function startTunnel() {
  if (!cfg.tunnelToken) { tunnel.status = 'not-configured'; return; }
  await killStaleTunnel();
  try { if (fs.statSync(TUNNEL_LOG).size > 5e6) fs.truncateSync(TUNNEL_LOG, 0); } catch { /* none */ }
  try { tunnel.logOffset = fs.statSync(TUNNEL_LOG).size; } catch { tunnel.logOffset = 0; }
  const fd = fs.openSync(TUNNEL_LOG, 'a');
  // Default protocol (QUIC, falls back to http2). Forcing http2 left silently dead connections on this network.
  // Silent failures are caught by publicProbe(), which restarts this process.
  const child = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', 'run'], {
    env: { ...process.env, TUNNEL_TOKEN: cfg.tunnelToken }, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  tunnel.child = child; tunnel.pid = child.pid; tunnel.status = 'starting'; tunnel.startedAt = Date.now();
  try { fs.writeFileSync(TUNNEL_PID, String(child.pid)); } catch { /* ignore */ }
  log('tunnel started', child.pid);
  child.on('exit', code => {
    log('tunnel exited', code);
    tunnel.status = 'down'; tunnel.pid = null; tunnel.child = null;
    if (shuttingDown) return;
    tunnel.restarts++;
    const wait = Date.now() - tunnel.startedAt > 120e3 ? 2000 : Math.min(tunnel.backoff *= 2, 60e3);
    setTimeout(startTunnel, wait);
  });
}

// End-to-end check: fetch our own public URL with a nonce and confirm this hub answered.
// cloudflared can keep "registered" connections that the edge already considers dead.
const probe = { fails: 0, lastOk: null, lastCheck: null, state: 'unknown' };
async function publicProbe() {
  if (!cfg.publicBase || (tunnel.child && Date.now() - (tunnel.startedAt || 0) < 45e3)) return;
  const n = randomTag(10);
  probe.lastCheck = Date.now();
  let ok = false;
  try {
    const r = await fetch(`${cfg.publicBase}/_hub/health?n=${n}`, { signal: AbortSignal.timeout(12e3), cache: 'no-store' });
    ok = r.ok && (await r.json()).n === n;
  } catch { ok = false; }
  if (ok) { probe.fails = 0; probe.lastOk = Date.now(); probe.state = 'ok'; return; }
  probe.fails++;
  probe.state = 'failing';
  log('public probe failed', probe.fails);
  if (probe.fails >= 3 && tunnel.child) {
    log('restarting tunnel after failed public probes');
    probe.fails = 0;
    tunnel.backoff = 1000;
    tunnel.startedAt = 0; // fast restart path in the exit handler
    tunnel.child.kill();
  }
}

function refreshTunnelStatus() {
  if (!tunnel.child) return;
  try {
    const fd = fs.openSync(TUNNEL_LOG, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size - tunnel.logOffset, 512 * 1024);
    let text = '';
    if (len > 0) { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); text = buf.toString('utf8'); }
    fs.closeSync(fd);
    const conns = new Map();
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/connIndex=(\d+)/);
      if (!m) continue;
      if (line.includes('Registered tunnel connection')) conns.set(m[1], true);
      else if (/Unregistered tunnel connection|Connection terminated|failed to serve tunnel connection/.test(line)) conns.set(m[1], false);
    }
    const up = [...conns.values()].filter(Boolean).length;
    tunnel.connections = up;
    if (up > 0) { tunnel.status = 'connected'; tunnel.backoff = 2000; }
    else if (conns.size) tunnel.status = 'reconnecting';
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- auth

function reqIp(req) {
  const sock = req.socket.remoteAddress || '?';
  if (req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip'];
  // ngrok and other tunnel agents connect from loopback and pass the visitor in X-Forwarded-For.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff && /^(127\.|::1$|::ffff:127\.)/.test(sock)) return xff;
  return sock;
}
function reqProto(req, trusted) {
  if (trusted) return 'http';
  const v = req.headers['cf-visitor'];
  if (v && v.includes('https')) return 'https';
  return req.headers['x-forwarded-proto'] === 'https' ? 'https' : (req.headers['cf-ray'] ? 'https' : 'http');
}

function sessionValue() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${hmac(cfg.secret, `s.${exp}.${cfg.sessionEpoch}`)}`;
}

function isAuthed(req, trusted) {
  if (trusted) return true;
  const v = parseCookies(req.headers.cookie).pvh_session;
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(cfg.secret, `s.${exp}.${cfg.sessionEpoch}`));
}

function sessionCookie(ctx, value, maxAge) {
  return `pvh_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${ctx.proto === 'https' ? '; Secure' : ''}`;
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) || []).filter(t => now - t < 15 * 6e4);
  loginFails.set(ip, arr);
  return arr.length >= 8;
}

function createMagic(ttlMs = 24 * 36e5) {
  const token = crypto.randomBytes(18).toString('base64url');
  cfg.magic = (cfg.magic || []).filter(m => m.exp > Date.now());
  cfg.magic.push({ hash: hmac(cfg.secret, `m.${token}`), exp: Date.now() + ttlMs });
  saveConfig(cfg);
  return { url: `${baseUrl()}/_hub/magic?t=${token}`, expiresIn: ttlMs };
}

function useMagic(token) {
  const h = hmac(cfg.secret, `m.${token}`);
  const i = (cfg.magic || []).findIndex(m => m.hash === h && m.exp > Date.now());
  if (i < 0) return false;
  cfg.magic.splice(i, 1);
  saveConfig(cfg);
  return true;
}

// ---------------------------------------------------------------- small responders

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}
function redirect(res, to, status = 302, headers = {}) { res.writeHead(status, { location: to, 'cache-control': 'no-store', ...headers }); res.end(); }

// Shared <head> bits for hub-made pages (message pages, viewer, folder listing).
const FONT_LINKS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&display=swap">';
const THEME_META = '<meta name="theme-color" content="#f7f9fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1a1e21" media="(prefers-color-scheme: dark)">';

function page(title, inner, { status = 200, headers = {} } = {}) {
  return [status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">${THEME_META}<title>${escapeHtml(title)}</title><link rel="icon" href="/_hub/ui/favicon.svg">${FONT_LINKS}<link rel="stylesheet" href="/_hub/ui/page.css"></head>
<body class="msg"><main><img class="mark" src="/_hub/ui/favicon.svg" alt="" width="44" height="44">${inner}</main></body></html>`, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }];
}
function sendPage(res, title, inner, opts) { const [s, b, h] = page(title, inner, opts); send(res, s, b, h); }

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpErr(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isNavigation(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document' || dest === 'iframe';
  return (req.headers.accept || '').includes('text/html');
}
function isVitePing(req) { return (req.headers.accept || '').includes('text/x-vite-ping'); }

function ctxCookie(id) { return `pvh_ctx=${id}; Path=/; SameSite=Lax`; }

function recFromReferer(req) {
  const r = req.headers.referer;
  if (!r) return null;
  try {
    const u = new URL(r);
    if (u.host !== req.headers.host) return null;
    const seg = u.pathname.split('/')[1];
    return seg ? store.get(seg) || null : null;
  } catch { return null; }
}
function recFromCookie(req) {
  const id = parseCookies(req.headers.cookie).pvh_ctx;
  return id ? store.get(id) || null : null;
}

function countHit(rec, ctx, req) {
  if (ctx.trusted || !isNavigation(req)) return;
  rec.hits = (rec.hits || 0) + 1; rec.lastHitAt = Date.now(); store.save();
}

// ---------------------------------------------------------------- serving previews

async function servePreview(rec, reqPath, req, res, ctx, prefixed) {
  if (rec.private && !ctx.authed) {
    if (isNavigation(req)) return redirect(res, `/_hub/login?next=${encodeURIComponent(req.url)}`);
    return sendJson(res, 401, { error: 'private preview; log in first' });
  }
  countHit(rec, ctx, req);
  if (rec.kind === 'static') return serveStatic(rec, reqPath, req, res, prefixed);
  const status = statusOf(rec);
  if (status === 'stopped' || !rec.target) return serveSnapshot(rec, reqPath, req, res, ctx, status);
  return proxyHttp(rec, reqPath, req, res, ctx);
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'];

function stripHubCookies(cookie) {
  if (!cookie) return cookie;
  const kept = String(cookie).split(';').map(s => s.trim()).filter(s => s && !s.startsWith('pvh_'));
  return kept.length ? kept.join('; ') : undefined;
}

function rewriteLocation(loc, rec, t) {
  if (!loc) return loc;
  try {
    if (loc.startsWith('/') && !loc.startsWith('//')) return `/${rec.id}${loc}`;
    const u = new URL(loc);
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(u.hostname);
    if (local && (u.port || '80') === (t.port || '80')) return `/${rec.id}${u.pathname}${u.search}${u.hash}`;
  } catch { /* leave */ }
  return loc;
}

function proxyHttp(rec, reqPath, req, res, ctx) {
  const t = new URL(rec.target);
  const headers = { ...req.headers };
  for (const h of HOP) delete headers[h];
  headers.host = t.host;
  if (headers.origin) headers.origin = t.origin;
  if (headers.referer) {
    try {
      const r = new URL(headers.referer);
      let p = r.pathname;
      if (p === `/${rec.id}` || p.startsWith(`/${rec.id}/`)) p = p.slice(rec.id.length + 1) || '/';
      headers.referer = `${t.origin}${p}${r.search}`;
    } catch { delete headers.referer; }
  }
  const ck = stripHubCookies(headers.cookie);
  if (ck) headers.cookie = ck; else delete headers.cookie;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = ctx.proto;
  headers['x-forwarded-prefix'] = `/${rec.id}`;

  const preq = http.request({
    hostname: t.hostname.replace(/^\[|\]$/g, ''), port: t.port || 80, method: req.method, path: reqPath || '/', headers,
  }, pres => {
    const h = { ...pres.headers };
    for (const k of [...HOP, 'transfer-encoding']) delete h[k];
    if (h.location) h.location = rewriteLocation(h.location, rec, t);
    let cookies = [].concat(h['set-cookie'] || []).map(c => c.replace(/;\s*domain=[^;]*/i, ''));
    const ctype = String(h['content-type'] || '');
    const nav = isNavigation(req) && ctype.includes('text/html');
    if (nav) cookies.push(ctxCookie(rec.id));
    if (cookies.length) h['set-cookie'] = cookies; else delete h['set-cookie'];

    const cacheable = req.method === 'GET' && pres.statusCode === 200 && !req.headers.range
      && !ctype.includes('text/event-stream') && !isVitePing(req)
      && !(Number(h['content-length']) > ENTRY_LIMIT);
    res.writeHead(pres.statusCode, pres.statusMessage, h);
    if (cacheable) {
      const chunks = []; let size = 0, over = false;
      pres.on('data', c => { if (over) return; size += c.length; if (size > ENTRY_LIMIT) { over = true; chunks.length = 0; } else chunks.push(c); });
      pres.on('end', () => { if (!over) cachePut(rec.id, reqPath, 200, h, Buffer.concat(chunks)); });
    }
    pres.pipe(res);
  });
  preq.on('error', err => {
    health.set(rec.id, { up: false, at: Date.now() });
    if (res.headersSent) return res.destroy();
    serveSnapshot(rec, reqPath, req, res, ctx, statusOf(rec), err.code);
  });
  res.on('close', () => { if (!res.writableFinished) preq.destroy(); });
  req.pipe(preq);
}

function snapshotBanner(rec, status) {
  const since = rec.stoppedAt ? `${fmtDur(Date.now() - rec.stoppedAt)} ago` : '';
  const label = status === 'stopped' ? `Stopped ${since}` : status === 'starting' ? 'Starting…' : 'Server down';
  const canStart = !!rec.cmd || status !== 'down';
  const id = escapeHtml(rec.id);
  const tone = status === 'stopped' ? 'stopped' : status === 'starting' ? 'starting' : 'down';
  return `<div id="__pvh_banner"></div><script>(function(){var host=document.getElementById('__pvh_banner');if(!host||!host.attachShadow)return;
var r=host.attachShadow({mode:'open'});r.innerHTML='<style>:host{all:initial}*{box-sizing:border-box}.b{position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:12px;width:max-content;max-width:calc(100vw - 24px);padding:8px 8px 8px 16px;border-radius:16px;background:#1d2226;color:#eef1f3;font:500 14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 0 0 1px rgba(255,255,255,.09) inset,0 14px 36px rgba(0,0,0,.38);-webkit-font-smoothing:antialiased}.d{flex:none;width:9px;height:9px;border-radius:50%}.d.stopped{box-shadow:inset 0 0 0 1.6px #a3abb0}.d.down{background:#fe6c66}.d.starting{background:#fabb41;animation:k 1.1s linear infinite}@keyframes k{0%,49%{opacity:1}50%,100%{opacity:.3}}.t{display:flex;flex-direction:column;min-width:0}.t b{font-weight:650}.t span{overflow:hidden;color:#a9b2b7;font-size:12.5px;white-space:nowrap;text-overflow:ellipsis}.acts{display:flex;gap:6px;flex:none}button,a{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 14px;border-radius:11px;font:650 14px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;cursor:pointer}#s{background:#62d286;color:#081b0e}#s:hover{background:#7ddb9b}#s[disabled]{opacity:.65;cursor:default}a{color:#d9dee1}a:hover{background:rgba(255,255,255,.08);color:#fff}.x{width:40px;padding:0;color:#a9b2b7}.x:hover{background:rgba(255,255,255,.08);color:#fff}.x svg{width:18px;height:18px}button:focus-visible,a:focus-visible{outline:2px solid #62d286;outline-offset:2px}@media (max-width:520px){.b{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"d t x" "a a a";row-gap:10px;left:12px;right:12px;width:auto;max-width:none;transform:none;padding:12px 8px 8px 16px}.d{grid-area:d}.t{grid-area:t}.x{grid-area:x;margin:-4px 0}.acts{grid-area:a;margin-left:-8px}.acts>*{flex:1}}@media (prefers-reduced-motion:reduce){.d.starting{animation:none}}</style><div class=b role=region aria-label="Snapshot notice"><span class="d ${tone}"></span><span class=t><b>Snapshot</b><span>${escapeHtml(label)}</span></span><span class=acts>${canStart ? '<button id=s type=button>Start server</button>' : ''}<a href="/">All previews</a></span><button class=x type=button aria-label="Hide this notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
r.querySelector('.x').onclick=function(){host.remove()};
var b=r.getElementById('s');if(!b)return;b.onclick=function(){b.disabled=true;b.textContent='Starting…';fetch('/_hub/api/previews/${id}/start',{method:'POST',headers:{'x-hub':'1','content-type':'application/json'},body:'{}',credentials:'same-origin'}).then(function(x){if(x.status===401){location.href='/_hub/login?next='+encodeURIComponent(location.pathname+location.search);return}
var n=0;(function poll(){fetch('/_hub/api/previews/${id}',{credentials:'same-origin',cache:'no-store'}).then(function(x){return x.json()}).then(function(j){if(j.preview&&j.preview.status==='live'){location.reload();return}if(++n>120){b.textContent='Still starting… check logs';return}setTimeout(poll,1000)})})()}).catch(function(){b.disabled=false;b.textContent='Retry'})}})();</script>`;
}

function decodeBody(buf, enc) {
  enc = String(enc || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  if (enc === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
  return buf;
}

function serveSnapshot(rec, reqPath, req, res, ctx, status, errCode) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 503, { error: `preview ${status}; snapshot is read-only` });
  if (isVitePing(req)) return send(res, 503, 'down');
  const nav = isNavigation(req);
  const pathOnly = (reqPath || '/').split('?')[0];
  let hit = cacheGet(rec.id, reqPath) || cacheGet(rec.id, pathOnly);
  if (!hit && nav) hit = cacheGet(rec.id, rec.entry || '/') || cacheGet(rec.id, '/') || cacheGet(rec.id, '/index.html');
  const extra = { 'cache-control': 'no-store', 'x-preview-snapshot': '1' };
  if (nav) extra['set-cookie'] = ctxCookie(rec.id);
  if (!hit) {
    if (!nav) return send(res, 404, 'not in snapshot', { 'content-type': 'text/plain; charset=utf-8', ...extra });
    const msg = status === 'stopped' ? 'This preview is stopped' : status === 'starting' ? 'Server is starting' : 'Server is not reachable';
    const tone = status === 'stopped' ? 'stopped' : status === 'starting' ? 'starting' : 'down';
    const startBtn = rec.cmd || status !== 'down'
      ? `<button class="btn go" id="start">Start server</button>` : '';
    return sendPage(res, `${rec.name} (${status})`, `<p class="ctx"><span class="led ${tone}"></span>${escapeHtml(rec.name)}</p><h1>${msg}</h1>
<p>No snapshot of this page was saved yet${errCode ? ` <span class="mono">(${escapeHtml(errCode)})</span>` : ''}.</p>
<div class="actions">${startBtn}<a class="btn" href="/">All previews</a></div>
<script>var b=document.getElementById('start');if(b)b.onclick=function(){b.disabled=true;b.textContent='Starting…';fetch('/_hub/api/previews/${escapeHtml(rec.id)}/start',{method:'POST',headers:{'x-hub':'1','content-type':'application/json'},body:'{}'}).then(function(x){if(x.status===401){location.href='/_hub/login?next='+encodeURIComponent(location.pathname);return}setTimeout(function(){location.reload()},6000)})};${status === 'starting' ? 'setTimeout(function(){location.reload()},3000);' : ''}</script>`,
    { status: 503, headers: extra });
  }
  const headers = { ...hit.meta.headers, ...extra };
  const ctype = String(headers['content-type'] || '');
  if (nav && ctype.includes('text/html')) {
    let html;
    try { html = decodeBody(fs.readFileSync(hit.file), headers['content-encoding']).toString('utf8'); } catch { html = ''; }
    delete headers['content-encoding'];
    const banner = snapshotBanner(rec, status);
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${banner}</body>`) : html + banner;
    return send(res, 200, req.method === 'HEAD' ? '' : html, headers);
  }
  const size = fs.statSync(hit.file).size;
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(hit.file).pipe(res);
}

// static files and folders

function sendFile(req, res, file, stat, extraHeaders = {}) {
  const type = mimeOf(file);
  const base = {
    'content-type': type, 'accept-ranges': 'bytes', 'last-modified': stat.mtime.toUTCString(),
    'cache-control': 'no-cache', ...extraHeaders,
  };
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN, end = m[2] ? Number(m[2]) : NaN;
      if (Number.isNaN(start)) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end();
      }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, { ...base, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

// Line icons for hub-made pages (24px grid, stroke drawn by .i in page.css).
const PAGE_ICON = {
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M16 10.5l4.5-2.7v8.4L16 13.5"/>',
  audio: '<path d="M9 18V6l10.5-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/>',
  html: '<path d="M8.5 8l-4 4 4 4"/><path d="M15.5 8l4 4-4 4"/><path d="M13.2 5.5l-2.4 13"/>',
  text: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6M9 16.5h4"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/>',
};
PAGE_ICON.pdf = PAGE_ICON.text;
const pageIcon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PAGE_ICON[name] || PAGE_ICON.file}</svg>`;

function viewerPage(rec, fileName, stat) {
  const k = mediaKind(fileName);
  const src = encodeURIComponent(fileName);
  let media;
  // #t=0.1 makes phones (and the dashboard screenshot) show the first frame instead of a black box
  if (k === 'video') media = `<video src="${src}#t=0.1" controls playsinline preload="metadata"></video>`;
  else if (k === 'image') media = `<img src="${src}" alt="${escapeHtml(fileName)}">`;
  else if (k === 'audio') media = `<audio src="${src}" controls preload="metadata"></audio>`;
  else if (k === 'pdf') media = `<iframe src="${src}" title="${escapeHtml(fileName)}"></iframe>`;
  else if (k === 'text') {
    let text = '';
    try { const fd = fs.openSync(path.join(rec.path), 'r'); const buf = Buffer.alloc(Math.min(stat.size, 512 * 1024)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); text = buf.toString('utf8'); } catch { /* ignore */ }
    media = `<pre>${escapeHtml(text)}${stat.size > 512 * 1024 ? '\n…' : ''}</pre>`;
  } else media = `<p class="muted">No inline preview for this file type.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${k === 'text' ? THEME_META : '<meta name="theme-color" content="#1c2023">'}<title>${escapeHtml(rec.name)}</title><link rel="icon" href="/_hub/ui/favicon.svg">${FONT_LINKS}<link rel="stylesheet" href="/_hub/ui/page.css"></head>
<body class="viewer k-${k}"><header class="vbar">${pageIcon(k, 'i ficon')}<span class="name">${escapeHtml(fileName)}</span><span class="size">${fmtBytes(stat.size)}</span>
<a class="btn" href="${src}" download aria-label="Download ${escapeHtml(fileName)}">${pageIcon('download')}<span>Download</span></a></header><main>${media}</main></body></html>`;
}

function listingPage(rec, dir, urlBase, rel) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* ignore */ }
  entries = entries.filter(e => !e.name.startsWith('.') && e.name !== 'desktop.ini' && e.name !== 'Thumbs.db')
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const items = entries.map(e => {
    const href = encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
    let st = null; try { st = fs.statSync(path.join(dir, e.name)); } catch { /* ignore */ }
    const k = e.isDirectory() ? 'dir' : mediaKind(e.name);
    let thumb;
    if (k === 'image') thumb = `<img loading="lazy" src="${href}" alt="">`;
    else if (k === 'video') thumb = `<video preload="metadata" muted playsinline src="${href}#t=0.5"></video><span class="play">${pageIcon('play', 'f')}</span>`;
    else {
      const ext = path.extname(e.name).slice(1, 5).toUpperCase();
      thumb = `<span class="ico">${pageIcon(k === 'dir' ? 'folder' : k)}${k === 'dir' ? '' : `<b>${escapeHtml(ext || 'FILE')}</b>`}</span>`;
    }
    return `<a class="tile k-${k}" href="${href}"><span class="th">${thumb}</span><span class="nm">${escapeHtml(e.name)}</span><span class="sz">${e.isDirectory() ? 'Folder' : st ? fmtBytes(st.size) : ''}</span></a>`;
  }).join('');
  const crumbs = rel === '/' ? escapeHtml(rec.name)
    : `<a href="${urlBase}/">${escapeHtml(rec.name)}</a><span class="sep">/</span>${escapeHtml(decodeURIComponent(rel.replace(/^\/|\/$/g, ''))).replace(/\//g, '<span class="sep">/</span>')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${THEME_META}<title>${escapeHtml(rec.name)}</title><link rel="icon" href="/_hub/ui/favicon.svg">${FONT_LINKS}<link rel="stylesheet" href="/_hub/ui/page.css"></head>
<body class="listing"><header class="lbar">${pageIcon('folder', 'i ficon')}<span class="crumbs">${crumbs}</span><span class="count">${entries.length} ${entries.length === 1 ? 'item' : 'items'}</span></header>
<main class="grid">${items || '<p class="muted">This folder is empty.</p>'}</main></body></html>`;
}

function serveStatic(rec, reqPath, req, res, prefixed) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'read only');
  let st;
  try { st = fs.statSync(rec.path); } catch { return sendPage(res, 'Missing', `<h1>File is gone</h1><p class="mono">${escapeHtml(rec.path)}</p><a class="btn" href="/">All previews</a>`, { status: 404 }); }
  const urlBase = prefixed ? `/${rec.id}` : '';
  let rel;
  try { rel = decodeURIComponent((reqPath || '/').split('?')[0]); } catch { return send(res, 400, 'bad path'); }
  const nav = isNavigation(req);
  const ctx = nav ? { 'set-cookie': ctxCookie(rec.id) } : {};
  if (st.isFile()) {
    const fileName = path.basename(rec.path);
    if (rel === '/' || rel === '') {
      const k = mediaKind(fileName);
      if (k === 'html' || k === 'file') return sendFile(req, res, rec.path, st, ctx);
      return send(res, 200, viewerPage(rec, fileName, st), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...ctx });
    }
    if (rel === `/${fileName}` || rel === '/raw') return sendFile(req, res, rec.path, st);
    // html file referencing siblings: serve from the same folder
    const sib = path.resolve(path.dirname(rec.path), `.${rel}`);
    if (sib.startsWith(path.dirname(rec.path) + path.sep) && fs.existsSync(sib) && fs.statSync(sib).isFile()) return sendFile(req, res, sib, fs.statSync(sib));
    return send(res, 404, 'not found');
  }
  const root = path.resolve(rec.path);
  const target = path.resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + path.sep)) return send(res, 403, 'forbidden');
  let tst;
  try { tst = fs.statSync(target); } catch {
    if (nav && fs.existsSync(path.join(root, 'index.html')) && !path.extname(rel)) return sendFile(req, res, path.join(root, 'index.html'), fs.statSync(path.join(root, 'index.html')), ctx);
    return send(res, 404, 'not found');
  }
  if (tst.isDirectory()) {
    if (!rel.endsWith('/')) return redirect(res, `${urlBase}${encodeURI(rel)}/`);
    const idx = path.join(target, 'index.html');
    if (fs.existsSync(idx)) return sendFile(req, res, idx, fs.statSync(idx), ctx);
    return send(res, 200, listingPage(rec, target, urlBase, rel), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...ctx });
  }
  return sendFile(req, res, target, tst, ctx);
}

// ---------------------------------------------------------------- websocket upgrade

function handleUpgrade(req, socket, head, trusted) {
  socket.on('error', () => socket.destroy());
  const u = new URL(req.url, 'http://hub');
  const ctx = { trusted, proto: reqProto(req, trusted), authed: isAuthed(req, trusted) };
  let rec = null, rest = u.pathname + u.search;
  const seg = u.pathname.split('/')[1];
  if (seg && seg !== '_hub' && store.get(seg)) { rec = store.get(seg); rest = (u.pathname.slice(seg.length + 1) || '/') + u.search; }
  else if (seg !== '_hub') rec = recFromReferer(req) || recFromCookie(req);
  const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); };
  if (!rec) return reject('404 Not Found');
  if (rec.private && !ctx.authed) return reject('401 Unauthorized');
  if (rec.kind !== 'proxy' || statusOf(rec) === 'stopped' || !rec.target) return reject('503 Service Unavailable');
  const t = new URL(rec.target);
  const up = net.connect({ host: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port || 80), autoSelectFamily: true });
  up.on('error', () => { reject('502 Bad Gateway'); up.destroy(); });
  up.on('connect', () => {
    const lines = [`${req.method} ${rest} HTTP/1.1`];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i], kl = k.toLowerCase();
      let v = raw[i + 1];
      if (kl === 'host') v = t.host;
      else if (kl === 'origin') v = t.origin;
      else if (kl === 'cookie') { v = stripHubCookies(v); if (!v) continue; }
      lines.push(`${k}: ${v}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
}

// ---------------------------------------------------------------- hub routes + API

const UI_FILES = new Set(['index.html', 'app.js', 'app.css', 'page.css', 'login.html', 'favicon.svg']);

function serveUi(res, name, extra = {}) {
  if (!UI_FILES.has(name)) return send(res, 404, 'not found');
  const file = path.join(UI_DIR, name);
  let buf;
  try { buf = fs.readFileSync(file); } catch { return send(res, 404, 'not found'); }
  if (name.endsWith('.html')) {
    // cache-bust assets by mtime so phones never run a stale dashboard
    buf = Buffer.from(buf.toString('utf8').replace(/\/_hub\/ui\/([\w.-]+\.(?:css|js|svg))"/g, (m, f) => {
      let v = VERSION; try { v = String(Math.floor(fs.statSync(path.join(UI_DIR, f)).mtimeMs)); } catch { /* keep */ }
      return `/_hub/ui/${f}?v=${v}"`;
    }));
  }
  send(res, 200, buf, { 'content-type': mimeOf(file), 'cache-control': 'no-cache', ...extra });
}

function hubState() {
  const list = store.all().map(r => view(r));
  const order = { live: 0, starting: 1, down: 2, stopped: 3 };
  list.sort((a, b) => (order[a.status] - order[b.status]) || ((b.stoppedAt || b.createdAt) - (a.stoppedAt || a.createdAt)));
  return {
    hub: {
      version: VERSION, publicBase: baseUrl(), publicConfigured: !!cfg.publicBase, uptime: Date.now() - bootedAt,
      tunnel: {
        status: cfg.tunnelVia ? (probe.state === 'failing' ? 'unreachable' : probe.state === 'ok' ? 'connected' : 'checking')
          : probe.state === 'failing' && tunnel.status === 'connected' ? 'unreachable' : tunnel.status,
        via: cfg.tunnelVia || (cfg.tunnelToken ? 'cloudflared (hub-run)' : null),
        connections: tunnel.connections || 0, restarts: tunnel.restarts, publicCheck: probe.state, lastPublicOk: probe.lastOk,
      },
      chrome: !!CHROME,
    },
    counts: list.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; a.total++; return a; }, { total: 0 }),
    previews: list,
  };
}

function tailFile(file, lines = 80) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return stripAnsi(buf.toString('utf8')).split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
}

async function apiRoute(req, res, u, ctx) {
  const parts = u.pathname.replace(/^\/_hub\/api\/?/, '').split('/').filter(Boolean);
  const m = req.method;
  const body = async () => {
    const raw = await readBody(req);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw httpErr(400, 'body must be JSON'); }
  };
  const needRec = () => {
    const rec = store.get(parts[1]);
    if (!rec) throw httpErr(404, `no preview "${parts[1]}"`);
    return rec;
  };

  if (parts[0] === 'state' && m === 'GET') return sendJson(res, 200, hubState());
  if (parts[0] === 'magic' && m === 'POST') {
    const b = await body();
    let ttl = 24 * 36e5;
    if (b.ttl) { try { ttl = parseTtl(b.ttl) || ttl; } catch (e) { throw httpErr(400, e.message); } }
    return sendJson(res, 200, createMagic(ttl));
  }
  if (parts[0] === 'passcode') {
    if (!ctx.trusted) throw httpErr(403, 'passcode is only readable from this PC');
    if (m === 'GET') return sendJson(res, 200, { passcode: cfg.passcode });
    if (m === 'POST') {
      const b = await body();
      const pc = String(b.passcode || '').trim();
      if (pc.length < 6) throw httpErr(400, 'passcode must be at least 6 characters');
      cfg.passcode = pc; cfg.sessionEpoch = (cfg.sessionEpoch || 1) + 1; saveConfig(cfg);
      return sendJson(res, 200, { ok: true, loggedOut: 'all browser sessions' });
    }
  }
  if (parts[0] === 'tunnel' && m === 'POST') {
    if (!ctx.trusted) throw httpErr(403, 'local only');
    const b = await body();
    if (b.token !== undefined) { cfg.tunnelToken = b.token || null; if (b.token) cfg.tunnelVia = null; }
    if (b.publicBase !== undefined) {
      if (!b.publicBase || b.publicBase === 'none') cfg.publicBase = null;
      else {
        let u; try { u = new URL(String(b.publicBase)); } catch { throw httpErr(400, `bad public URL "${b.publicBase}"`); }
        if (!/^https?:$/.test(u.protocol) || (u.pathname !== '/' && u.pathname !== '')) throw httpErr(400, 'public URL must be an origin like https://preview.example.com (no path)');
        cfg.publicBase = u.origin;
      }
    }
    if (b.via !== undefined) cfg.tunnelVia = b.via ? String(b.via).slice(0, 20) : null;
    probe.state = 'unknown'; probe.fails = 0;
    saveConfig(cfg);
    setTimeout(() => publicProbe().catch(() => {}), 1500);
    if (tunnel.child) { tunnel.child.removeAllListeners('exit'); tunnel.child.kill(); tunnel.child = null; }
    await startTunnel();
    return sendJson(res, 200, { tunnel: tunnel.status, publicBase: cfg.publicBase, via: cfg.tunnelVia || (cfg.tunnelToken ? 'cloudflared (hub-run)' : null) });
  }
  if (parts[0] === 'mcp') {
    if (!ctx.trusted) throw httpErr(403, 'MCP tokens are managed from this PC only');
    if (parts.length === 1 && m === 'GET') return sendJson(res, 200, mcpInfo());
    if (parts[1] === 'tokens' && parts.length === 2 && m === 'POST') {
      const b = await body();
      const name = slugify(b.name || '');
      if (!name) throw httpErr(400, 'give the token a name, e.g. grok');
      const token = `pvm_${crypto.randomBytes(24).toString('base64url')}`;
      cfg.mcpTokens = (cfg.mcpTokens || []).filter(t => t.name !== name);
      cfg.mcpTokens.push({ name, hash: hmac(cfg.secret, `mcp.${token}`), createdAt: Date.now(), lastUsedAt: null });
      saveConfig(cfg);
      mcpRemote.delete(name);
      log('mcp token', name, 'created');
      return sendJson(res, 201, { name, token, url: `${baseUrl()}/_hub/mcp/${token}`, endpoint: `${baseUrl()}/_hub/mcp`, publicConfigured: !!cfg.publicBase });
    }
    if (parts[1] === 'tokens' && parts[2] && m === 'DELETE') {
      const before = (cfg.mcpTokens || []).length;
      cfg.mcpTokens = (cfg.mcpTokens || []).filter(t => t.name !== parts[2]);
      if (cfg.mcpTokens.length === before) throw httpErr(404, `no MCP token named "${parts[2]}"`);
      saveConfig(cfg);
      mcpRemote.delete(parts[2]);
      log('mcp token', parts[2], 'revoked');
      return sendJson(res, 200, { revoked: parts[2] });
    }
    throw httpErr(404, 'unknown api route');
  }
  if (parts[0] !== 'previews') throw httpErr(404, 'unknown api route');

  if (parts.length === 1) {
    if (m === 'GET') return sendJson(res, 200, hubState());
    if (m === 'POST') {
      const b = await body();
      if (!ctx.trusted && b.cmd) {
        if (!safeEqual(String(b.passcode || ''), cfg.passcode)) throw httpErr(403, 'creating a preview with a start command from the web needs the passcode');
      }
      const r = await createPreview(b);
      return sendJson(res, r.already ? 200 : 201, { preview: view(r.rec, true), already: !!r.already, restarted: !!r.restarted, note: r.note || null });
    }
  }
  const rec = needRec();
  const action = parts[2];
  if (!action) {
    if (m === 'GET') {
      if (rec.kind === 'proxy' && !rec.stopped && rec.target) await isUp(rec);
      return sendJson(res, 200, { preview: view(rec, true) });
    }
    if (m === 'PATCH') {
      const b = await body();
      if (!ctx.trusted && (b.cmd !== undefined || b.cwd !== undefined)) {
        if (!safeEqual(String(b.passcode || ''), cfg.passcode)) throw httpErr(403, 'changing the start command or folder from the web needs the passcode');
      }
      const changed = await editPreview(rec, b);
      return sendJson(res, 200, { preview: view(rec, true), changed });
    }
    if (m === 'DELETE') { await deletePreview(rec); return sendJson(res, 200, { deleted: rec.id }); }
  }
  if (m === 'POST' && action === 'stop') { const r = await stopPreview(rec, 'manual'); return sendJson(res, 200, { preview: view(rec), ...r }); }
  if (m === 'POST' && action === 'start') {
    const b = await body();
    if (!rec.stopped && statusOf(rec) === 'live') return sendJson(res, 200, { preview: view(rec), already: true });
    await startPreview(rec, { wait: b.wait });
    return sendJson(res, 200, { preview: view(rec), already: false });
  }
  if (m === 'POST' && action === 'restart') {
    const b = await body();
    if (rec.kind === 'proxy' && rec.managed && rec.pid) await safeKill(rec);
    if (rec.kind === 'proxy' && rec.managed) health.delete(rec.id);
    const wasStopped = rec.stopped;
    await new Promise(r => setTimeout(r, 800));
    try { await startPreview(rec, { wait: b.wait }); } catch (e) { rec.stopped = wasStopped; throw e; }
    return sendJson(res, 200, { preview: view(rec) });
  }
  if (m === 'POST' && action === 'shot') {
    const ok = await takeShot(rec).catch(e => { throw httpErr(500, e.message); });
    return sendJson(res, 200, { preview: view(rec), shot: ok });
  }
  if (m === 'GET' && action === 'logs') {
    const n = Math.min(Number(u.searchParams.get('lines') || 80), 2000);
    return sendJson(res, 200, { id: rec.id, log: tailFile(logFile(rec.id), n) });
  }
  throw httpErr(404, 'unknown api route');
}

// ---------------------------------------------------------------- MCP over HTTP
// Stateless Streamable HTTP: every POST carries JSON-RPC and gets a JSON reply; no SSE stream, no sessions.
// Public listener: a named token is required (path /_hub/mcp/<token>, Authorization: Bearer, or ?key=), and
// the tools run with remote-safe limits. Loopback listener without a token: full access, like the CLI.

const mcpLocal = createMcpServer({ call: rawCall, remote: false, log: (...a) => log('mcp local', ...a) });
const mcpRemote = new Map(); // token name -> handler
const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
};

function mcpInfo() {
  return {
    endpoint: `${baseUrl()}/_hub/mcp`,
    publicConfigured: !!cfg.publicBase,
    local: `http://127.0.0.1:${LOCAL_PORT}/_hub/mcp`,
    tokens: (cfg.mcpTokens || []).map(t => ({ name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
  };
}

function mcpReply(res, status, obj, extra = {}) {
  const headers = { ...MCP_CORS, 'cache-control': 'no-store', ...extra };
  if (obj === undefined) { res.writeHead(status, headers); return res.end(); }
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

async function mcpRoute(req, res, u, ctx) {
  if (req.method === 'OPTIONS') return mcpReply(res, 204);
  let pathTok = '';
  try { pathTok = decodeURIComponent(u.pathname.slice('/_hub/mcp'.length).split('/').filter(Boolean)[0] || ''); } catch { /* bad escape */ }
  const bearer = (String(req.headers.authorization || '').match(/^Bearer\s+(\S+)/i) || [])[1];
  const raw = pathTok || bearer || u.searchParams.get('key') || '';
  let handler;
  if (ctx.trusted && !raw) handler = mcpLocal;
  else {
    const ip = reqIp(req);
    if (rateLimited(ip)) return mcpReply(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'too many bad tokens; wait 15 minutes' } });
    const h = hmac(cfg.secret, `mcp.${raw}`);
    const tok = raw ? (cfg.mcpTokens || []).find(t => safeEqual(t.hash, h)) : null;
    if (!tok) {
      if (raw) { const arr = loginFails.get(ip); if (arr) arr.push(Date.now()); else loginFails.set(ip, [Date.now()]); }
      return mcpReply(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'missing or wrong MCP token; create one on the PC with `preview mcp token <name>`' } }, { 'www-authenticate': 'Bearer realm="preview"' });
    }
    if (!tok.lastUsedAt || Date.now() - tok.lastUsedAt > 10 * 6e4) { tok.lastUsedAt = Date.now(); saveConfig(cfg); }
    handler = mcpRemote.get(tok.name);
    if (!handler) {
      handler = createMcpServer({ call: rawCall, remote: true, by: tok.name, log: (...a) => log(`mcp ${tok.name}`, ...a) });
      mcpRemote.set(tok.name, handler);
    }
  }
  if (req.method === 'GET' || req.method === 'DELETE') return mcpReply(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST JSON-RPC to this endpoint; it has no event stream or sessions' } }, { allow: 'POST, OPTIONS' });
  if (req.method !== 'POST') return mcpReply(res, 405, undefined, { allow: 'POST, OPTIONS' });
  let msg;
  try { msg = JSON.parse(await readBody(req, 40 * 1048576)); } catch (e) {
    if (e.status === 413) return mcpReply(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request over 40 MB' } });
    return mcpReply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const out = await handler(msg);
  if (!out) return mcpReply(res, 202);
  return mcpReply(res, 200, out);
}

async function hubRoute(req, res, u, ctx) {
  const p = u.pathname;
  if (p === '/_hub/health') return sendJson(res, 200, { ok: true, version: VERSION, n: u.searchParams.get('n') || undefined });
  if (p.startsWith('/_hub/ui/')) return serveUi(res, p.slice('/_hub/ui/'.length));
  if (p === '/_hub/login') {
    const next = (n => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/'))(u.searchParams.get('next'));
    if (req.method === 'GET') {
      if (ctx.authed) return redirect(res, next);
      return serveUi(res, 'login.html', { 'cache-control': 'no-store' });
    }
    if (req.method === 'POST') {
      const ip = reqIp(req);
      if (rateLimited(ip)) return redirect(res, `/_hub/login?e=limit&next=${encodeURIComponent(next)}`, 303);
      const form = new URLSearchParams(await readBody(req, 4096));
      const pc = String(form.get('passcode') || '').trim();
      if (!safeEqual(pc.toLowerCase(), String(cfg.passcode).toLowerCase())) {
        loginFails.get(ip)?.push(Date.now()) ?? loginFails.set(ip, [Date.now()]);
        return redirect(res, `/_hub/login?e=1&next=${encodeURIComponent(next)}`, 303);
      }
      return redirect(res, next, 303, { 'set-cookie': sessionCookie(ctx, sessionValue(), SESSION_DAYS * 86400) });
    }
  }
  if (p === '/_hub/magic') {
    const t = u.searchParams.get('t') || '';
    if (t && useMagic(t)) return redirect(res, '/', 302, { 'set-cookie': sessionCookie(ctx, sessionValue(), SESSION_DAYS * 86400) });
    return sendPage(res, 'Link expired', '<h1>This login link has expired or was already used</h1><p>Ask an agent for a new one (<span class="mono">preview login-link</span>) or use the passcode.</p><a class="btn primary" href="/_hub/login">Log in</a>', { status: 410 });
  }
  if (p === '/_hub/logout') return redirect(res, '/_hub/login', 302, { 'set-cookie': sessionCookie(ctx, '', 0) });
  if (p === '/_hub/mcp' || p.startsWith('/_hub/mcp/')) return mcpRoute(req, res, u, ctx);
  if (!ctx.authed) {
    if (p.startsWith('/_hub/api/')) return sendJson(res, 401, { error: 'log in first', login: '/_hub/login' });
    return redirect(res, `/_hub/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  }
  const shot = p.match(/^\/_hub\/shot\/([\w-]+)\.jpg$/);
  if (shot) {
    const f = shotFile(shot[1]);
    let st; try { st = fs.statSync(f); } catch { return send(res, 404, 'no screenshot'); }
    return sendFile(req, res, f, st, { 'cache-control': 'private, max-age=60' });
  }
  if (p.startsWith('/_hub/api/')) {
    if (req.method !== 'GET' && !ctx.trusted && req.headers['x-hub'] !== '1') return sendJson(res, 403, { error: 'missing x-hub header' });
    return apiRoute(req, res, u, ctx);
  }
  return send(res, 404, 'not found');
}

function notFound(req, res) {
  if (!isNavigation(req)) return send(res, 404, 'not found', { 'content-type': 'text/plain' });
  sendPage(res, 'Not found', '<h1>No preview here</h1><p>The link may be wrong, or the preview was deleted.</p><a class="btn primary" href="/">All previews</a>', { status: 404 });
}

async function handle(req, res, trusted) {
  const u = new URL(req.url, 'http://hub');
  const p = u.pathname;
  const ctx = { trusted, proto: reqProto(req, trusted), authed: isAuthed(req, trusted) };
  if (p === '/_hub' || p.startsWith('/_hub/')) return hubRoute(req, res, u, ctx);
  if (p === '/') {
    if (isVitePing(req)) { const r = recFromCookie(req); if (r) return servePreview(r, p + u.search, req, res, ctx, false); }
    if (!ctx.authed) return redirect(res, '/_hub/login');
    return serveUi(res, 'index.html', { 'cache-control': 'no-store' });
  }
  const seg = p.split('/')[1];
  const rec = store.get(seg);
  if (rec) {
    if (p === `/${seg}`) return redirect(res, `/${seg}/${u.search}`);
    return servePreview(rec, p.slice(seg.length + 1) + u.search, req, res, ctx, true);
  }
  const fromRef = recFromReferer(req);
  // A typed or old link shaped like a preview id (name-xxxx) whose preview is gone must 404,
  // not fall through to whichever preview the pvh_ctx cookie last pointed at.
  if (!fromRef && isNavigation(req) && /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-hj-km-np-z2-9]{4}$/.test(seg || '')) return notFound(req, res);
  const r2 = fromRef || recFromCookie(req);
  if (r2) return servePreview(r2, p + u.search, req, res, ctx, false);
  if (p === '/favicon.ico') return redirect(res, '/_hub/ui/favicon.svg');
  return notFound(req, res);
}

function makeServer(trusted) {
  const srv = http.createServer((req, res) => {
    handle(req, res, trusted).catch(err => {
      const status = err.status || 500;
      if (status >= 500) log('error', req.method, req.url, err.stack || err.message);
      if (res.headersSent) return res.destroy();
      if ((req.url || '').startsWith('/_hub/api/')) return sendJson(res, status, { error: err.message });
      send(res, status, err.message, { 'content-type': 'text/plain; charset=utf-8' });
    });
  });
  srv.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, trusted));
  srv.keepAliveTimeout = 65e3;
  srv.headersTimeout = 70e3;
  srv.requestTimeout = 0;
  return srv;
}

// ---------------------------------------------------------------- loops + boot

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const rec of store.all()) {
      if (rec.stopped) continue;
      if (rec.expiresAt && now > rec.expiresAt) { await stopPreview(rec, 'expired'); continue; }
      if (rec.pid && !pidAlive(rec.pid)) { rec.pid = null; store.save(); }
      if (rec.kind === 'proxy' && rec.target) {
        const up = await isUp(rec);
        if (up && rec.shotAt && now - rec.shotAt > 30 * 6e4 && rec.lastHitAt && rec.lastHitAt > rec.shotAt) takeShot(rec).catch(() => {});
      }
    }
    refreshTunnelStatus();
  } catch (e) { log('tick error', e.message); }
  ticking = false;
}

async function resurrect() {
  const bt = bootTime();
  for (const rec of store.all()) {
    if (rec.pid && ((rec.spawnedAt || 0) < bt - 5000 || !pidAlive(rec.pid))) rec.pid = null;
  }
  store.save();
  for (const rec of store.all()) {
    if (rec.stopped || rec.kind !== 'proxy' || !rec.managed || !rec.cmd) continue;
    if (rec.expiresAt && Date.now() > rec.expiresAt) continue;
    if (rec.pid) continue;
    if (rec.target && await isUp(rec)) continue;
    log('resurrect', rec.id);
    spawnFor(rec);
  }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  store.save(true);
  if (tunnel.child) tunnel.child.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled', e?.stack || e));

// Extra public binds (config publicBinds, e.g. a Tailscale or LAN IP so a tunnel on another machine can reach
// this hub). Retried until the interface exists: a VPN may come up after the hub at logon.
function listenExtra(host) {
  const srv = makeServer(false);
  srv.on('error', e => {
    log(`public listener ${host}:${PUBLIC_PORT}`, e.code || e.message, 'retrying in 30s');
    setTimeout(() => listenExtra(host), 30e3);
  });
  srv.listen(PUBLIC_PORT, host, () => log(`public listener up on ${host}:${PUBLIC_PORT}`));
}

const pub = makeServer(false);
const loc = makeServer(true);
pub.on('error', e => { log('public listener', e.message); process.exit(e.code === 'EADDRINUSE' ? 3 : 1); });
loc.on('error', e => { log('local listener', e.message); process.exit(e.code === 'EADDRINUSE' ? 3 : 1); });
pub.listen(PUBLIC_PORT, '127.0.0.1', () => {
  for (const host of cfg.publicBinds || []) if (host !== '127.0.0.1') listenExtra(host);
  loc.listen(LOCAL_PORT, '127.0.0.1', async () => {
    fs.writeFileSync(path.join(DIRS.run, 'hub.pid'), String(process.pid));
    log(`preview hub ${VERSION} up · public 127.0.0.1:${PUBLIC_PORT} · local 127.0.0.1:${LOCAL_PORT} · data ${DATA}`);
    await startTunnel();
    await resurrect();
    setInterval(tick, 5000);
    setInterval(() => publicProbe().catch(() => {}), 60e3);
    setTimeout(() => publicProbe().catch(() => {}), 10e3);
    tick();
  });
});
