#!/usr/bin/env node
// preview: AXI CLI for the preview hub (<public-url>/<id>/).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAxiCli, AxiError } from 'axi-sdk-js';
import { DATA, DIRS } from '../src/store.js';
import { fmtDur } from '../src/util.js';
import {
  ROOT, VERSION, TASK, rawCall, hubUp, taskInstalled, startHubProcess, call, left, row, stoppedRow, detail,
} from '../src/client.js';

const usage = (msg, help = []) => new AxiError(msg, 'VALIDATION_ERROR', help);

function parse(args, spec, maxPos, cmdHelp) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = a.slice(2, eq < 0 ? undefined : eq);
      let v = eq < 0 ? undefined : a.slice(eq + 1);
      if (!(k in spec)) throw usage(`unknown flag --${k}`, [cmdHelp]);
      if (spec[k] === 'bool') { out[k] = v === undefined ? true : !['false', '0', 'no'].includes(v.toLowerCase()); continue; }
      if (v === undefined) { v = args[++i]; if (v === undefined) throw usage(`--${k} needs a value`, [cmdHelp]); }
      out[k] = spec[k] === 'number' ? Number(v) : v;
      if (spec[k] === 'number' && Number.isNaN(out[k])) throw usage(`--${k} must be a number`, [cmdHelp]);
    } else out._.push(a);
  }
  if (out._.length > maxPos) throw usage(`unexpected argument "${out._[maxPos]}"`, [cmdHelp]);
  return out;
}

// ------------------------------------------------------------ commands

const HELP = {
  add: `usage: preview add <port|url|path> [flags]
  Publish a local server, file or folder at <public-url>/<id>/
  <port|url|path>     5173, http://localhost:3000/app, C:\\path\\video.mp4, C:\\path\\folder
  --name <text>       display name (default: folder or file name)
  --ttl <dur>         stop after 30m|4h|2d|never (default 4h for servers, 7d for files)
  --cmd "<command>"   one-line command that starts the server (saved for restarts)
  --cwd <dir>         folder to run --cmd in
  --start             hub starts --cmd now and owns the process (stops it at expiry)
                      without --start the preview attaches to a server already running
  --wait <sec>        with --start, wait until the port answers (default 60)
  --entry <path>      open the link at this path, e.g. /dashboard
  --private           viewers must log in with the hub passcode
  --by <agent>        who created it (claude, codex, ...)
  --id <slug>         fixed id instead of name-xxxx
  --new               create a second preview even if this target is already published
  Same target again returns the existing link (already: true) and restarts it if stopped.`,
  list: `usage: preview list [--all] [--status live|starting|down|stopped]
  Running previews by default; --all adds stopped ones.`,
  show: 'usage: preview show <id>\n  Full details for one preview, plus the last 15 log lines.',
  stop: 'usage: preview stop <id>\n  Stop sharing. Kills the server if the hub started it. Keeps the snapshot.',
  start: 'usage: preview start <id> [--wait <sec>]\n  Start a stopped preview again (runs its saved --cmd if the server is down).',
  restart: 'usage: preview restart <id> [--wait <sec>]\n  Kill and re-run the saved start command.',
  edit: `usage: preview edit <id> [--name t] [--ttl dur] [--target port|url|path] [--cmd "..."] [--cwd dir] [--entry /path] [--private true|false] [--note t]
  --ttl restarts the countdown from now.`,
  rm: 'usage: preview rm <id>\n  Delete a preview with its snapshot, screenshot and logs. Stops it first.',
  logs: 'usage: preview logs <id> [--lines N]\n  Server output for hub-started previews (default 60 lines).',
  shot: 'usage: preview shot <id>\n  Refresh the dashboard screenshot (also refreshes the snapshot cache).',
  'login-link': 'usage: preview login-link [--ttl 24h]\n  One-time link that logs a browser into the dashboard for a year. Send it only to the owner.',
  passcode: 'usage: preview passcode | preview passcode set <new>\n  Show or change the dashboard passcode (changing logs out every browser).',
  mcp: `usage: preview mcp [token <name> | revoke <name>]
  (none)          MCP endpoints, tokens, and the stdio command for local agents
  token <name>    create (or rotate) a token for a cloud bot, e.g. grok; prints its connector URL once
  revoke <name>   delete a token; that bot loses access at once
  Cloud bots get remote-safe tools: no start commands, no secret or system folders.`,
  hub: `usage: preview hub [status|start|stop|restart|logs|install|public-url <url>|tunnel <token-file>]
  status                      hub, public URL and whether the public URL reaches this hub
  install                     Windows: register the PreviewHub logon task and start it (macOS/Linux: use PM2, see ONBOARDING.md)
  public-url <url> [--via x]  set the public origin a tunnel serves, e.g. https://abc.ngrok-free.app (--via ngrok|cloudflare|other)
  public-url none             go back to local-only links (http://localhost:7420)
  tunnel <token-file> [--public-url <url>]
                              let the hub run cloudflared itself with a Cloudflare Tunnel token (read from a file)
  tunnel none                 stop the hub-run cloudflared and forget its token`,
};

