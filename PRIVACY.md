# Privacy

This page covers preview-hub (the server you run yourself) and Previews, the iPhone app for it.

## preview-hub

- You run the hub on your own computer. It sends nothing to the project's developers: no accounts, no analytics, no telemetry.
- Everything it stores stays on that computer in `~/.preview-hub`: preview settings, snapshots of pages served through it, screenshots, logs, the dashboard passcode and session key, and hashes of MCP tokens.
- Previews are reachable through the tunnel you choose (Cloudflare Tunnel, ngrok or another). That provider carries the traffic under its own privacy policy.
- Anyone with a preview link can open it unless the preview is private. Only share links you mean to share.

## Previews iPhone app

- The app talks only to the hubs you add. It has no account, no analytics, no advertising and no tracking. The developer receives none of your data.
- Hub addresses are stored on the phone. Phone links (hub access tokens) and hub sign-in cookies are stored in the phone's Keychain and sent only to the hub they belong to. Removing a hub deletes them.
- The camera is used only to scan a hub's QR code. No image is stored or sent.
- Pages you open load from your own hub. What those pages collect is up to whoever made them.

## Contact

Questions and support: https://github.com/vedant-aggarwal/preview-hub/issues

Last updated: 19 November 2026
