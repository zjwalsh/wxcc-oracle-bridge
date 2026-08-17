// Oracle Fusion Service "MCA" (Multichannel Architecture) toolbar protocol.
//
// This is Oracle's real, documented integration surface — not a custom
// protocol. When Oracle embeds a CTI toolbar iframe, it passes the URL of
// its own client library via a query param (`oraApiSource`); the toolbar
// is expected to load that exact script and call its methods, rather than
// inventing its own postMessage format. Confirmed against:
//   - Oracle's official docs: https://docs.oracle.com/en/cloud/saas/fusion-service/faiec/overview-of-interaction-apis.html
//     and https://docs.oracle.com/en/cloud/saas/fusion-service/fuief/{startcommevent,newcommevent}.html
//   - The actual library this environment loads (window.svcMca.tlb), version
//     path oj-mca/.../mcaInteractionV1.js
//
// Fields marked UNVERIFIED below are inferred (naming convention, or not
// shown in the specific doc pages/source reachable at review time) rather
// than confirmed from an official source — kept as named constants so
// there's a single place to correct them, and every inbound command is
// logged raw (see OracleMcaService) so a wrong guess is visible in the
// exported logs instead of failing silently.

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
  SR_NUM: "SVCMCA_SR_NUM", // confirmed: docs' startCommEvent example
  CONTACT_NUMBER: "SVCMCA_CONTACT_NUMBER", // confirmed: docs' response example
  PARENT_INTERACTION_ID: "SVCMCA_PARENT_INTERACTION_ID", // confirmed: docs, transfer scenarios
} as const;

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

/** result/response contract is UNVERIFIED — "success"/"failure" is a reasonable guess, not confirmed text from Oracle's docs. */
export type McaResult = "success" | "failure";

interface McaCommandBase {
  eventId?: string;
  command: string;
  channel?: string;
  inData?: Record<string, string>;
  result: string;
  resultDisplayString?: string;
  outData?: Record<string, string>;
  sendResponse: () => void;
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

/** Public API surface of window.svcMca.tlb, per the library's own source. */
export interface McaToolbarApi {
  initialize(): void;
  readyForOperation(readiness: boolean, callback?: McaCallback): void;
  getConfiguration(configType: string | null, callback?: McaCallback): void;
  newCommEvent(
    channel: string,
    appClassification: string,
    eventId: string,
    inData: Record<string, string>,
    lookupObject: unknown,
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
  closeCommEvent(
    channel: string,
    appClassification: string,
    eventId: string,
    inData: Record<string, string>,
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
  onToolbarAgentCommand(executor: (cmd: McaAgentCommand) => void): void;
}

declare global {
  interface Window {
    svcMca?: { tlb: McaToolbarApi };
  }
}