const TOP = `usage: preview <command> [args] [flags]
Permanent preview links on <public-url>/<id>/ for local servers, files and folders.
commands:
  (none)              running previews + hub status
  add <port|url|path> publish; --cmd/--cwd save the start command, --start runs it, --ttl sets expiry
  list [--all]        previews; stopped ones with --all
  show <id>           details + recent logs
  stop | start | restart <id>
  edit <id>           change name, ttl, target, cmd, cwd, private
  rm <id>             delete preview + snapshot
  logs <id>           server output
  shot <id>           refresh dashboard screenshot
  login-link          one-time dashboard login URL for the owner
  passcode [set <p>]  dashboard passcode
  mcp [token <name>]  MCP server for other agents and cloud bots (Grok, claude.ai, ChatGPT...)
  hub [status|start|stop|restart|logs|install]
Run \`preview <command> --help\` for flags.`;

async function home() {
  const s = await call('GET', 'state');
  const running = s.previews.filter(p => p.status !== 'stopped');
  const stopped = s.previews.filter(p => p.status === 'stopped');
  const out = {
    hub: `running v${s.hub.version}, tunnel ${s.hub.tunnel.status}`,
    dashboard: `${s.hub.publicBase}/`,
  };
  if (running.length) out.running = running.map(row);
  else out.running = '0 previews running';
  out.stopped = stopped.length;
  out.help = running.length
    ? ['Run `preview add <port|path> --name "<name>"` to publish another', 'Run `preview show <id>` for a link and logs', stopped.length ? 'Run `preview list --all` to include stopped previews' : 'Run `preview login-link` for a one-tap dashboard login']
    : ['Run `preview add 5173 --name "<name>" --cmd "npm run dev" --cwd <dir>` to attach to a running server', 'Run `preview add <file-or-folder>` to share files', 'Run `preview add --start --cmd "npm run dev" --cwd <dir>` to have the hub start the server'];
  return out;
}

