import type {
  McaAgentCommand,
  McaInteractionCommand,
  McaResult,
  McaToolbarApiMethods,
} from "../types/oracle-mca";
import { MCA_APP_CLASSIFICATION, MCA_CHANNEL, MCA_CHANNEL_TYPE } from "../types/oracle-mca";
import { log, errInfo } from "./logger";

type InteractionCommandHandler = (cmd: McaInteractionCommand) => void | Promise<void>;
type AgentCommandHandler = (cmd: McaAgentCommand) => void | Promise<void>;
/** Raw, unwrapped payload — see onOutgoingEvent's doc comment in oracle-mca.ts for why this isn't a typed command object. */
type OutgoingCallHandler = (payload: unknown) => void | Promise<void>;

/**
 * Wraps Oracle Fusion's real Media Toolbar ("MCA") client library instead
 * of a hand-rolled postMessage protocol. Oracle hands the toolbar iframe
 * the URL of its own library via `oraApiSource` in the query string — this
 * loads that exact script and drives its documented API
 * (window.svcMca.tlb.api) rather than inventing a message format Oracle
 * was never going to recognize.
 */
class OracleMcaService {
  private api: McaToolbarApiMethods | null = null;
  private interactionHandler: InteractionCommandHandler | null = null;
  private agentHandler: AgentCommandHandler | null = null;
  private outgoingCallHandler: OutgoingCallHandler | null = null;
  // Oracle's own newCommEvent doc (fuief/newcommevent.html) says the
  // response's outData "must be passed as inData to startCommEvent or
  // closeCommEvent", and startCommEvent's doc is explicit that its inData
  // "should be matching with the outData response we get in the
  // newCommEvent operation response" — without this, Oracle can't
  // correlate the accept/decline step back to the original ring
  // notification, which fits the "sends but doesn't trigger the correct
  // steps" symptom. Keyed by eventId (== WxCC interactionId, per how
  // WxCCService calls all three).
  private pendingOutData = new Map<string, Record<string, string>>();

  async init(): Promise<void> {
    log.info("Oracle MCA: window.location", window.location.href);

    const params = new URLSearchParams(window.location.search);
    const apiSource = params.get("oraApiSource");
    const parentFrame = params.get("oraParentFrame");
    const toolbarName = params.get("oraTbName");
    log.info("Oracle MCA: config from URL", { apiSource, parentFrame, toolbarName });

    if (!apiSource) {
      log.error(
        "Oracle MCA: oraApiSource missing from window.location.search — cannot load Oracle's toolbar library. This widget may not be embedded by Oracle's Media Toolbar right now (e.g. running standalone)."
      );
      return;
    }

    try {
      await this.loadScript(apiSource);
    } catch (err) {
      log.error("Oracle MCA: failed to load toolbar library script", apiSource, errInfo(err));
      return;
    }

    if (!window.svcMca?.tlb?.api) {
      log.error(
        "Oracle MCA: script loaded but window.svcMca.tlb.api is undefined — the library's API surface may have changed"
      );
      return;
    }
    // NOTE: do NOT call window.svcMca.tlb.initialize() here — the library
    // calls it on itself at the bottom of its own file, at script-load
    // time. Calling it again re-registers its window "message" and
    // internal custom-event listeners a second time, which would fire
    // every inbound command (and our WxCC actions in response) twice.
    this.api = window.svcMca.tlb.api;
    log.info("Oracle MCA: window.svcMca.tlb.api acquired");

    this.registerCommandHandlers();

    this.api.readyForOperation(true, (res) => {
      log.info("Oracle MCA: readyForOperation acknowledged", res);
    });
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * Oracle's callback fires for a local/transport ack (readyForOperation,
   * agentStateEvent) but a call whose eventId/channel/appClassification
   * doesn't route to anything on Oracle's side can be silently dropped
   * server-side with no callback and no error at all — logs nothing to
   * find. This makes that failure mode visible instead of invisible.
   */
  private withTimeoutWarning<T>(method: string, eventId: string, callback: (res: T) => void, timeoutMs = 6000): (res: T) => void {
    const timer = setTimeout(() => {
      log.warn(
        `← Oracle: no response to ${method} after ${timeoutMs}ms (eventId=${eventId}) — Oracle likely dropped this ` +
          `server-side rather than erroring. Check MCA_APP_CLASSIFICATION ("${MCA_APP_CLASSIFICATION}") matches this ` +
          `org's actual Fusion Service classification, and that the channel/queue config routes it.`
      );
    }, timeoutMs);
    return (res: T) => {
      clearTimeout(timer);
      callback(res);
    };
  }

