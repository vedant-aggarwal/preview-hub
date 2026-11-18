#!/usr/bin/env node
// preview-mcp: stdio MCP server for the preview hub, for local agents (Claude Desktop, Codex, Hermes, Grok CLI...).
// Full access, same as the `preview` CLI. Cloud bots use the hub's HTTP endpoint instead: `preview mcp`.
// Speaks newline-delimited JSON-RPC on stdin/stdout; diagnostics go to stderr only.
import readline from 'node:readline';
import { call } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';

const by = process.env.PREVIEW_BY || null; // default: the client's own name from initialize
const handle = createMcpServer({
  call, remote: false, by,
  log: process.env.PREVIEW_MCP_DEBUG ? (...a) => process.stderr.write(`[preview-mcp] ${a.join(' ')}\n`) : () => {},
});

const write = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0, closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

rl.on('line', async line => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  pending++;
  try {
    const res = await handle(msg);
    if (res) write(res);
  } catch (e) {
    write({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e.message } });
  } finally { pending--; maybeExit(); }
});
rl.on('close', () => { closed = true; maybeExit(); });