async function cmdAdd(args) {
  const o = parse(args, { name: 'string', ttl: 'string', cmd: 'string', cwd: 'string', start: 'bool', wait: 'number', entry: 'string', private: 'bool', by: 'string', id: 'string', new: 'bool', note: 'string' }, 1, 'Run `preview add --help`');
  const target = o._[0];
  if (!target && !(o.cmd && o.start)) throw usage('give a port, URL or path (or --start --cmd "<command>")', ['Run `preview add --help`']);
  let resolvedTarget = target;
  if (target && !/^:?\d{2,5}$/.test(target) && !/^https?:\/\//i.test(target) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(target)) {
    resolvedTarget = path.resolve(target);
    if (!fs.existsSync(resolvedTarget)) throw usage(`path not found: ${resolvedTarget}`);
  }
  const cwd = o.cwd ? path.resolve(o.cwd) : (o.cmd ? process.cwd() : undefined);
  const body = {
    target: resolvedTarget, name: o.name, ttl: o.ttl, cmd: o.cmd, cwd, start: !!o.start,
    wait: o.start ? (o.wait ?? 60) : undefined, entry: o.entry, private: o.private, by: o.by || process.env.PREVIEW_BY, id: o.id, fresh: !!o.new, note: o.note,
  };
  const r = await call('POST', 'previews', body);
  const p = r.preview;
  const out = { preview: detail(p) };
  if (r.already) out.already = true;
  if (r.restarted) out.restarted = true;
  if (r.note) out.note = r.note;
  const help = [`Send the user ${p.url}`];
  if (p.status === 'down' && !o.start) help.push(p.cmd ? `Server not answering yet; run \`preview start ${p.id}\` to launch the saved command` : 'Server not answering yet; start it, or re-add with --cmd "<command>" --start');
  if (p.status === 'starting') help.push(`Run \`preview logs ${p.id}\` if it stays starting`);
  if (!p.cmd && p.kind === 'proxy') help.push(`Run \`preview edit ${p.id} --cmd "<start command>" --cwd <dir>\` so it can be restarted from the dashboard`);
  help.push(`Run \`preview stop ${p.id}\` when done`);
  out.help = help.slice(0, 3);
  return out;
}

async function cmdList(args) {
  const o = parse(args, { all: 'bool', status: 'string' }, 0, 'Run `preview list --help`');
  const s = await call('GET', 'state');
  let list = s.previews;
  if (o.status) list = list.filter(p => p.status === o.status);
  else if (!o.all) list = list.filter(p => p.status !== 'stopped');
  const stoppedHidden = !o.all && !o.status ? s.previews.filter(p => p.status === 'stopped').length : 0;
  const out = { total: list.length };
  if (!list.length) out.previews = o.status ? `0 previews with status ${o.status}` : '0 previews running';
  else if (o.status === 'stopped') out.previews = list.map(stoppedRow);
  else out.previews = list.map(row);
  out.link = `${s.hub.publicBase}/<id>/`;
  const help = [];
  if (stoppedHidden) help.push(`${stoppedHidden} stopped hidden; run \`preview list --all\``);
  help.push('Run `preview show <id>` for details');
  out.help = help;
  return out;
}

async function cmdShow(args) {
  const o = parse(args, {}, 1, 'Run `preview show --help`');
  if (!o._[0]) throw usage('missing <id>', ['Run `preview list --all`']);
  const { preview: p } = await call('GET', `previews/${encodeURIComponent(o._[0])}`);
  const out = { preview: detail(p) };
  if (p.kind === 'proxy') {
    const { log } = await call('GET', `previews/${encodeURIComponent(p.id)}/logs?lines=15`);
    if (log && log.trim()) out.log = log.trim();
  }
  out.help = p.status === 'stopped' ? [`Run \`preview start ${p.id}\``, `Run \`preview rm ${p.id}\` to delete it`] : [`Run \`preview stop ${p.id}\``, `Run \`preview edit ${p.id} --ttl 4h\` to extend`];
  return out;
}

function simple(action, method = 'POST', withWait = false) {
  return async args => {
    const o = parse(args, withWait ? { wait: 'number' } : {}, 1, `Run \`preview ${action} --help\``);
    if (!o._[0]) throw usage('missing <id>', ['Run `preview list --all`']);
    const id = encodeURIComponent(o._[0]);
    const body = withWait ? { wait: o.wait ?? 60 } : {};
    const r = await call(method, `previews/${id}/${action}`, body);
    const p = r.preview;
    const out = { preview: { id: p.id, status: p.status, url: p.url, stops_in: left(p) } };
    if (r.already) out.already = true;
    if (r.killed) out.killed_server = true;
    if (action === 'stop') out.help = [`Run \`preview start ${p.id}\` to bring it back`, `The link now shows the last snapshot`];
    else out.help = p.status === 'live' ? [`Send the user ${p.url}`] : [`Run \`preview logs ${p.id}\` to see why it is ${p.status}`];
    return out;
  };
}

