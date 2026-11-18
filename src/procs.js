import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

const IS_WIN = process.platform === 'win32';

export function bootTime() {
  return Date.now() - os.uptime() * 1000;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function imageName(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(null);
    if (!IS_WIN) {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? null : out.trim().split('/').pop()));
      return;
    }
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(/^"([^"]+)","(\d+)"/m);
      resolve(m && Number(m[2]) === Number(pid) ? m[1].toLowerCase() : null);
    });
  });
}

export function killTree(pid) {
  return new Promise(resolve => {
    if (!pid || !pidAlive(pid)) return resolve(false);
    if (!IS_WIN) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      return resolve(true);
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
  });
}

// Start a shell command with a hidden console. Not detached on purpose: on Windows a
// detached cmd.exe has no console, so grandchildren (node, python) pop a visible window.
export function spawnCmd(cmd, cwd, logFile, extraEnv = {}) {
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n--- ${new Date().toISOString()} start: ${cmd}  (cwd ${cwd})\n`);
  const child = spawn(cmd, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: !IS_WIN,
    stdio: ['ignore', fd, fd],
    // PYTHONUNBUFFERED: python servers print their URL at once, so the hub can detect the port.
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONUNBUFFERED: '1', CI: process.env.CI || '', ...extraEnv },
  });
  fs.closeSync(fd);
  child.unref();
  return child;
}

// PID listening on a local TCP port, or null. Uses Get-NetTCPConnection: on this Windows build netstat
// omits IPv6 loopback listeners (Vite binds [::1]) and the State column can be wrong, so match RemotePort 0.
export function listenerPid(port) {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve(null);
    const ps = `(Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 -and $_.OwningProcess -gt 0 } | Select-Object -First 1).OwningProcess`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err) return resolve(null);
      resolve(Number(String(out).trim()) || null);
    });
  });
}

// Process start time in ms, or null.
export function procStartTime(pid) {
  return new Promise(resolve => {
    if (!IS_WIN || !pid) return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { windowsHide: true, timeout: 8000 }, (err, out) => {
        if (err) return resolve(null);
        const t = Date.parse(String(out).trim());
        resolve(Number.isNaN(t) ? null : t);
      });
  });
}

export function tcpUp(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, autoSelectFamily: true });
    const done = ok => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
