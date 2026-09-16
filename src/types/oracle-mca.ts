// Oracle Fusion Service "MCA" (Multichannel Architecture) toolbar protocol.
//
// This is Oracle's real, documented integration surface — not a custom
// protocol. When Oracle embeds a CTI toolbar iframe, it passes the URL of
// its own client library via a query param (`oraApiSource`); the toolbar
// is expected to load that exact script and call its methods, rather than
// inventing its own postMessage format. Confirmed against:
//   - Oracle's official docs: https://docs.oracle.com/en/cloud/saas/fusion-service/faiec/overview-of-interaction-apis.html
//     and https://docs.oracle.com/en/cloud/saas/fusion-service/fuief/{startcommevent,newcommevent}.html
//   - The library source itself, downloaded and read directly (not via a
//     lossy summarizer) at oj-mca/2607.10.260931029/.../mcaInteractionV1.js.
//     The shape below (methods under `.api`, `closeCommEvent`'s `reason`
//     param, `onToolbarAgentCommand`'s channel args, self-initializing at
//     script-load time) is transcribed straight from that source, not
//     inferred.
//
// Fields marked UNVERIFIED below are inferred (naming convention) rather
// than confirmed from an official source — kept as named constants so
// there's a single place to correct them, and every inbound command is
// logged raw (see OracleMcaService) so a wrong guess is visible in the// exported logs instead of failing silently.

/** This widget is voice-only. */
export const MCA_CHANNEL = "PHONE";
export const MCA_CHANNEL_TYPE = "ORA_SVC_PHONE";

/**
 * Confirmed literal from Oracle's own startCommEvent doc example. Fusion
 * Service deployments can have multiple classifications (Sales vs Service
 * vs B2B Service) — verify this matches your org's configuration if
 * events aren't showing up as expected.
 */
export const MCA_APP_CLASSIFICATION = "ORA_SERVICE";

/** InData attribute keys — see file header re: which are confirmed. */
export const MCA_ATTR = {
  ANI: "SVCMCA_ANI", // confirmed: docs' newCommEvent example
  DNIS: "SVCMCA_DNIS", // UNVERIFIED — inferred from ANI's naming convention
  QUEUE: "SVCMCA_QUEUE", // UNVERIFIED
  // IMcaStartCommInData "standard parameters" per Oracle guidance found
  // 2026-08-17 — interactionId/channel should be explicit inData keys,
  // not just the positional eventId/channel args to the API call itself.
  INTERACTION_ID: "SVCMCA_INTERACTION_ID",
  SR_NUM: "SVCMCA_SR_NUM", // confirmed: docs' startCommEvent example
  CONTACT_NUMBER: "SVCMCA_CONTACT_NUMBER", // confirmed: docs' response example
  PARENT_INTERACTION_ID: "SVCMCA_PARENT_INTERACTION_ID", // confirmed: docs, transfer scenarios
  COMMUNICATION_DIRECTION: "SVCMCA_COMMUNICATION_DIRECTION", // UNVERIFIED
} as const;

/** This widget only ever offers inbound calls to newCommEvent. */
export const MCA_DIRECTION_INBOUND = "ORA_SVC_INBOUND";

/**
 * Confirmed literal values of `command` on the object passed to an
 * onToolbarInteractionCommand callback, read from the library source.
 */
export type McaInteractionCommandName =
  | "accept"
  | "reject"
  | "setActive"
  | "disconnect"
  | "hold"
  | "unhold"
  | "mute"
  | "unmute"
  | "record"
  | "stopRecord"
  | "transfer";

/**
 * Confirmed literal values of `command` on the object passed to an
 * onToolbarAgentCommand callback, read from the library source.
 */
export type McaAgentCommandName =
  | "getCurrentAgentState"
  | "getActiveEngagements"
  | "makeAvailable"
  | "makeUnavailable"
  | "getActiveInteractionCommands"
  | "custom";

/**
 * "success" confirmed from Oracle's own onToolbarInteractionCommand doc
 * example (`command.result = 'success';`). "failure" is not documented
 * anywhere reachable — a reasonable guess, not confirmed text.
 */
export type McaResult = "success" | "failure";

interface McaCommandBase {
  eventId?: string;
  command: string;
  channel?: string;
  inData?: Record<string, string>;
  result: string;
  resultDisplayString?: string;
  /** Not string-only — e.g. getActiveInteractionCommands expects arrays (see McaAgentCommandName). */
  outData?: Record<string, unknown>;
  /** Must be called as `cmd.sendResponse(cmd)` — Oracle's handler reads its `command` param, not `this`. */
  sendResponse: (cmd: unknown) => void;
}

export interface McaInteractionCommand extends McaCommandBase {
  command: McaInteractionCommandName;
  slot?: string;
  commandId?: string;
}

export interface McaAgentCommand extends McaCommandBase {
  command: McaAgentCommandName;
  channelType?: string;
}

export type McaCallback<T = unknown> = (response: T) => void;

/**
 * window.svcMca.tlb's real shape. Two things that don't match a naive
 * read of the docs:
 *   - `initialize()` runs automatically at script-load time (the file's
 *     own last two lines: `var mcaTlb = new mcaToolbar(); mcaTlb.initialize();`).
 *     Calling it again re-registers the underlying window `message` /
 *     custom-event listeners a second time — every inbound command would
 *     fire twice. Don't call it.
 *   - The actual callable methods live under `.tlb.api.*`, not directly
 *     on `.tlb`.
 */
export interface McaToolbarApi {
  /** Auto-invoked by the library itself on load — do not call this again. */
  initialize(): void;
  api: McaToolbarApiMethods;
}

export interface McaToolbarApiMethods {
  readyForOperation(readiness: boolean, callback?: McaCallback): void;
  getConfiguration(configType: string | null, callback?: McaCallback): void;
  /** Matches startCommEvent's arg shape — no lookupObject param, unlike Oracle's docs example. */
  newCommEvent(
    channel: string,
    appClassification: string,
    eventId: string,
    inData: Record<string, string>,
    callback?: McaCallback,
    channelType?: string
  ): void;
  startCommEvent(
    channel: string,
    appClassification: string,
    eventId: string,
    inData: Record<string, string>,
    callback?: McaCallback,
    channelType?: string
  ): void;
  /** `reason` sits between `inData` and `callback` — easy to miss. */
  closeCommEvent(
    channel: string,
    appClassification: string,
    eventId: string,
    inData: Record<string, string>,
    reason: string | null,
    callback?: McaCallback,
    channelType?: string
  ): void;
  invokeScreenPop(
    channel: string,
    appClassification: string,
    eventId: string,
    pageCode: string,
    pageData: unknown,
    callback?: McaCallback,
    channelType?: string
  ): void;
  agentStateEvent(
    channel: string,
    eventId: string,
    isAvailable: boolean,
    isLoggedIn: boolean,
    stateCd: string,
    stateDisplayString: string,
    reasonCd: string,
    reasonDisplayString: string,
    inData: Record<string, string>,
    callback?: McaCallback,
    channelType?: string
  ): void;
  onToolbarInteractionCommand(executor: (cmd: McaInteractionCommand) => void): void;
  /** Unlike onToolbarInteractionCommand, this is registered per-channel. */
  onToolbarAgentCommand(channel: string, channelType: string, executor: (cmd: McaAgentCommand) => void): void;
  interactionControlStateChanged(
    eventId: string,
    actionName: string,
    newInteractionControlStates: unknown[] | undefined,
    timestamp: number | undefined,
    inData: Record<string, string> | undefined
  ): void;
}

declare global {
  interface Window {
    svcMca?: { tlb: McaToolbarApi };
  }
}
