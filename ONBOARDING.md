# Onboarding

Instructions for the AI agent (Claude Code, Codex, or similar) that is setting up preview-hub for the person in front of it. Read all of it once, then work through the steps in order.

How to run this:

- Run every command yourself. Ask the person only for things you cannot do: creating an account, copying a token from a dashboard, choosing a domain.
- Keep each message to the person short: what you did, then what you need from them.
- Never paste their tokens into chat output, a commit, or a file inside this repo. When a token is needed, have them run the command themselves in their own terminal, or write it to a file in their home folder and delete it after use.
- If a step is already done (check first), say so in one line and move on.
- Finish with Step 9 every time: teach them how to use what you set up.

## Step 0: look around

```
node --version          # need 20 or newer
git --version
preview hub status      # "command not found" means not installed yet
```

Note the OS (Windows, macOS, Linux). Later steps differ by OS. If `preview hub status` already shows a public URL with `public_check: ok`, jump to Step 6.

If Node is missing or older than 20, tell them how to install it (nodejs.org, `winget install OpenJS.NodeJS.LTS`, `brew install node`, or their distro's package manager) and wait.

## Step 1: install

From this repo's folder:

```
npm install
npm link
preview --help
```

`npm link` puts two commands on PATH: `preview` (CLI) and `preview-mcp` (MCP server). If `npm link` fails on permissions (macOS/Linux with a system Node), use `sudo npm link`, or suggest a Node version manager.

## Step 2: start the hub and keep it running

The hub is a small Node server. Port 7420 is its public side: the tunnel points there, and the dashboard needs a passcode. Port 7421 is loopback-only and trusted (the CLI talks to it). Data and secrets live in `~/.preview-hub/`, never in this repo.

**Windows:** a logon task that restarts the hub if it exits. No admin needed.

```
preview hub install
```

**macOS / Linux:** PM2.

```
npm install -g pm2
pm2 start ecosystem.config.cjs --only preview-hub
pm2 save
pm2 startup        # prints one command. Run it (needs sudo) so PM2 starts at boot
```

Check it, then try a local link:

```
preview hub status                     # hub: running, public: not set
preview add README.md --name "Hello" --ttl 30m
```

The link printed is `http://localhost:7420/hello-xxxx/`. It works on this machine only until Step 3. Remove it with `preview rm <id>`.

## Step 3: choose how links reach the internet

Ask the person which one they want. Give them this comparison in your own short words:

| | Cloudflare Tunnel | ngrok |
| --- | --- | --- |
| Cost | Free | Free plan, paid plans remove limits |
| Needs | A domain whose DNS is on Cloudflare (free account) | Nothing but a free ngrok account |
| Link looks like | `https://preview.yourdomain.com/<id>/` | `https://your-name.ngrok-free.app/<id>/` (custom domain on paid plans) |
| Limits | None that matter for previews | Free: 1 GB data out and 20,000 HTTP requests a month, 4,000 requests a minute |
| Browser warning page | No | Free: visitors see an ngrok warning page once, then a cookie hides it for 7 days. API and MCP clients never see it. |

Rough guide: they own a domain, or will buy one → Cloudflare. They want it working in five minutes and share lightly → ngrok. A dev server with hot reload or a few videos can use 1 GB fast, so heavy users should go Cloudflare or a paid ngrok plan.

If they only need links on their own network or over Tailscale, they can skip tunnels. Links then stay on `http://<this-machine>:7420`. Add `"publicBinds": ["<LAN or Tailscale IP>"]` to `~/.preview-hub/config.json` and run `preview hub restart` so the hub listens there, then set `preview hub public-url http://<that-ip>:7420 --via lan`.

## Step 4A: Cloudflare Tunnel

Install cloudflared if `cloudflared --version` fails:

- Windows: `winget install --id Cloudflare.cloudflared`
- macOS: `brew install cloudflared`
- Linux: follow Cloudflare's package instructions for their distro (developers.cloudflare.com, "cloudflared downloads")

**Option 1 (recommended): dashboard tunnel, the hub runs cloudflared.** No PM2 needed. The hub restarts cloudflared itself and checks the public URL every minute.

1. The person, in the Cloudflare dashboard: open Zero Trust, then Networks → Tunnels, and create a tunnel of type Cloudflared named `preview-hub`. On the install screen they copy the token (the long string after `--token`). They do not need to run Cloudflare's install command.
2. In the same tunnel, add a public hostname route: subdomain `preview` (or any), their domain, service type `HTTP`, URL `127.0.0.1:7420`. Dashboard labels move around. The idea is "hostname → http://127.0.0.1:7420".
3. Have them save the token to a file outside this repo, for example `~/cf-tunnel-token.txt`. Then run:

```
preview hub tunnel ~/cf-tunnel-token.txt --public-url https://preview.example.com
```

4. Delete the token file (the hub keeps the token in `~/.preview-hub/config.json`).
5. Wait about 30 seconds, then run `preview hub status` and look for `public_check: ok`.

**Option 2: they run cloudflared themselves** (locally managed tunnel, or they already have one):

```
cloudflared tunnel login
cloudflared tunnel create preview-hub
cloudflared tunnel route dns preview-hub preview.example.com
```

Write `~/.cloudflared/config.yml` with the tunnel id from `create`:

```yaml
tunnel: <tunnel-id>
credentials-file: <path printed by create>
ingress:
  - hostname: preview.example.com
    service: http://127.0.0.1:7420
  - service: http_status:404
```

Keep it running with `cloudflared service install` (built in), or with PM2: `pm2 start cloudflared --name preview-tunnel -- tunnel run preview-hub`, then `pm2 save`. Then:

```
preview hub public-url https://preview.example.com --via cloudflare
preview hub status
```

## Step 4B: ngrok, with a permanent URL and PM2

1. **Account and token.** The person signs up at ngrok.com (free), opens dashboard.ngrok.com → "Your Authtoken", and runs this themselves in their own terminal so the token stays out of chat:

```
ngrok config add-authtoken <their-token>
```

2. **Install ngrok** if `ngrok version` fails: Windows `winget install ngrok.ngrok`, macOS `brew install ngrok`, Linux from ngrok's download page. Run `ngrok version` to confirm v3.

3. **Get the permanent domain.** Have them open dashboard.ngrok.com/domains and copy their domain. Every account, free included, has one fixed dev domain such as `your-name.ngrok-free.app` (some show `.ngrok-free.dev`). If the page lists none, they create the free one there. Paid plans can add a custom domain like `preview.example.com`.

   Always pass this domain with `--url`. Without `--url`, some accounts get a random address that changes on every restart (seen in testing: `5f73-….ngrok-free.app` became `b309-….ngrok-free.app` after a restart). A changing address breaks every link already shared.

4. **Test it once in the foreground:**

```
ngrok http 127.0.0.1:7420 --url https://your-name.ngrok-free.app
```

Use `127.0.0.1`, not `localhost`: the hub listens on IPv4 loopback only. In another terminal run `preview hub public-url https://your-name.ngrok-free.app --via ngrok`, then `preview hub status` and look for `public_check: ok`. Stop the foreground ngrok with Ctrl+C.

5. **Keep it running forever with PM2.** `ecosystem.config.cjs` in this repo defines two apps: `preview-hub` and `preview-ngrok`.

```
npm install -g pm2
```

Windows (PowerShell). The hub already runs from the logon task, so start ngrok only:

```
$env:NGROK_URL = "https://your-name.ngrok-free.app"
pm2 start ecosystem.config.cjs --only preview-ngrok
pm2 save
```

macOS / Linux, hub and ngrok together. If the hub is already in PM2 from Step 2, add `--only preview-ngrok`:

```
NGROK_URL=https://your-name.ngrok-free.app pm2 start ecosystem.config.cjs
pm2 save
```

If PM2 cannot find ngrok, set `NGROK_BIN` to the full path of the ngrok binary in the same way as `NGROK_URL`. Without the file, the equivalent is `pm2 start ngrok --name preview-ngrok --interpreter none -- http 127.0.0.1:7420 --url https://your-name.ngrok-free.app --log stdout`.

6. **Start at boot.**
   - macOS / Linux: `pm2 startup`, run the command it prints, then `pm2 save`.
   - Windows: PM2's own `startup` does not support Windows. Use `npm install -g pm2-windows-startup`, then `pm2-startup install` (adds a logon entry that runs `pm2 resurrect`), then `pm2 save`. Verify after the next reboot with `pm2 status`.

7. **Prove the URL is permanent:**

```
pm2 restart preview-ngrok
pm2 logs preview-ngrok --lines 20 --nostream    # look for url=https://your-name...
preview hub status                               # public_check: ok
```

The URL in the log must be the same as before the restart.

8. **Tell them about the free-plan limits** (Step 3 table): the warning page, 1 GB data and 20,000 requests a month. MCP connectors and the iPhone app send non-browser requests, so they never see the warning page.

Useful later: `pm2 status`, `pm2 logs preview-ngrok`, `pm2 restart preview-ngrok`, and ngrok's local inspector at http://127.0.0.1:4040.

## Step 5: check it end to end

```
preview add README.md --name "Hello" --ttl 30m
```

Ask them to open the printed link on their phone with Wi-Fi off. Then:

```
preview passcode        # dashboard passcode
preview login-link      # one-tap dashboard login for their browser (single use, 24 h)
preview rm <id>         # remove the test preview
```

The dashboard is the public URL with no path. Live previews are on top, and stopped ones sit below with their last snapshot and a Start button.

## Step 6: connect their agents

**Agents with a shell** such as Claude Code or Codex only need the skill, which teaches them the CLI. Copy the folder:

- Claude Code: `skills/preview` → `~/.claude/skills/preview`
- Codex and other agents that read `~/.agents/skills`: `skills/preview` → `~/.agents/skills/preview`

**MCP clients without a shell, or ones they prefer to give tools** (stdio, full access, same as the CLI). Use the absolute path of this repo:

- Claude Code: `claude mcp add preview -s user -- node <repo>/bin/preview-mcp.js`
- Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.preview]
command = "node"
args = ["<repo>/bin/preview-mcp.js"]
```

- Claude Desktop, in `claude_desktop_config.json` under `mcpServers`: `"preview": { "command": "node", "args": ["<repo>/bin/preview-mcp.js"] }`

**Cloud bots and connectors** (Grok, claude.ai custom connectors, ChatGPT, anything that runs off this machine) use one token per bot:

```
preview mcp token grok
```

It prints a connector URL `<public-url>/_hub/mcp/<token>` once. They paste it into the bot's custom connector or MCP settings. If a client wants a header instead, use `<public-url>/_hub/mcp` with `Authorization: Bearer <token>`. `preview mcp` lists tokens and when each was last used. `preview mcp revoke grok` cuts one off.

Cloud bots get remote-safe tools: they cannot run start commands, and they cannot publish the home folder, dot folders, AppData, `private` or `personal-docs` folders, secret files, or folders that hold `.env` or `.git`. They can still publish content they send (`preview_publish_content`, up to 25 MB).

## Step 7: phone app (optional)

If the preview-hub iPhone app is available to them, it connects to any hub. In the app they add their hub URL (the public URL), log in with the passcode. For the native preview list, run `preview mcp token phone --qr` and scan the QR with the app's Scan QR code (it prints in the terminal and saves a PNG; delete the PNG after scanning).

## Step 8: security briefing (say this briefly)

- A link works for anyone who has it, like a quick tunnel. Use `--private` for previews that should need the passcode.
- A folder link exposes every file under it. Never publish the home folder, `.env` files, or secrets.
- The passcode and tokens are in `~/.preview-hub/config.json`. `preview passcode set <new>` changes the passcode and logs out every browser.
- Hub-started servers (`--start`) are killed at expiry. Attached servers are only unpublished.

## Step 9: teach them how to use it

Finish by giving them a short tour tailored to what you set up. Six to ten lines, not this whole list. Cover:

- Telling their agent "preview this", "send me a link to the dev server", "share this video", or "stop that preview". The skill or MCP handles the rest.
- The commands, if they like terminals:

```
preview                                    # what is running
preview add 5173 --name "Landing page"     # a dev server already running on port 5173
preview add --start --cmd "npm run dev" --cwd ~/app --ttl 4h   # hub starts the server and owns it
preview add ~/Videos/demo.mp4              # file: video with seeking, image, PDF, audio, text viewer
preview add ~/site/dist --ttl 2d           # folder: served as a site if it has index.html
preview stop <id> | start <id> | restart <id> | rm <id>
preview edit <id> --ttl 7d                 # also --name, --private true, --entry /path
preview logs <id>
preview login-link                         # dashboard on a new device
```

- The options that matter: `--ttl` (30m, 4h default for servers, 7d default for files, never), `--private`, `--cmd` with `--cwd` so the dashboard Start button works later, `--start` so the hub owns the process.
- Adding the same target again returns the same link and restarts it if it was stopped.
- Where things are: the dashboard at the public URL, data in `~/.preview-hub`, and hub logs via `preview hub logs`.
- Their tunnel: `pm2 status` and `pm2 logs preview-ngrok` for ngrok, or `preview hub status` for a hub-run Cloudflare tunnel.

Then ask if they want anything else connected (another bot token, the phone app, a second machine).