async function cmdEdit(args) {
  const o = parse(args, { name: 'string', ttl: 'string', target: 'string', cmd: 'string', cwd: 'string', entry: 'string', private: 'string', note: 'string' }, 1, 'Run `preview edit --help`');
  if (!o._[0]) throw usage('missing <id>', ['Run `preview list --all`']);
  const body = {};
  for (const k of ['name', 'ttl', 'cmd', 'entry', 'note']) if (o[k] !== undefined) body[k] = o[k];
  if (o.cwd !== undefined) body.cwd = o.cwd ? path.resolve(o.cwd) : '';
  if (o.target !== undefined) body.target = /^:?\d{2,5}$|^https?:\/\//i.test(o.target) ? o.target : path.resolve(o.target);
  if (o.private !== undefined) body.private = ['true', '1', 'yes'].includes(o.private.toLowerCase());
  if (!Object.keys(body).length) throw usage('nothing to change', ['Run `preview edit --help`']);
  const r = await call('PATCH', `previews/${encodeURIComponent(o._[0])}`, body);
  return { preview: detail(r.preview), changed: r.changed.join(', '), help: [`Run \`preview show ${r.preview.id}\``] };
}

async function cmdRm(args) {
  const o = parse(args, {}, 1, 'Run `preview rm --help`');
  if (!o._[0]) throw usage('missing <id>', ['Run `preview list --all`']);
  const r = await call('DELETE', `previews/${encodeURIComponent(o._[0])}`);
  return { deleted: r.deleted, help: ['Run `preview list --all`'] };
}

async function cmdLogs(args) {
  const o = parse(args, { lines: 'number' }, 1, 'Run `preview logs --help`');
  if (!o._[0]) throw usage('missing <id>', ['Run `preview list`']);
  const r = await call('GET', `previews/${encodeURIComponent(o._[0])}/logs?lines=${o.lines || 60}`);
  return { id: r.id, log: r.log && r.log.trim() ? r.log : '(no output captured; only hub-started servers log here)' };
}

async function cmdShot(args) {
  const o = parse(args, {}, 1, 'Run `preview shot --help`');
  if (!o._[0]) throw usage('missing <id>', ['Run `preview list`']);
  const r = await call('POST', `previews/${encodeURIComponent(o._[0])}/shot`, {});
  return { id: r.preview.id, screenshot: r.shot ? 'updated' : 'failed', file: path.join(DIRS.shots, `${r.preview.id}.jpg`) };
}

async function cmdLoginLink(args) {
  const o = parse(args, { ttl: 'string' }, 0, 'Run `preview login-link --help`');
  const r = await call('POST', 'magic', { ttl: o.ttl });
  return { login_link: r.url, valid_for: fmtDur(r.expiresIn), uses: 1, help: ['Send this link only to the owner; it logs a browser in for a year', 'Run `preview passcode` to type a code instead'] };
}

async function cmdPasscode(args) {
  const o = parse(args, {}, 2, 'Run `preview passcode --help`');
  if (o._[0] === 'set') {
    if (!o._[1]) throw usage('missing new passcode', ['Run `preview passcode set <new>`']);
    const r = await call('POST', 'passcode', { passcode: o._[1] });
    return { passcode: 'changed', logged_out: r.loggedOut };
  }
  if (o._[0]) throw usage(`unknown passcode action "${o._[0]}"`, ['Run `preview passcode --help`']);
  const r = await call('GET', 'passcode');
  return { passcode: r.passcode, help: ['Run `preview login-link` for a one-tap login instead'] };
}