  /** Registered by WxCCService — commands Oracle sends about an active call (accept/hold/disconnect/transfer/...). */
  onInteractionCommand(handler: InteractionCommandHandler): void {
    this.interactionHandler = handler;
  }

  /** Registered by WxCCService — commands Oracle sends about agent state (makeAvailable/makeUnavailable/...). */
  onAgentCommand(handler: AgentCommandHandler): void {
    this.agentHandler = handler;
  }

  /** Registered by WxCCService — fires when the agent initiates an outbound call from Oracle's own UI. */
  onOutgoingCall(handler: OutgoingCallHandler): void {
    this.outgoingCallHandler = handler;
  }

  private registerCommandHandlers(): void {
    if (!this.api) return;

    this.api.onToolbarInteractionCommand(async (cmd) => {
      log.info(`← Oracle interaction command: ${cmd.command}`, cmd);
      if (!this.interactionHandler) {
        log.warn(`← Oracle interaction command: ${cmd.command} has no registered handler`);
        this.respond(cmd, "failure", "not supported");
        return;
      }
      try {
        await this.interactionHandler(cmd);
        this.respond(cmd, "success");
      } catch (err) {
        log.error(`Oracle interaction command ${cmd.command} handler failed`, errInfo(err));
        this.respond(cmd, "failure", errInfo(err).message);
      }
    });

    // Registered per-channel internally (see the library source) — we're
    // voice-only, so this only ever fires for PHONE.
    this.api.onToolbarAgentCommand(MCA_CHANNEL, MCA_CHANNEL_TYPE, async (cmd) => {
      log.info(`← Oracle agent command: ${cmd.command}`, cmd);
      if (!this.agentHandler) {
        log.warn(`← Oracle agent command: ${cmd.command} has no registered handler`);
        this.respond(cmd, "failure", "not supported");
        return;
      }
      try {
        await this.agentHandler(cmd);
        this.respond(cmd, "success");
      } catch (err) {
        log.error(`Oracle agent command ${cmd.command} handler failed`, errInfo(err));
        this.respond(cmd, "failure", errInfo(err).message);
      }
    });

    // Registered per-channel, same as onToolbarAgentCommand — voice-only,
    // so this only ever fires for PHONE. Unlike the two handlers above,
    // there's no sendResponse/result contract here (see onOutgoingEvent's
    // doc comment) — WxCCService acknowledges via newCommEvent/
    // outboundCommError itself instead of this method responding.
    this.api.onOutgoingEvent(MCA_CHANNEL, MCA_APP_CLASSIFICATION, async (payload) => {
      log.info("← Oracle onOutgoingEvent (outbound call request)", payload);
      if (!this.outgoingCallHandler) {
        log.warn("← Oracle onOutgoingEvent has no registered handler — outbound call request dropped");
        return;
      }
      try {
        await this.outgoingCallHandler(payload);
      } catch (err) {
        log.error("Oracle onOutgoingEvent handler failed", errInfo(err));
      }
    }, MCA_CHANNEL_TYPE);
  }

  private respond(cmd: McaInteractionCommand | McaAgentCommand, result: McaResult, detail?: string): void {
    cmd.result = result;
    if (detail) cmd.resultDisplayString = detail;
    // Oracle's response handlers (interactionCommandResponse/
    // agentCommandResponse in the library source) take the command as an
    // explicit parameter, not via `this` — calling cmd.sendResponse()
    // with no argument passes `undefined` and throws inside their code.
    // Confirmed against Oracle's own doc example: command.sendResponse(command).
    cmd.sendResponse(cmd);
  }

  // ─── WxCC → Oracle ────────────────────────────────────────────────────────

