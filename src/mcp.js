// MCP tool layer for the preview hub. Two transports use it:
//   bin/preview-mcp.js   stdio, for local agents (full access, same as the CLI)
//   hub /_hub/mcp        Streamable HTTP, for cloud bots (token auth, remote-safe limits)
// Handlers talk to the hub REST API through `call(method, path, body)`, which must throw an Error
// whose message is readable (and may carry .code = 'NOT_FOUND' | 'VALIDATION_ERROR' | ...).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA } from './store.js';
import { slugify, randomTag } from './util.js';
import { detail, row, stoppedRow, left } from './client.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const UPLOADS = path.join(DATA, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1048576;
const MAX_UPLOAD_FILES = 300;

const INSTRUCTIONS = `Publishes things on the user's computer at permanent links <public-url>/<id>/: a local dev server (by port), a file or folder (by absolute path), or content you send (preview_publish_content: HTML pages, images, any files).
Every result that creates or starts a preview carries "url"; send that url to the user.
Adding the same target again returns the same link and restarts it if stopped. Pick the shortest ttl that covers the need (30m, 4h, 2d, 7d, never).
Links are open to anyone who has them unless private=true (viewers then log in with the hub passcode).`;

const REMOTE_NOTE = ' Remote connection: no start commands, and secret or system folders are refused.';

// ------------------------------------------------------------ tool definitions

const ttlProp = { type: 'string', description: 'Stop after this long: 30m, 4h, 2d, 7d or never. Default 4h for servers, 7d for files.' };
const idProp = { type: 'string', description: 'Preview id, e.g. "landing-build-x7k2" (from preview_list).' };
const waitProp = { type: 'number', description: 'Seconds to wait for the server to answer (default 30).' };

