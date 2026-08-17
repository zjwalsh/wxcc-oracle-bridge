# WxCC Oracle CTI Widget

A headless bridge between Cisco Webex Contact Center (WxCC) Agent Desktop
and Oracle Fusion's Media Toolbar CTI framework. It has no UI — it relays
call events from WxCC to Oracle (`CALL_INCOMING`, `CALL_CONNECTED`,
`CALL_HELD`, `CALL_WRAPUP`, `CALL_ENDED`, `SCREEN_POP`) and dispatches
commands from Oracle back into WxCC (`MAKE_CALL`, `HANGUP`, `HOLD`,
`RETRIEVE`, `SET_READY`, `SET_NOT_READY`, `COMPLETE_WRAP_UP`).

## Architecture

- [src/services/WxCCService.ts](src/services/WxCCService.ts) — wraps
  `@wxcc-desktop/sdk`, maps WxCC contact events to Oracle CTI events, and
  routes Oracle commands to WxCC SDK calls.
- [src/services/OracleCTIService.ts](src/services/OracleCTIService.ts) —
  sends/receives cross-origin `postMessage` traffic to Oracle Fusion.
- [src/services/logger.ts](src/services/logger.ts) — shared logger backed
  by `Desktop.logger`, so entries land in WxCC Desktop's own exportable
  agent logs, not just the browser console.
- [src/bridge.ts](src/bridge.ts) — the actual deployed entry point. No
  React, no DOM rendering — just calls `wxcc.init()` / `oracleCTI.init()`.
- [src/App.tsx](src/App.tsx) / [src/components/MediaToolbar.tsx](src/components/MediaToolbar.tsx) —
  an optional visible call-control panel (Accept/Hold/Hangup), currently
  unused by the deployed bridge but kept in case a visible panel widget is
  wanted later. Useful today as a local dev sandbox (`npm run dev`).

### Why two builds

`@wxcc-desktop/sdk` expects a global `window.AGENTX_SERVICE`, which the
real WxCC Desktop host injects into its own document *before* a widget's
script runs. That only works for scripts WxCC Desktop loads directly into
its own page — not for content in a separately-loaded iframe, which can
never have a global pre-seeded into it before its own scripts execute.

So the bridge must be registered as an `agentx-custom-desktop` widget
(script injection), not `agentx-wc-iframe`:

```json
"headless": {
  "id": "dw-headless",
  "widgets": {
    "bridge": {
      "comp": "agentx-custom-desktop",
      "script": "https://your-host/wxcc-oracle-bridge.js"
    }
  },
  "layout": { "areas": [["bridge"]], "size": { "cols": [1], "rows": [1] } }
}
```

## Development

```bash
npm run dev          # SPA sandbox at src/main.tsx — visual dev/testing only
npm run build         # same SPA, for local testing/preview
npm run build:widget  # THE deployable artifact: public/wxcc-oracle-bridge.js
npm run lint
```

`build:widget` outputs into `public/` (not a separate directory) *on
purpose*: `npm run dev` serves `public/` directly, so once you've built
it, `/wxcc-oracle-bridge.js` is immediately reachable at whatever URL
you're already tunneling `npm run dev` through — no separate static
file server needed for local testing. It's git-ignored (build output,
not source) — rebuild it any time `bridge.ts` or the services it uses
change; the running dev server picks up the new file without a restart.

Outside a real WxCC Desktop session, `window.AGENTX_SERVICE` doesn't
exist and the SDK throws `ReferenceError: AGENTX_SERVICE is not defined`
at import time. [public/agentx-mock.js](public/agentx-mock.js) stubs it
for local dev (`npm run dev`) — it's a no-op if the real global is
already present, so it's safe to leave in. From the browser console you
can simulate WxCC events end-to-end:

```js
__mockWxCC.fire("agentContact", "eAgentOfferContact", {
  interactionId: "abc123", ani: "+15551234567", dnis: "100", queueName: "Support"
})
```

## Deploying

- **Testing against a real Desktop session**: `npm run build:widget`,
  keep `npm run dev` running and reachable over HTTPS (e.g. via
  `tailscale serve`), and point the layout's `script` at
  `https://<your-tunnel-host>/wxcc-oracle-bridge.js`.
- **Real deployment**: take `public/wxcc-oracle-bridge.js` (or the copy
  under `dist/` after `npm run build`) and host it wherever WxCC Desktop
  can reach it over HTTPS — a CDN, same as Cisco's own CRM connectors.

## Configuration

`.env` (not committed — see `.gitignore`... currently it *is* tracked;
consider moving real values to `.env.local` if this repo is ever pushed
anywhere):

- `VITE_WXCC_OUTDIAL_ENTRY_POINT` — WxCC outdial entry point ID, used by
  the `MAKE_CALL` command handler.
- `VITE_ORACLE_FUSION_ORIGIN` — expected origin for Oracle CTI
  `postMessage` traffic. Leave blank only for local development; in
  production this must be set, or any page can send this widget CTI
  commands.
