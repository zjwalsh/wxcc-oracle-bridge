# WxCC Oracle CTI Widget

A headless bridge between Cisco Webex Contact Center (WxCC) Agent Desktop
and Oracle Fusion Service's Media Toolbar ("MCA" — Multichannel
Architecture) CTI framework. It has no UI — it relays WxCC call events to
Oracle (`newCommEvent`, `startCommEvent`, `closeCommEvent`,
`invokeScreenPop`) and dispatches commands Oracle sends back
(accept/hold/disconnect/transfer, agent ready/not-ready) into WxCC SDK
calls.

## Architecture

- [src/services/WxCCService.ts](src/services/WxCCService.ts) — wraps
  `@wxcc-desktop/sdk`, maps WxCC contact events to Oracle MCA calls, and
  routes Oracle MCA commands to WxCC SDK calls.
- [src/services/OracleMcaService.ts](src/services/OracleMcaService.ts) —
  wraps Oracle's **real** Media Toolbar client library
  (`window.svcMca.tlb`). Oracle hands the toolbar iframe the URL of its
  own library via the `oraApiSource` query param when it embeds it; this
  loads that exact script and drives its documented API rather than
  inventing a message format.
- [src/types/oracle-mca.ts](src/types/oracle-mca.ts) — the MCA protocol's
  types/constants, with confidence level noted per field (see below).
- [src/services/logger.ts](src/services/logger.ts) — shared logger backed
  by `Desktop.logger`, so entries land in WxCC Desktop's own exportable
  agent logs, not just the browser console.
- [src/bridge.ts](src/bridge.ts) — the actual deployed entry point. No
  React, no DOM rendering — just `wxcc.init()`, which also initializes
  the Oracle MCA connection internally.
- [src/App.tsx](src/App.tsx) / [src/components/MediaToolbar.tsx](src/components/MediaToolbar.tsx) —
  an optional visible call-control panel (Accept/Hold/Hangup), currently
  unused by the deployed bridge but kept in case a visible panel widget is
  wanted later. Useful today as a local dev sandbox (`npm run dev`).

### Why the Oracle side isn't a custom protocol

Oracle's Media Toolbar iframe URL carries its own config as query params
(confirmed live, via a real embedded session):

```
?oraParentFrame=https://your-instance.fa.us2.oraclecloud.com
&oraTbName=TOOLBAR_437316
&oraApiSource=https://static.oracle.com/cdn/mca/packs/oj-mca/<version>/container/mcaInteractionV1.js
```

`oraApiSource` is the URL of Oracle's own client library — third-party
toolbars are expected to load it and call its documented methods
(`window.svcMca.tlb.*`), not invent their own `postMessage` format. An
earlier version of this bridge did exactly that (a hand-rolled
`{type: "oracle.cti.event", ...}` scheme) — messages were verified to
reach Oracle's window correctly, with a matching origin, and were still
silently ignored, because Oracle's real listener only recognizes its own
message envelope. See [Oracle's Interaction API docs](https://docs.oracle.com/en/cloud/saas/fusion-service/faiec/overview-of-interaction-apis.html).

### Confidence level of the field mapping

Confirmed against Oracle's official docs and the loaded library's own
source:
- Method names/signatures: `newCommEvent`, `startCommEvent`,
  `closeCommEvent`, `invokeScreenPop`, `agentStateEvent`,
  `readyForOperation`, `getConfiguration`, `onToolbarInteractionCommand`,
  `onToolbarAgentCommand`.
- `command` values on inbound interaction commands: `accept`, `reject`,
  `setActive`, `disconnect`, `hold`, `unhold`, `mute`, `unmute`, `record`,
  `stopRecord`, `transfer`.
- `command` values on inbound agent commands: `getCurrentAgentState`,
  `getActiveEngagements`, `makeAvailable`, `makeUnavailable`,
  `getActiveInteractionCommands`, `custom`.
- `SVCMCA_ANI` as the ANI inData key.

**Not confirmed** (best-effort, flagged with `NOTE`/`UNVERIFIED` comments
in the code — every inbound command and several WxCC event payloads are
logged raw at debug level specifically so a wrong guess here is visible
in the exported logs, not a silent failure):
- `SVCMCA_DNIS` / `SVCMCA_QUEUE` inData keys (inferred from `SVCMCA_ANI`'s
  naming convention).
- The `result`/`sendResponse()` contract for acknowledging commands
  (using `"success"`/`"failure"`).
- Hold/retrieve state reporting to Oracle — `interactionControlStateChanged`
  exists in the library's public method list but its parameter shape
  wasn't confirmed, so it isn't called yet (local WxCC state still
  updates; Oracle isn't told).
- Outbound dialing initiated *from* Oracle's UI — the library exposes
  `onOutgoingEvent` for this, but it isn't wired up yet.
- `eScreenPop`'s real field names (`screenPopName`/`screenPopUrl`, from a
  Cisco sample, not a confirmed live payload).

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
  data: { interaction: { interactionId: "abc123", callAssociatedDetails: { ani: "+15551234567", dn: "100", virtualTeamName: "Support" } } }
})
```

Note the Oracle side (`OracleMcaService`) can't be exercised locally this
way — it depends on `oraApiSource`/`oraParentFrame`/`oraTbName` being
present in `window.location.search`, which only happens when Oracle
itself embeds the widget. Local dev only proves the WxCC-facing half.

## Deploying

- **Testing against a real Desktop session**: `npm run build:widget`,
  keep `npm run dev` running and reachable over HTTPS (e.g. via
  `tailscale serve`), and point the layout's `script` at
  `https://<your-tunnel-host>/wxcc-oracle-bridge.js`.
- **Real deployment**: take `public/wxcc-oracle-bridge.js` (or the copy
  under `dist/` after `npm run build`) and host it wherever WxCC Desktop
  can reach it over HTTPS — a CDN, same as Cisco's own CRM connectors.

Desktop layout entry (headless widget, script-injected — see
[Oracle's Interaction API docs](https://docs.oracle.com/en/cloud/saas/fusion-service/faiec/overview-of-interaction-apis.html) for why iframe embedding doesn't work here):

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

## Configuration

`.env` (not gitignored — currently tracked with real values; consider
moving to `.env.local` if this repo is ever pushed anywhere):

- `VITE_WXCC_OUTDIAL_ENTRY_POINT` — WxCC outdial entry point ID.
- `VITE_ORACLE_FUSION_ORIGIN` — **no longer used.** Oracle's own MCA
  library derives and validates the parent frame origin itself from the
  `oraParentFrame` URL param; this bridge doesn't do its own origin
  checking anymore. Safe to remove whenever convenient.