function toolDefs(remote) {
  const add = {
    name: 'preview_add',
    title: 'Publish a server, file or folder',
    description: 'Publish a local server (port or http://localhost URL), a file, or a folder on the user\'s computer at a permanent link <public-url>/<id>/. Videos stream with seeking; images, PDFs, audio and text get a viewer; a folder with index.html is served as a site; other folders get a media grid. Returns the preview with its url.'
      + (remote ? REMOTE_NOTE : ' With cmd + start the hub launches the server itself and owns the process.'),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Port ("5173"), http://localhost URL, or absolute path to a file or folder.' },
        name: { type: 'string', description: 'Display name on the dashboard.' },
        ttl: ttlProp,
        entry: { type: 'string', description: 'Open the link at this sub-path, e.g. /dashboard.' },
        private: { type: 'boolean', description: 'Viewers must log in with the hub passcode.' },
        id: { type: 'string', description: 'Fixed id slug instead of an auto one.' },
        new: { type: 'boolean', description: 'Create a second preview even if this target is already published.' },
        ...(remote ? {} : {
          cmd: { type: 'string', description: 'One-line command that starts the server; saved so the preview can be restarted.' },
          cwd: { type: 'string', description: 'Folder to run cmd in.' },
          start: { type: 'boolean', description: 'Hub runs cmd now and owns the process (killed at expiry). Target may be omitted; the port is read from the output.' },
          wait: waitProp,
        }),
      },
      required: remote ? ['target'] : [],
      additionalProperties: false,
    },
    annotations: { title: 'Publish a server, file or folder', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  const edit = {
    name: 'preview_edit',
    title: 'Change a preview',
    description: 'Change a preview\'s name, ttl (restarts the countdown from now), target, entry path or privacy.' + (remote ? '' : ' Also its saved start command and folder.'),
    inputSchema: {
      type: 'object',
      properties: {
        id: idProp,
        name: { type: 'string' },
        ttl: ttlProp,
        target: { type: 'string', description: 'New port, http://localhost URL or path.' },
        entry: { type: 'string' },
        private: { type: 'boolean' },
        ...(remote ? {} : { cmd: { type: 'string' }, cwd: { type: 'string' } }),
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a preview', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  return [
    {
      name: 'preview_list',
      title: 'List previews',
      description: 'List previews with id, status (live, starting, down, stopped), name, target, url and time left. Running ones only unless all=true.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include stopped previews.' } }, additionalProperties: false },
      annotations: { title: 'List previews', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'preview_show',
      title: 'Show a preview',
      description: 'Full details for one preview (url, status, target, start command, time left, visits) plus its last server log lines.',
      inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Show a preview', readOnlyHint: true, openWorldHint: false },
    },
    add,
    {
      name: 'preview_publish_content',
      title: 'Publish content as a link',
      description: 'Upload files you made (an HTML page, a small site, images, a PDF, any files) and publish them at a permanent link. One file is shown in a viewer (HTML is served as a page); several files are served as a folder, with index.html as the home page if present. Pass id of an earlier upload to replace its files and keep the same link.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array', minItems: 1, maxItems: MAX_UPLOAD_FILES,
            description: 'Files to publish. Total decoded size up to 25 MB.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path inside the upload, e.g. "index.html" or "img/hero.png".' },
                content: { type: 'string', description: 'File content: plain text, or base64 when encoding is "base64".' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8. Use base64 for images, video, PDFs and other binary files.' },
              },
              required: ['path', 'content'],
              additionalProperties: false,
            },
          },
          name: { type: 'string', description: 'Display name, e.g. "Diwali sale page".' },
          id: { type: 'string', description: 'Id of an earlier preview_publish_content upload to replace (same link).' },
          ttl: ttlProp,
          entry: { type: 'string', description: 'Open the link at this sub-path.' },
          private: { type: 'boolean' },
        },
        required: ['files'],
        additionalProperties: false,
      },
      annotations: { title: 'Publish content as a link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'preview_start',
      title: 'Start a preview',
      description: 'Start a stopped preview again. Runs its saved start command if the server is down. Returns the url.',
      inputSchema: { type: 'object', properties: { id: idProp, wait: waitProp }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Start a preview', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'preview_stop',
      title: 'Stop a preview',
      description: 'Stop sharing a preview. Kills the server only if the hub started it. The link then shows the last snapshot; preview_start brings it back.',
      inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Stop a preview', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'preview_restart',
      title: 'Restart a preview',
      description: 'Kill and re-run the saved start command of a hub-owned server.',
      inputSchema: { type: 'object', properties: { id: idProp, wait: waitProp }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Restart a preview', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    edit,
    {
      name: 'preview_logs',
      title: 'Server logs',
      description: 'Server output for a hub-started preview.',
      inputSchema: { type: 'object', properties: { id: idProp, lines: { type: 'number', description: 'Lines to return (default 60, max 2000).' } }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Server logs', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'preview_delete',
      title: 'Delete a preview',
      description: 'Delete a preview with its snapshot, screenshot and logs (stops it first). Source files on the PC are kept, except files uploaded with preview_publish_content, which are removed.',
      inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Delete a preview', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'preview_login_link',
      title: 'Dashboard login link',
      description: 'One-time link that logs a browser into the preview dashboard for a year. Send it only to the owner of this hub.',
      inputSchema: { type: 'object', properties: { ttl: { type: 'string', description: 'How long the link stays usable (default 24h).' } }, additionalProperties: false },
      annotations: { title: 'Dashboard login link', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'preview_status',
      title: 'Hub status',
      description: 'Preview hub health: version, public tunnel state, dashboard URL and preview counts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Hub status', readOnlyHint: true, openWorldHint: false },
    },
  ];
}

// ------------------------------------------------------------ remote-safe checks

class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg); };

const SECRET_SEGMENT = /^(\..+|appdata|private|personal-docs|secrets?|credentials?|programdata|windows|program files( \(x86\))?)$/i;
const SECRET_CHILD = /^(\.env.*|\.git|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa.*|.*\.pem|.*\.key|.*\.pfx|credentials?(\..*)?|secrets?(\..*)?)$/i;

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Cloud bots may only publish ordinary project/media paths, never secret or system folders.
function checkRemotePath(p) {
  const abs = path.resolve(p);
  if (inside(abs, UPLOADS)) return abs;
  const home = os.homedir();
  if (abs === path.parse(abs).root) fail('remote connections cannot publish a whole drive.');
  if (inside(home, abs)) fail('remote connections cannot publish the home folder or anything above it.');
  for (const seg of abs.slice(path.parse(abs).root.length).split(/[\\/]+/).filter(Boolean)) {
    if (SECRET_SEGMENT.test(seg)) fail(`remote connections cannot publish paths inside "${seg}" folders. Ask a local agent if this is really wanted.`);
  }
  if (SECRET_CHILD.test(path.basename(abs))) fail('remote connections cannot publish secret files.');
  let st; try { st = fs.statSync(abs); } catch { fail(`path not found: ${abs}`); }
  if (st.isDirectory()) {
    let names = []; try { names = fs.readdirSync(abs); } catch { /* unreadable */ }
    const bad = names.find(n => SECRET_CHILD.test(n));
    if (bad) fail(`that folder holds "${bad}"; a folder link exposes every file under it, so remote connections cannot publish it.`);
  }
  return abs;
}

