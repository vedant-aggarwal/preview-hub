# AGENTS.md

You are in **preview-hub**: permanent public links (`<public-url>/<id>/`) for local dev servers, files and folders, with a dashboard, snapshots, expiry, a CLI (`preview`) and an MCP server (`preview-mcp`, plus an HTTP endpoint for cloud bots).

## First thing to do

Run `preview hub status` (or `node bin/preview.js hub status` if the command is not on PATH yet).

- Command not found, hub not running, or `public: not set` → the person probably wants it set up. Offer to onboard them, and if they agree follow [ONBOARDING.md](ONBOARDING.md) step by step. It covers install, keeping the hub running, Cloudflare Tunnel or ngrok (permanent URL, PM2), connecting agents and bots, and a closing tour of how to use it.
- `public_check: ok` → it is set up. Help with what they ask: publishing something (`preview add ...`), MCP tokens (`preview mcp token <bot>`), or working on the code.

## Layout

| Path | What |
| --- | --- |
| `src/hub.js` | The hub: reverse proxy (HTTP and WebSocket), static files and viewers, snapshots, auth, process supervision, expiry, tunnel and public-URL probe, MCP HTTP endpoint |
| `src/mcp.js` | MCP tools and JSON-RPC handling, shared by stdio and HTTP. Remote-safe limits live here. |
| `src/client.js` | Hub client used by the CLI and the stdio MCP server; output shaping |
| `src/store.js` | Data dir (`~/.preview-hub`, override `PREVIEW_HUB_HOME`), ports (7420 public, 7421 loopback; override `PREVIEW_HUB_PUBLIC_PORT` / `PREVIEW_HUB_LOCAL_PORT`), config and state files |
| `src/procs.js`, `src/cache.js`, `src/util.js` | Process control, snapshot cache, helpers |
| `bin/preview.js` | AXI-style CLI (`preview`). `preview --help`, `preview <command> --help` |
| `bin/preview-mcp.js` | stdio MCP server |
| `ui/` | Dashboard, login page and viewer styles (plain HTML, CSS and JS) |
| `ecosystem.config.cjs` | PM2 apps: `preview-hub`, `preview-ngrok` |
| `scripts/` | Windows logon task (`preview hub install`) |
| `skills/preview/SKILL.md` | Agent skill that teaches the CLI; copied to `~/.claude/skills` or `~/.agents/skills` during onboarding |

## Rules

- Secrets (passcode, session key, tunnel token, MCP token hashes) live in `~/.preview-hub/config.json`. Never copy them into this repo, a commit, or chat output. Ask the person to run token commands themselves.
- Port 7421 is trusted because it binds 127.0.0.1 only. Never expose it, tunnel it, or bind it elsewhere.
- Anything reachable from the public port must stay behind the passcode or an MCP token. The `/_hub/mcp` remote path must keep its limits (no start commands, no secret or system folders).
- Keep dependencies minimal: the hub uses only Node built-ins plus `axi-sdk-js` for the CLI.
- After changing hub code, run `preview hub restart` and check `preview hub status`.
- Test MCP changes over stdio (`node bin/preview-mcp.js`) and over HTTP (`http://127.0.0.1:7421/_hub/mcp`, or the public URL with a token).
