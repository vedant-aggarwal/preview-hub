import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { passcodeGen } from './util.js';

export const DATA = process.env.PREVIEW_HUB_HOME || path.join(os.homedir(), '.preview-hub');
export const PUBLIC_PORT = Number(process.env.PREVIEW_HUB_PUBLIC_PORT || 7420);
export const LOCAL_PORT = Number(process.env.PREVIEW_HUB_LOCAL_PORT || 7421);
export const DIRS = {
  cache: path.join(DATA, 'cache'),
  logs: path.join(DATA, 'logs'),
  shots: path.join(DATA, 'shots'),
  run: path.join(DATA, 'run'),
};
for (const d of [DATA, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

const CONFIG_FILE = path.join(DATA, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  let cfg = readJson(CONFIG_FILE, null);
  let dirty = false;
  if (!cfg) { cfg = {}; dirty = true; }
  if (!cfg.secret) { cfg.secret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!cfg.passcode) { cfg.passcode = passcodeGen(); dirty = true; }
  if (!cfg.sessionEpoch) { cfg.sessionEpoch = 1; dirty = true; }
  if (cfg.publicBase === undefined) { cfg.publicBase = null; dirty = true; } // set by onboarding: preview hub public-url <url>
  if (!Array.isArray(cfg.magic)) { cfg.magic = []; dirty = true; }
  if (dirty) writeJsonAtomic(CONFIG_FILE, cfg);
  return cfg;
}

export function saveConfig(cfg) { writeJsonAtomic(CONFIG_FILE, cfg); }

export class Store {
  constructor() {
    const s = readJson(STATE_FILE, { previews: {} });
    this.previews = s.previews || {};
    this._timer = null;
  }
  get(id) { return this.previews[id]; }
  all() { return Object.values(this.previews); }
  put(rec) { this.previews[rec.id] = rec; this.save(); return rec; }
  remove(id) { delete this.previews[id]; this.save(); }
  save(now = false) {
    if (now) { clearTimeout(this._timer); this._timer = null; writeJsonAtomic(STATE_FILE, { previews: this.previews }); return; }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; writeJsonAtomic(STATE_FILE, { previews: this.previews }); }, 400);
  }
}
