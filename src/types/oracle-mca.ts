// Oracle Fusion Service "UI Events Framework" (fuief) — the call-control
// integration this widget actually uses.
//
// This project previously drove Oracle's older, legacy toolbar library
// (window.svcMca.tlb.api, loaded via the `oraApiSource` query param) —
// abandoned because Oracle's org here doesn't apply ResolutionCd/CommReasonCd
// sent through it to the actual WrapUp record (confirmed live: echoed back
// with result:"success" but never lands on the record), and there's no way
// to reach the newer WrapUp Synchronization API from that legacy library —
// its own engagement tracking (getActiveEngagements) never even sees calls
// that were run through the old client. See git history for the old
// implementation if the legacy library is ever needed again.
//
// The UI Events Framework's own docs (fuief/*.html) have already proven
// wrong once in this codebase (a documented `getRecordContext` method does
// not exist on a live provider instance — confirmed by a TypeError, not a
// guess), so — beyond the constants above the command types, which are
// confirmed against Oracle's docs or this app's own live logs — most of
// what follows is transcribed from docs and verified/corrected against a
// live provider/phoneContext instance's actual method list (dumped via
// Object.keys / Object.getOwnPropertyNames(Object.getPrototypeOf(...)) at
// startup — see OracleMcaService.initUiEventsFramework). Where a specific
// method is still unconfirmed, request/response objects are typed as
// `unknown` and accessed through OracleMcaService's callMethod() helper,
// which checks typeof before calling and only logs+no-ops on a wrong guess
// instead of throwing — so an incorrect assumption here degrades instead of
// crashing.

/** This widget is voice-only. */
export const MCA_CHANNEL = "PHONE";
export const MCA_CHANNEL_TYPE = "ORA_SVC_PHONE";

/**
 * Confirmed literal from Oracle's own startCommEvent doc example. Fusion
 * Service deployments can have multiple classifications (Sales vs Service
 * vs B2B Service) — verify this matches your org's configuration if
 * events aren't showing up as expected.
 */
export const MCA_APP_CLASSIFICATION = "ORA_SALES";

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
  // Confirmed live: present on onOutgoingEvent's payload for an
  // agent-initiated outbound call (clicking a contact's phone number).
  // Not currently echoed back on newCommEvent's ack — suspected cause of
  // Oracle popping the contact screen then closing it and falling back to
  // the service screen, since nothing ties the ack back to that contact.
  CONTACT_ID: "SVCMCA_CONTACT_ID",
  // Oracle's own call id, sent on onOutgoingEvent; echoed back on both
  // newCommEvent and startCommEvent for agent-initiated outbound calls.
  CALL_ID: "SVCMCA_CALL_ID",
  INTERACTION_REF_OBJ_TYPE: "SVCMCA_INTERACTION_REF_OBJ_TYPE",
} as const;

/** This widget only ever offers inbound calls to newCommEvent. */
export const MCA_DIRECTION_INBOUND = "ORA_SVC_INBOUND";
/** Confirmed literal from Oracle's onOutgoingEvent doc (facti/outbound-calls.html). */
export const MCA_DIRECTION_OUTBOUND = "ORA_SVC_OUTBOUND";

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

/**
 * IPhoneContext, per fuief/iphonecontext.html — confirmed field-for-field
 * against that doc page's method list (subscribe/subscribeOnce/publish plus
 * the getSupportedEvents/getSupportedActions introspection pair, which
 * OracleMcaService logs at startup specifically to confirm what this org's
 * build actually supports rather than trusting the docs outright).
 *
 * subscribe/subscribeOnce callbacks may return a Promise (required for
 * onToolbarInteractionCommand/onToolbarAgentCommand, per their own doc
 * pages) — typed loosely since the two response-reading paths
 * (onToolbarInteractionCommand vs onToolbarAgentCommand vs onOutgoingEvent)
 * each read differently-shaped data out of the same `unknown`.
 */
export interface McaPhoneContext {
  subscribe(request: unknown, callback: (response: unknown) => unknown): unknown;
  subscribeOnce(request: unknown, callback: (response: unknown) => unknown): unknown;
  publish(request: unknown): Promise<unknown>;
  dispose(): void;
  getSupportedEvents(): string[];
  getSupportedActions(): string[];
}

/** IMultiChannelAdaptorContext, per fuief/multichanneladaptorcontext.html. */
export interface McaMultiChannelAdaptorContext {
  getCommunicationChannelContext(channelType: string): Promise<McaPhoneContext>;
}

/**
 * createPublishRequest/createSubscriptionRequest return type is
 * intentionally `unknown` rather than a named interface: the confirmed
 * setters (setEventId, setAppClassification, setReason,
 * getInData().setInDataValueByAttribute, field().setValue(), setCommUuid,
 * setErrorCode, setErrorMsg — see fuief/{startcommevent,wrapup-synchronization,
 * outboundcommerror}.html) differ per operation, and OracleMcaService's
 * callMethod() helper already guards every call against a method not
 * existing, so a precise per-operation type would duplicate that safety net
 * without adding real protection (Oracle's own docs already got
 * getRecordContext wrong once).
 */
export interface McaUiEventsRequestHelper {
  createPublishRequest(operationName: string): unknown;
  createSubscriptionRequest(eventName: string): unknown;
}

/**
 * IUiEventsFrameworkProvider — confirmed present on a live instance:
 * requestHelper, getMultiChannelAdaptorContext (dumped from
 * Object.getOwnPropertyNames(Object.getPrototypeOf(provider)) — see
 * OracleMcaService.initUiEventsFramework's log).
 */
export interface McaUiEventsFrameworkProvider {
  requestHelper: McaUiEventsRequestHelper;
  getMultiChannelAdaptorContext(): Promise<McaMultiChannelAdaptorContext>;
}

/**
 * The framework's loader script (fixed URL, not org-specific like the old
 * `oraApiSource`) — confirmed by loading and reading its actual source: it
 * self-resolves and loads its own versioned "core" client via a
 * postMessage handshake with window.parent (`FETCH_BUILD_INFO`), which only
 * resolves when embedded inside Oracle's own toolbar frame.
 */
export interface McaUiEventsFrameworkLoader {
  uiEventsFramework: {
    initialize(applicationName: string, version?: string): Promise<McaUiEventsFrameworkProvider>;
  };
}

declare global {
  interface Window {
    /** Confirmed global name — read directly from the loader script's own source. */
    CX_SVC_UI_EVENTS_FRAMEWORK?: McaUiEventsFrameworkLoader;
  }
}
