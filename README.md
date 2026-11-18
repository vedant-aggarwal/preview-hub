# preview-hub

Permanent public links for anything on your computer: a dev server, a video, a PDF, a built site, or a page your AI agent just made. Links look like `https://preview.yourdomain.com/landing-x7k2/` (or your ngrok domain) and keep working across restarts, unlike two-hour quick tunnels.

Built for AI agents. Claude Code, Codex and other agents use the `preview` CLI through a skill. MCP clients and cloud bots (Grok, claude.ai connectors, ChatGPT) use the built-in MCP server.

## What it does

- **Servers:** `preview add 5173` shares a running dev server, with WebSockets and hot reload. With `--start --cmd "npm run dev"` the hub starts the server itself and stops it when the link expires.
- **Files and folders:** videos stream with seeking; images, PDFs, audio and text open in a viewer. A folder with `index.html` is served as a site, and any other folder gets a media grid.
- **Content from bots:** `preview_publish_content` takes HTML or base64 files from an agent that cannot reach your disk and returns a link.
- **Snapshots:** when a server stops, its link shows the last cached version with a Start button instead of an error.
- **Expiry:** each link has a TTL (30m, 4h, 7d, never). Expired previews stop; stopped ones can be started again from the dashboard.
- **Dashboard:** your public URL with no path. It shows live and stopped previews with thumbnails, start, stop, edit, logs and delete. It is protected by a passcode, and `preview login-link` gives a one-tap login.
- **Private links:** `--private` makes viewers log in with the passcode.

## Quick start (let your agent do it)

```
git clone https://github.com/vedant-aggarwal/preview-hub
cd preview-hub
claude        # or: codex
```

Then say **"set me up"**. The agent reads [AGENTS.md](AGENTS.md) and [ONBOARDING.md](ONBOARDING.md) and walks you through it: install, keeping the hub running, putting it on the internet with Cloudflare Tunnel or ngrok, connecting your agents and bots, and a short tour of the commands.

## Manual setup

Requires Node 20+.

```
npm install
npm link                      # puts `preview` and `preview-mcp` on PATH
preview hub install           # Windows: logon task keeps the hub running
pm2 start ecosystem.config.cjs --only preview-hub && pm2 save   # macOS/Linux
```

Expose port 7420 with a tunnel, then tell the hub its public URL:

```
# ngrok (free account; use the fixed domain from dashboard.ngrok.com/domains)
ngrok http 127.0.0.1:7420 --url https://your-name.ngrok-free.app
preview hub public-url https://your-name.ngrok-free.app --via ngrok

# or Cloudflare Tunnel: the hub runs cloudflared with a dashboard tunnel token
preview hub tunnel ~/cf-token.txt --public-url https://preview.example.com

preview hub status            # public_check: ok
```

[ONBOARDING.md](ONBOARDING.md) has the full steps, including keeping ngrok running with PM2 and starting everything at boot.

| | Cloudflare Tunnel | ngrok free |
| --- | --- | --- |
| Needs | A domain on Cloudflare | A free account |
| Limits | None that matter here | 1 GB data and 20,000 requests a month |
| Browser warning page | No | Once per visitor every 7 days (not for API or MCP clients) |

## Everyday commands

```
preview                                   # running previews and hub status
preview add 5173 --name "Landing" --cmd "npm run dev" --cwd ~/app   # attach; saved command powers Start
preview add --start --cmd "npm run dev" --cwd ~/app --ttl 4h        # hub starts and owns the server
preview add ~/Videos/demo.mp4             # file viewer
preview add ~/site/dist --ttl 2d          # folder or site
preview list --all | show <id> | logs <id>
preview stop <id> | start <id> | restart <id> | rm <id>
preview edit <id> --ttl 7d --private true
preview login-link                        # one-time dashboard login
preview passcode [set <new>]
preview mcp [token <bot> | revoke <bot>]
preview hub status | restart | logs | public-url <url> | tunnel <token-file>
```

Adding the same target again returns the same link and restarts it if it was stopped.

## MCP

Twelve tools: `preview_list`, `preview_show`, `preview_add`, `preview_publish_content`, `preview_start`, `preview_stop`, `preview_restart`, `preview_edit`, `preview_logs`, `preview_delete`, `preview_login_link`, `preview_status`.

- **Local, stdio, full access:** `node <repo>/bin/preview-mcp.js` (or `preview-mcp`). Example: `claude mcp add preview -s user -- node <repo>/bin/preview-mcp.js`.
- **Local HTTP-only clients:** `http://127.0.0.1:7421/_hub/mcp`. No token is needed; this port is loopback only.
- **Cloud bots:** `preview mcp token <bot>` prints `<public-url>/_hub/mcp/<token>` once. Paste it as a custom connector, or send `Authorization: Bearer <token>` to `<public-url>/_hub/mcp`. This is stateless Streamable HTTP with JSON responses.

Cloud bots get remote-safe tools. They cannot run start commands, and they cannot publish drive roots, the home folder, dot folders, AppData, `private` or `personal-docs` folders, secret files, or folders that hold `.env` or `.git`.

## How it works

```
browser / bot ──> tunnel (Cloudflare or ngrok) ──> hub :7420 ──> your dev server, file or folder
CLI, stdio MCP ──> hub :7421 (127.0.0.1 only, trusted)
```

- The hub is plain Node with no framework. State, snapshots, screenshots and logs live in `~/.preview-hub` (`PREVIEW_HUB_HOME` overrides it).
- Absolute asset paths such as `/assets/app.js` resolve through the Referer header or a context cookie, so most apps work without a base path.
- Each successful GET through the proxy is cached per preview, and that cache serves the snapshot when the server is down.
- Dashboard thumbnails use a local Chrome, Edge or Chromium in headless mode if one is installed (`PREVIEW_CHROME` overrides the path).
- Every minute the hub fetches its own public URL with a nonce, so `preview hub status` knows whether the tunnel actually reaches it. A hub-run cloudflared is restarted after repeated failures.

## Security

- A link works for anyone who has it. Use `--private` for anything that should need the passcode.
- A folder link exposes every file under it. Don't share your home folder, `.env` files or secrets.
- Port 7421 trusts whoever connects, so it binds to 127.0.0.1 only. Port 7420 needs the passcode (dashboard) or an MCP token (`/_hub/mcp`).
- MCP tokens are stored as HMAC hashes. Changing the passcode logs out every browser.

## Status

Windows is the main tested platform (logon task, process control, PM2 and ngrok verified). macOS and Linux run the hub under PM2. On those systems, killing a hub-started server falls back to its process group.

## Privacy

See [PRIVACY.md](PRIVACY.md). The hub and the iPhone app send nothing to the developers.

## License

MIT