  newCommEvent(eventId: string, inData: Record<string, string>): void {
    if (!this.api) return;
    // callStatus is confirmed from Oracle's own newCommEvent doc example
    // (request.getInData().setCallStatus('INCOMING')) — a top-level
    // inData field, distinct from the SVCMCA_*-attribute keys set via
    // setInDataValueByAttribute. Not previously sent; "optional" per the
    // doc, but cheap to include and plausibly relevant to the toolbar not
    // rendering the expected accept/decline step.
    const fullInData = { callStatus: "INCOMING", ...inData };
    log.info("→ Oracle: newCommEvent", { eventId, inData: fullInData });
    // Matches startCommEvent's arg shape (no lookupObject) — the UI Events
    // Framework's phoneContext.publish() path (Oracle's documented sample
    // for this event) isn't usable here: window.CX_SVC_UI_EVENTS_FRAMEWORK
    // is confirmed absent — this bridge runs inside WxCC Desktop's own
    // document, not inside an Oracle-hosted page/iframe, so that global is
    // never injected. window.svcMca.tlb.api is the only transport available.
    this.api.newCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      fullInData,
      this.withTimeoutWarning("newCommEvent", eventId, (res) => {
        log.info("newCommEvent response", res);
        // UNVERIFIED field name on the legacy library's response (its
        // shape isn't documented — only the UI Events Framework's
        // response.getResponseData().getOutData() is). Logged raw above
        // specifically so a wrong guess here is visible in the exported
        // logs rather than a silent failure, per this file's existing
        // pattern.
        const outData = (res as { outData?: Record<string, string> } | undefined)?.outData;
        if (outData) {
          log.info("newCommEvent: storing outData to forward into startCommEvent/closeCommEvent", {
            eventId,
            outData,
          });
          this.pendingOutData.set(eventId, outData);
        } else {
          log.warn(
            "newCommEvent: response has no outData — startCommEvent/closeCommEvent will go out without it, " +
              "which Oracle's docs say they need to correlate back to this ring notification",
            { eventId, res }
          );
        }
      }),
      MCA_CHANNEL_TYPE
    );
  }

  /** Merges in outData captured from newCommEvent's response, per Oracle's documented contract (see pendingOutData). */
  private withPendingOutData(eventId: string, inData: Record<string, string>): Record<string, string> {
    const outData = this.pendingOutData.get(eventId);
    this.pendingOutData.delete(eventId);
    return outData ? { ...inData, ...outData } : inData;
  }

  startCommEvent(eventId: string, inData: Record<string, string>): void {
    if (!this.api) return;
    const fullInData = this.withPendingOutData(eventId, inData);
    log.info("→ Oracle: startCommEvent", { eventId, inData: fullInData });
    this.api.startCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      fullInData,
      this.withTimeoutWarning("startCommEvent", eventId, (res) => log.info("startCommEvent response", res)),
      MCA_CHANNEL_TYPE
    );
  }

  closeCommEvent(eventId: string, inData: Record<string, string>, reason: string | null = null): void {
    if (!this.api) return;
    const fullInData = this.withPendingOutData(eventId, inData);
    log.info("→ Oracle: closeCommEvent", { eventId, inData: fullInData, reason });
    this.api.closeCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      fullInData,
      reason,
      this.withTimeoutWarning("closeCommEvent", eventId, (res) => log.info("closeCommEvent response", res)),
      MCA_CHANNEL_TYPE
    );
  }

  /** Reports that placing an agent-initiated outbound call (from onOutgoingEvent) failed. */
  outboundCommError(commUuid: string, errorMsg: string, errorCode: string = "OUTDIAL_FAILED"): void {
    if (!this.api) return;
    log.info("→ Oracle: outboundCommError", { commUuid, errorCode, errorMsg });
    this.api.outboundCommError(
      MCA_CHANNEL,
      commUuid,
      errorCode,
      errorMsg,
      (res) => log.info("outboundCommError response", res),
      MCA_CHANNEL_TYPE
    );
  }

  invokeScreenPop(eventId: string, pageCode: string, pageData: unknown): void {
    if (!this.api) return;
    log.info("→ Oracle: invokeScreenPop", { eventId, pageCode });
    this.api.invokeScreenPop(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      pageCode,
      pageData,
      (res) => log.info("invokeScreenPop response", res),
      MCA_CHANNEL_TYPE
    );
  }

  agentStateEvent(
    eventId: string,
    isAvailable: boolean,
    isLoggedIn: boolean,
    stateCd: string,
    stateDisplayString: string,
    reasonCd: string = "",
    reasonDisplayString: string = "",
    inData: Record<string, string> = {}
  ): void {
    if (!this.api) return;
    log.info("→ Oracle: agentStateEvent", {
      eventId,
      isAvailable,
      isLoggedIn,
      stateCd,
      stateDisplayString,
      reasonCd,
      reasonDisplayString,
      inData,
    });
    this.api.agentStateEvent(
      MCA_CHANNEL,
      eventId,
      isAvailable,
      isLoggedIn,
      stateCd,
      stateDisplayString,
      reasonCd,
      reasonDisplayString,
      inData,
      (res) => log.info("agentStateEvent response", res),
      MCA_CHANNEL_TYPE
    );
  }
}

export const oracleMca = new OracleMcaService();
