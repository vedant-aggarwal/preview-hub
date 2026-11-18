---
name: preview
description: Share anything running or stored on this computer as a permanent public link (<public-url>/<id>/) using the `preview` CLI from preview-hub. Use instead of `cloudflared tunnel --url`, trycloudflare or quick ngrok links whenever the user (or anyone off this machine) needs to open a local dev server, HTML page, video, image, PDF or folder - "send me a link", "preview this", "share this video", "host this folder", "I'm away, show me". Also for stopping, restarting, extending or listing those previews, and for MCP tokens for bots.
---

# preview: permanent preview links

`preview` publishes a local server, file or folder at `<public-url>/<id>/`. Links survive restarts and do not expire after two hours like a quick tunnel. The user sees every preview on the dashboard at the public URL with no path (live ones on top, stopped ones below with their last snapshot and a Start button).

Run `preview` first: it prints the hub status and the dashboard URL. If the command is missing or says `public: not set`, the hub is not set up yet; offer to follow ONBOARDING.md in the preview-hub repo.

## Publish

Server already running (you started it in this session):
```
preview add 5173 --name "Landing page" --cmd "npm run dev" --cwd /path/to/project --by claude
```
The hub attaches to the running port. `--cmd` and `--cwd` are saved so the user can press Start on the dashboard after your server dies.

Let the hub start and own the server (preferred when you don't need it in your own terminal; the hub kills it at expiry):
```
preview add --start --cmd "npm run dev" --cwd /path/to/project --name "App" --ttl 4h --by claude
```
The port is read from the server's output. Pass a port first (`preview add 3000 --start --cmd ...`) when the command does not print its URL.

Files and folders (videos stream with seeking, images, PDFs, audio and text get a viewer, a folder with `index.html` is served as a site, and other folders get a media grid):
```
preview add "/path/to/Launch Film.mp4" --by claude
preview add /path/to/dist --name "Landing build" --ttl 2d --by claude
```

The result prints `url`. Send that URL to the user. Adding the same target again returns the same link (`already: true`) and restarts it if it was stopped, so re-running is safe.

## Flags worth choosing

- `--ttl`: 30m, 4h (server default), 2d, 7d (file default), never. Pick the shortest that covers the need. Expiry stops the preview and kills hub-started servers.
- `--by <agent>`: always set it (claude, codex, ...). The dashboard shows it.
- `--private`: viewers must log in with the hub passcode. Default links are open to anyone who has them.
- `--entry /dashboard`: open the link at a sub-path.

## Manage

```
preview                    # running previews + hub/tunnel status
preview list --all         # include stopped
preview show <id>          # details + last log lines
preview stop <id>          # unpublish. Kills the server only if the hub started it. Snapshot stays
preview start <id>         # bring back (runs the saved --cmd if the port is down)
preview restart <id>
preview edit <id> --ttl 4h # also --name --target --cmd --cwd --private true|false
preview logs <id>
preview rm <id>            # delete preview + snapshot
preview login-link         # one-time URL that logs the owner's browser into the dashboard for a year
```

## MCP for bots

- Cloud bots (Grok, claude.ai, ChatGPT connectors): `preview mcp token <bot-name>` prints a connector URL `<public-url>/_hub/mcp/<token>` once, and the user pastes it as a custom connector. Add `--qr` for the phone app: it prints a QR in the terminal and saves a PNG to scan. `preview mcp revoke <bot-name>` cuts access. These bots get remote-safe tools.
- Local agents that only speak MCP: `node <repo>/bin/preview-mcp.js` (stdio, full access).
- Agents with a shell should use the CLI.

## Rules

- Use this before reaching for a quick tunnel. Fall back to one only when `preview hub status` says the hub cannot run.
- Check the server answers before you send a link to one you attached (`status: live`). `down` means the hub reached nothing: start the server or use `--start`.
- Dev servers work through the link, including hot reload. Apps that hard-code `http://localhost:<port>` in API calls break off this machine. Point them at relative paths.
- Don't publish secret folders, `.env` files, or the whole home directory. A folder link exposes every file under it.
- When you finish, stop servers you no longer need (`preview stop <id>`), or leave the TTL to do it.

## How it works (for debugging)

- Data: `~/.preview-hub` (state.json, cache/ snapshots, shots/, logs/hub.log). `preview hub logs` shows the hub log.
- Port 7420 is the public side behind the tunnel (dashboard needs the passcode), and 7421 is loopback-only and trusted (CLI, screenshots).
- Absolute asset paths (`/assets/x.js`) resolve through the Referer or a `pvh_ctx` cookie, so most apps work without a base path.
- A stopped or unreachable preview serves the last cached responses with a "Start server" banner.
