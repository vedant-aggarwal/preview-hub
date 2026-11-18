// PM2 process file: keeps the preview hub running, and ngrok too if that is your tunnel.
//
//   pm2 start ecosystem.config.cjs --only preview-hub     # hub only (Cloudflare Tunnel users)
//   pm2 start ecosystem.config.cjs                        # hub + ngrok on your free ngrok dev domain
//   pm2 save                                              # remember the list; see ONBOARDING.md for start at boot
//
// Options are read from the environment when you run `pm2 start` (PM2 stores them on `pm2 save`):
//   NGROK_URL   paid ngrok plans: a reserved/custom domain, e.g. https://preview.example.com
//               (free plans leave it unset: ngrok then uses your account's dev domain)
//   NGROK_BIN   full path to the ngrok binary if PM2 cannot find it on PATH
//   PREVIEW_HUB_PUBLIC_PORT   hub port the tunnel forwards to (default 7420)
// On Windows, `preview hub install` (a logon task) can keep the hub alive instead; then start only ngrok:
//   pm2 start ecosystem.config.cjs --only preview-ngrok
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const port = process.env.PREVIEW_HUB_PUBLIC_PORT || '7420';

function findNgrok() {
  if (process.env.NGROK_BIN) return process.env.NGROK_BIN;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ngrok'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return hits.find(h => /\.exe$/i.test(h)) || hits[0] || 'ngrok';
  } catch { return 'ngrok'; }
}

module.exports = {
  apps: [
    {
      name: 'preview-hub',
      script: path.join(__dirname, 'src', 'hub.js'),
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 1000,
      windowsHide: true,
      env: { PREVIEW_HUB_PUBLIC_PORT: port },
    },
    {
      name: 'preview-ngrok',
      script: findNgrok(),
      interpreter: 'none',
      // 127.0.0.1, not localhost: the hub listens on IPv4 loopback only.
      args: ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'logfmt', ...(process.env.NGROK_URL ? ['--url', process.env.NGROK_URL] : [])],
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 1000,
      windowsHide: true,
    },
  ],
};