async function cmdMcp(args) {
  const o = parse(args, {}, 2, 'Run `preview mcp --help`');
  const action = o._[0] || 'status';
  const stdio = `node ${path.join(ROOT, 'bin', 'preview-mcp.js')}`;
  if (action === 'status') {
    const r = await call('GET', 'mcp');
    const ago = t => (t ? `${fmtDur(Date.now() - t)} ago` : 'never');
    return {
      remote: `${r.endpoint}/<token>`,
      tokens: r.tokens.length ? r.tokens.map(t => ({ name: t.name, created: ago(t.createdAt), last_used: ago(t.lastUsedAt) })) : 'none yet',
      local_http: `${r.local} (no token, full access, this PC only)`,
      stdio,
      help: ['Run `preview mcp token <bot-name>` to connect a cloud bot', `Local agents: add a stdio MCP server running \`${stdio}\``],
    };
  }
  if (action === 'token') {
    if (!o._[1]) throw usage('missing <name>', ['Run `preview mcp token grok`']);
    const r = await call('POST', 'mcp/tokens', { name: o._[1] });
    return {
      name: r.name, url: r.url, endpoint: r.endpoint, bearer_token: r.token,
      note: 'Shown once. Paste url as the connector URL, or use endpoint with header "Authorization: Bearer <bearer_token>".',
      help: [`Run \`preview mcp revoke ${r.name}\` to cut access`, `Running this again rotates the token`],
    };
  }
  if (action === 'revoke') {
    if (!o._[1]) throw usage('missing <name>', ['Run `preview mcp` to see token names']);
    const r = await call('DELETE', `mcp/tokens/${encodeURIComponent(o._[1])}`);
    return { revoked: r.revoked };
  }
  throw usage(`unknown mcp action "${action}"`, ['Run `preview mcp --help`']);
}

function pidOf(file) { try { return Number(fs.readFileSync(file, 'utf8').trim()) || null; } catch { return null; } }