function checkRemoteTarget(t) {
  const s = String(t).trim();
  if (/^:?\d{2,5}$/.test(s)) return s;
  if (/^https?:\/\//i.test(s) || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/.test(s)) {
    let u; try { u = new URL(/^https?:/i.test(s) ? s : `http://${s}`); } catch { fail(`bad URL "${s}"`); }
    if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(u.hostname)) fail('remote connections can only publish servers on this PC (localhost).');
    return s;
  }
  return checkRemotePath(s);
}

function localTarget(t) {
  const s = String(t).trim();
  if (/^:?\d{2,5}$/.test(s) || /^https?:\/\//i.test(s) || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(s)) return s;
  const abs = path.resolve(s);
  if (!fs.existsSync(abs)) fail(`path not found: ${abs}`);
  return abs;
}

// ------------------------------------------------------------ uploads

function safeRel(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.includes('\0')) fail(`bad file path "${p}": use a relative path like "index.html"`);
  const segs = s.split('/').filter(Boolean);
  if (segs.some(x => x === '..' || x === '.')) fail(`bad file path "${p}": no . or .. segments`);
  if (segs.some(x => /[<>:"|?*]/.test(x))) fail(`bad file path "${p}": characters <>:"|?* are not allowed`);
  return segs.join('/');
}

function decodeFiles(files) {
  if (!Array.isArray(files) || !files.length) fail('files must be a non-empty array');
  if (files.length > MAX_UPLOAD_FILES) fail(`at most ${MAX_UPLOAD_FILES} files per upload`);
  let total = 0;
  const seen = new Set();
  return files.map(f => {
    const rel = safeRel(f?.path);
    if (seen.has(rel.toLowerCase())) fail(`duplicate file path "${rel}"`);
    seen.add(rel.toLowerCase());
    if (typeof f.content !== 'string') fail(`content of "${rel}" must be a string`);
    const enc = f.encoding || 'utf8';
    if (enc !== 'utf8' && enc !== 'base64') fail(`encoding of "${rel}" must be utf8 or base64`);
    const buf = enc === 'base64' ? Buffer.from(f.content.replace(/^data:[^,]*;base64,/, ''), 'base64') : Buffer.from(f.content, 'utf8');
    total += buf.length;
    if (total > MAX_UPLOAD_BYTES) fail('upload is over 25 MB; publish big media from a file path instead');
    return { rel, buf };
  });
}

function writeUpload(dir, decoded) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const { rel, buf } of decoded) {
    const file = path.join(dir, ...rel.split('/'));
    if (!inside(file, dir)) fail(`bad file path "${rel}"`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  // One non-index file: publish the file itself so it gets the viewer; otherwise the folder.
  if (decoded.length === 1 && !/(^|\/)index\.html?$/i.test(decoded[0].rel) && !decoded[0].rel.includes('/')) return path.join(dir, decoded[0].rel);
  return dir;
}

// ------------------------------------------------------------ handlers

function makeHandlers({ call, remote, by }) {
  const enc = encodeURIComponent;
  const need = (a, k) => { if (a[k] === undefined || a[k] === null || a[k] === '') fail(`missing ${k}`); return a[k]; };
  const noLocalOnly = a => {
    if (remote) for (const k of ['cmd', 'cwd', 'start']) if (a[k]) fail(`${k} is only available to local agents; preview_start can still run a start command saved by the owner.`);
  };

  return {
    async preview_list(a) {
      const s = await call('GET', 'state');
      const list = a.all ? s.previews : s.previews.filter(p => p.status !== 'stopped');
      const hidden = a.all ? 0 : s.previews.length - list.length;
      const out = {
        total: list.length,
        previews: list.map(p => ({ ...(p.status === 'stopped' ? stoppedRow(p) : row(p)), url: p.url })),
      };
      if (hidden) out.stopped_hidden = hidden;
      return out;
    },

    async preview_show(a) {
      const { preview: p } = await call('GET', `previews/${enc(need(a, 'id'))}`);
      const out = { preview: detail(p) };
      if (p.kind === 'proxy') {
        const { log } = await call('GET', `previews/${enc(p.id)}/logs?lines=15`);
        if (log && log.trim()) out.log = log.trim();
      }
      return out;
    },

    async preview_add(a) {
      noLocalOnly(a);
      if (!a.target && !(a.cmd && a.start)) fail('give target (a port, http://localhost URL or path), or cmd with start=true');
      const target = a.target ? (remote ? checkRemoteTarget(a.target) : localTarget(a.target)) : undefined;
      const cwd = a.cwd ? path.resolve(a.cwd) : undefined;
      const body = {
        target, name: a.name, ttl: a.ttl, cmd: a.cmd, cwd, start: !!a.start, wait: a.start ? (a.wait ?? 30) : undefined,
        entry: a.entry, private: a.private, id: a.id, fresh: !!a.new, by,
      };
      const r = await call('POST', 'previews', body);
      const p = r.preview;
      const out = { url: p.url, preview: detail(p) };
      if (r.already) out.already = true;
      if (r.restarted) out.restarted = true;
      if (r.note) out.note = r.note;
      if (p.status === 'down') out.hint = p.cmd ? `Server not answering yet; call preview_start with id ${p.id}.` : 'Server not answering yet; start it on that computer first.';
      return out;
    },

    async preview_publish_content(a) {
      const decoded = decodeFiles(a.files);
      let dir, existing = null;
      if (a.id) {
        const { preview: p } = await call('GET', `previews/${enc(a.id)}`);
        if (!p.path || !inside(p.path, UPLOADS)) fail(`preview "${a.id}" is not an upload; use preview_add or pick another id`);
        existing = p;
        const rel = path.relative(UPLOADS, p.path).split(/[\\/]/)[0];
        dir = path.join(UPLOADS, rel);
      } else {
        dir = path.join(UPLOADS, `${slugify(a.name || decoded[0].rel.replace(/\.[^.]+$/, '')) || 'upload'}-${randomTag(6)}`);
      }
      const target = writeUpload(dir, decoded);
      let p, r = {};
      if (existing) {
        const patch = {};
        if (path.resolve(existing.path) !== path.resolve(target)) patch.target = target;
        for (const k of ['name', 'ttl', 'entry']) if (a[k] !== undefined) patch[k] = a[k];
        if (a.private !== undefined) patch.private = !!a.private;
        p = Object.keys(patch).length ? (await call('PATCH', `previews/${enc(existing.id)}`, patch)).preview : existing;
        if (p.status === 'stopped') p = (await call('POST', `previews/${enc(existing.id)}/start`, {})).preview;
        call('POST', `previews/${enc(existing.id)}/shot`, {}).catch(() => {}); // refresh the dashboard thumbnail
      } else {
        r = await call('POST', 'previews', { target, name: a.name || decoded[0].rel, ttl: a.ttl, entry: a.entry, private: a.private, by, fresh: true });
        p = r.preview;
      }
      return { url: p.url, preview: { id: p.id, name: p.name, status: p.status, files: decoded.length, bytes: decoded.reduce((n, f) => n + f.buf.length, 0), stops_in: left(p) }, replaced: !!existing };
    },

    async preview_start(a) {
      const r = await call('POST', `previews/${enc(need(a, 'id'))}/start`, { wait: a.wait ?? 30 });
      const p = r.preview;
      return { url: p.url, status: p.status, stops_in: left(p), ...(r.already ? { already: true } : {}), ...(p.status !== 'live' ? { hint: 'Call preview_logs to see why it is not live yet.' } : {}) };
    },

    async preview_stop(a) {
      const r = await call('POST', `previews/${enc(need(a, 'id'))}/stop`, {});
      return { id: r.preview.id, status: r.preview.status, ...(r.killed ? { killed_server: true } : {}), note: 'The link now shows the last snapshot; preview_start brings it back.' };
    },

    async preview_restart(a) {
      const r = await call('POST', `previews/${enc(need(a, 'id'))}/restart`, { wait: a.wait ?? 30 });
      return { url: r.preview.url, status: r.preview.status, stops_in: left(r.preview) };
    },

    async preview_edit(a) {
      noLocalOnly(a);
      const id = need(a, 'id');
      const body = {};
      for (const k of ['name', 'ttl', 'entry', 'cmd']) if (a[k] !== undefined) body[k] = a[k];
      if (a.cwd !== undefined) body.cwd = a.cwd ? path.resolve(a.cwd) : '';
      if (a.private !== undefined) body.private = !!a.private;
      if (a.target !== undefined) body.target = remote ? checkRemoteTarget(a.target) : localTarget(a.target);
      if (!Object.keys(body).length) fail('nothing to change');
      const r = await call('PATCH', `previews/${enc(id)}`, body);
      return { preview: detail(r.preview), changed: r.changed };
    },

    async preview_logs(a) {
      const r = await call('GET', `previews/${enc(need(a, 'id'))}/logs?lines=${Math.min(Number(a.lines) || 60, 2000)}`);
      return { id: r.id, log: r.log && r.log.trim() ? r.log : '(no output captured; only hub-started servers log here)' };
    },

    async preview_delete(a) {
      const r = await call('DELETE', `previews/${enc(need(a, 'id'))}`);
      return { deleted: r.deleted };
    },

    async preview_login_link(a) {
      const r = await call('POST', 'magic', { ttl: a.ttl });
      return { login_link: r.url, single_use: true, note: 'Logs a browser into the dashboard for a year. Send it only to the owner of this hub.' };
    },

    async preview_status() {
      const s = await call('GET', 'state');
      return { hub: `running v${s.hub.version}`, tunnel: s.hub.tunnel.status, dashboard: `${s.hub.publicBase}/`, counts: s.counts };
    },
  };
}

// ------------------------------------------------------------ JSON-RPC

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Returns handle(message) -> response object, array, or null for notifications.
export function createMcpServer({ call, remote = false, by = null, log = () => {} }) {
  const tools = toolDefs(remote);
  const names = new Set(tools.map(t => t.name));
  let clientBy = by;
  let handlers = makeHandlers({ call, remote, by: clientBy });

  async function one(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && 'id' in msg && !('method' in msg) ? null : rpcError(msg?.id, -32600, 'invalid request');
    }
    const { id, method, params = {} } = msg;
    const isNote = !('id' in msg);
    if (isNote) return null;
    try {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          if (!by && params.clientInfo?.name) { clientBy = String(params.clientInfo.name).slice(0, 40); handlers = makeHandlers({ call, remote, by: clientBy }); }
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'preview', title: 'Preview links', version: VERSION },
              instructions: INSTRUCTIONS + (remote ? REMOTE_NOTE : ''),
            },
          };
        }
        case 'ping': return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list': return { jsonrpc: '2.0', id, result: { tools } };
        case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } };
        case 'resources/templates/list': return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
        case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } };
        case 'tools/call': {
          const name = params.name;
          if (!names.has(name)) return rpcError(id, -32602, `unknown tool "${name}"`);
          const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
          const t0 = Date.now();
          try {
            const out = await handlers[name](args);
            log('tool', name, 'ok', `${Date.now() - t0}ms`);
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } };
          } catch (e) {
            log('tool', name, 'error', e.message);
            let text = `Error: ${e.message}`;
            if (e.code === 'NOT_FOUND' || /^no preview/.test(e.message)) text += '\nCall preview_list with all=true to see ids.';
            if (e.code === 'HUB_DOWN') text += '\nThe preview hub is down; ask the owner to run `preview hub start` on that computer.';
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
          }
        }
        default: return rpcError(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      return rpcError(id, -32603, e.message);
    }
  }

  return async function handle(msg) {
    if (Array.isArray(msg)) {
      if (!msg.length) return rpcError(null, -32600, 'empty batch');
      const out = (await Promise.all(msg.map(one))).filter(Boolean);
      return out.length ? out : null;
    }
    return one(msg);
  };
}
