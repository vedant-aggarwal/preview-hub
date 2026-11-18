// Hub client and display shaping, shared by the CLI (bin/preview.js) and the stdio MCP server (bin/preview-mcp.js).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AxiError } from 'axi-sdk-js';
import { DIRS, LOCAL_PORT } from './store.js';
import { fmtDur } from './util.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const HUB = `http://127.0.0.1:${LOCAL_PORT}`;
export const TASK = 'PreviewHub';

export async function rawCall(method, p, body) {
  const res = await fetch(`${HUB}/_hub/api/${p}`, {
    method, headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { error: text }; }
  if (!res.ok) {
    throw new AxiError(j.error || `hub returned ${res.status}`, res.status === 404 ? 'NOT_FOUND' : res.status === 400 ? 'VALIDATION_ERROR' : 'HUB_ERROR',
      res.status === 404 ? ['Run `preview list --all` to see ids'] : []);
  }
  return j;
}

export async function hubUp() {
  try { const r = await fetch(`${HUB}/_hub/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

export function taskInstalled() {
  if (process.platform !== 'win32') return false;
  try { execFileSync('schtasks', ['/Query', '/TN', TASK], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

export async function startHubProcess() {
  const lock = path.join(DIRS.run, 'hub-start.lock');
  let owner = false;
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); owner = true; } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30e3) { fs.rmSync(lock, { force: true }); fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); owner = true; } } catch { /* someone else won */ }
  }
  try {
    if (owner) {
      if (taskInstalled()) {
        execFileSync('schtasks', ['/Run', '/TN', TASK], { stdio: 'ignore', windowsHide: true });
      } else {
        const child = spawn(process.execPath, [path.join(ROOT, 'src', 'hub.js')], { detached: true, windowsHide: true, stdio: 'ignore' });
        child.unref();
      }
    }
    for (let i = 0; i < 40; i++) { if (await hubUp()) return true; await new Promise(r => setTimeout(r, 500)); }
    return false;
  } finally { if (owner) fs.rmSync(lock, { force: true }); }
}

// Calls the hub's trusted loopback API, starting the hub first if it is down.
export async function call(method, p, body) {
  try { return await rawCall(method, p, body); } catch (e) {
    if (!(e instanceof TypeError) && e?.cause?.code !== 'ECONNREFUSED') throw e;
  }
  if (!(await startHubProcess())) throw new AxiError('preview hub is not running and could not be started', 'HUB_DOWN', ['Run `preview hub start`', `Check ${path.join(DIRS.logs, 'hub.log')}`]);
  return rawCall(method, p, body);
}

// ------------------------------------------------------------ shaping

export function left(p) {
  if (p.status === 'stopped') return p.stoppedAt ? `stopped ${fmtDur(Date.now() - p.stoppedAt)} ago` : 'stopped';
  if (p.expiresIn == null) return 'never';
  return fmtDur(p.expiresIn);
}

export function tgt(p) {
  if (p.kind === 'static') return p.path;
  if (p.target) return p.target.replace('http://', '');
  return p.cmd ? 'detecting port' : '-';
}

export function row(p) { return { id: p.id, status: p.status, name: p.name, target: tgt(p), stops_in: left(p) }; }
export function stoppedRow(p) { return { id: p.id, name: p.name, stopped: left(p).replace(/^stopped /, ''), reason: p.stopReason || '-' }; }

export function detail(p) {
  const o = {
    id: p.id, url: p.url, status: p.status, name: p.name, kind: p.kind === 'static' ? 'files' : p.managed ? 'server (hub-owned)' : 'server (attached)',
    target: tgt(p),
  };
  if (p.cmd) o.cmd = p.cmd;
  if (p.cwd) o.cwd = p.cwd;
  if (p.entry && p.entry !== '/') o.entry = p.entry;
  o.stops_in = left(p);
  if (p.private) o.private = true;
  if (p.by) o.by = p.by;
  if (p.pid) o.pid = p.pid;
  if (p.hits) o.visits = p.hits;
  if (p.snapshot) o.snapshot = `${p.snapshot.entries} files, ${(p.snapshot.bytes / 1048576).toFixed(1)} MB`;
  return o;
}