async function cmdHub(args) {
  const o = parse(args, { via: 'string', 'public-url': 'string' }, 2, 'Run `preview hub --help`');
  const action = o._[0] || 'status';
  const ps = path.join(ROOT, 'scripts', 'supervise.ps1');
  if (action === 'status') {
    const up = await hubUp();
    const out = { hub: up ? 'running' : 'stopped', task: taskInstalled() ? `${TASK} (runs at logon)` : 'not installed', data: DATA };
    if (up) {
      const s = await rawCall('GET', 'state');
      const t = s.hub.tunnel;
      out.public = s.hub.publicConfigured ? s.hub.publicBase : `not set (links are ${s.hub.publicBase}, this machine only)`;
      if (s.hub.publicConfigured) {
        out.via = t.via || 'external';
        out.public_check = t.publicCheck === 'ok' ? 'ok: the public URL reaches this hub' : t.publicCheck === 'failing' ? 'failing: the public URL does not reach this hub' : 'checking';
      }
      out.previews = s.counts.total;
    }
    out.help = !up ? ['Run `preview hub start`']
      : out.public.startsWith('not set') ? ['Follow ONBOARDING.md to expose the hub (Cloudflare Tunnel or ngrok)', 'Then run `preview hub public-url <url> --via ngrok|cloudflare`']
        : ['Run `preview` to see running previews'];
    return out;
  }
  if (action === 'start') {
    if (await hubUp()) return { hub: 'running', already: true };
    const ok = await startHubProcess();
    return { hub: ok ? 'running' : 'failed to start', help: ok ? ['Run `preview`'] : [`Check ${path.join(DIRS.logs, 'hub.log')}`] };
  }
  if (action === 'stop' || action === 'restart') {
    const pid = pidOf(path.join(DIRS.run, 'hub.pid'));
    if (taskInstalled() && action === 'stop') { try { execFileSync('schtasks', ['/End', '/TN', TASK], { stdio: 'ignore', windowsHide: true }); } catch { /* not running */ } }
    if (pid) { try { process.kill(pid); } catch { /* gone */ } }
    for (let i = 0; i < 20 && await hubUp(); i++) await new Promise(r => setTimeout(r, 300));
    if (action === 'stop') return { hub: 'stopped', note: 'servers the hub started keep running until their preview is stopped' };
    // supervised: the supervise loop restarts it; otherwise start it ourselves
    for (let i = 0; i < 20; i++) { if (await hubUp()) return { hub: 'restarted' }; await new Promise(r => setTimeout(r, 500)); }
    const ok = await startHubProcess();
    return { hub: ok ? 'restarted' : 'failed to start' };
  }
  if (action === 'logs') {
    const f = path.join(DIRS.logs, 'hub.log');
    let t = ''; try { t = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(-40).join('\n'); } catch { /* none */ }
    return { file: f, log: t || '(empty)' };
  }
  if (action === 'install') {
    if (process.platform !== 'win32') throw usage('install is the Windows logon task; on macOS/Linux keep the hub running with PM2', ['Run `pm2 start ecosystem.config.cjs --only preview-hub && pm2 save`, then `pm2 startup`']);
    const ps1 = path.join(ROOT, 'scripts', 'install-task.ps1');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 30; i++) { if (await hubUp()) break; await new Promise(r => setTimeout(r, 500)); }
    return { task: TASK, trigger: 'at logon, restarts on exit', script: ps, hub: (await hubUp()) ? 'running' : 'not answering yet' };
  }
  if (action === 'tunnel') {
    const file = o._[1];
    if (file === 'none') { const r = await call('POST', 'tunnel', { token: '' }); return { tunnel: r.tunnel, note: 'hub-run cloudflared stopped and its token removed' }; }
    if (!file || !fs.existsSync(file)) throw usage('give a file containing the tunnel token', ['Run `preview hub tunnel <token-file> --public-url https://preview.example.com`']);
    const token = fs.readFileSync(file, 'utf8').trim();
    const body = { token };
    if (o['public-url']) body.publicBase = o['public-url'];
    const r = await call('POST', 'tunnel', body);
    return { tunnel: r.tunnel, public: r.publicBase || 'not set', via: r.via, help: ['Run `preview hub status` in a minute to confirm public_check: ok'] };
  }
  if (action === 'public-url') {
    const url = o._[1];
    if (!url) throw usage('give the public URL, e.g. https://abc.ngrok-free.app, or none', ['Run `preview hub --help`']);
    const body = url === 'none' ? { publicBase: null, via: null } : { publicBase: url, via: o.via || 'other' };
    const r = await call('POST', 'tunnel', body);
    return {
      public: r.publicBase || 'not set (local links only)', via: r.via || '-',
      help: r.publicBase ? ['Run `preview hub status` in a few seconds; public_check should say ok', `Open ${r.publicBase}/_hub/health in a browser to test by hand`] : ['Links now point at this machine only'],
    };
  }
  throw usage(`unknown hub action "${action}"`, ['Run `preview hub --help`']);
}

await runAxiCli({
  description: 'Preview hub: permanent public links for local servers, files and folders',
  version: VERSION,
  argv: process.argv.slice(2),
  topLevelHelp: TOP,
  getCommandHelp: c => HELP[c] || null,
  home,
  commands: {
    add: cmdAdd, list: cmdList, ls: cmdList, show: cmdShow,
    stop: simple('stop'), start: simple('start', 'POST', true), restart: simple('restart', 'POST', true),
    edit: cmdEdit, rm: cmdRm, delete: cmdRm, logs: cmdLogs, shot: cmdShot,
    'login-link': cmdLoginLink, passcode: cmdPasscode, mcp: cmdMcp, hub: cmdHub,
    update: async () => ({ update: `run git pull && npm install in ${ROOT}, then preview hub restart`, current: VERSION }),
  },
});
