import type { McaAgentCommand, McaInteractionCommand, McaResult, McaUiEventsFrameworkProvider, McaPhoneContext } from "../types/oracle-mca";
import { MCA_APP_CLASSIFICATION, MCA_CHANNEL } from "../types/oracle-mca";
import { log, errInfo } from "./logger";

// Oracle's UI Events Framework loader — a fixed, generic entry point (not
// org-specific like the old oraApiSource). It self-resolves its own
// versioned "core" client at load time via a postMessage handshake with
// window.parent, confirmed by loading and reading this exact script.
const UI_EVENTS_FRAMEWORK_SRC = "https://static.oracle.com/cdn/ui-events-framework/libs/ui-events-framework-client.js";
const UI_EVENTS_FRAMEWORK_APP_NAME = "WxCCOracleBridge";

type InteractionCommandHandler = (cmd: McaInteractionCommand) => void | Promise<void>;
type AgentCommandHandler = (cmd: McaAgentCommand) => void | Promise<void>;
/** Raw, unwrapped payload — see handleOutgoingEvent for why this isn't a typed command object. */
type OutgoingCallHandler = (payload: unknown) => void | Promise<void>;

/**
 * Calls obj[method](...args) only if it's actually a function on obj — logs
 * and no-ops otherwise instead of throwing. Oracle's own docs for this
 * framework have already been proven wrong once (a documented
 * `getRecordContext` method didn't exist and threw a live TypeError) — every
 * call into a framework object goes through this so a wrong guess about a
 * method name degrades into a clear log line instead of crashing whatever
 * handler it's in.
 */
function callMethod(obj: unknown, method: string, ...args: unknown[]): unknown {
  const fn = (obj as Record<string, unknown> | null | undefined)?.[method];
  if (typeof fn !== "function") {
    log.warn(`Oracle UI Events Framework: ${method}() not found`, {
      available: obj ? Object.keys(obj as object) : obj,
    });
    return undefined;
  }
  return (fn as (...a: unknown[]) => unknown).apply(obj, args);
}

/**
 * Builds a publish request for `operationName` with the common fields set.
 * Confirmed setter names (fuief/startcommevent.html et al.): setEventId,
 * setAppClassification, setReason, getInData().setInDataValueByAttribute —
 * all still routed through callMethod so a wrong guess for a
 * less-confirmed operation just logs instead of throwing.
 */
function buildRequest(
  requestHelper: unknown,
  operationName: string,
  opts: { eventId?: string; appClassification?: string; reason?: string; inData?: Record<string, string> }
): unknown {
  const request = callMethod(requestHelper, "createPublishRequest", operationName);
  if (opts.eventId !== undefined) callMethod(request, "setEventId", opts.eventId);
  if (opts.appClassification !== undefined) {
    log.info(`${operationName}: calling setAppClassification`, { appClassification: opts.appClassification });
    callMethod(request, "setAppClassification", opts.appClassification);
  }
  if (opts.reason !== undefined) callMethod(request, "setReason", opts.reason);
  if (opts.inData) {
    const inDataBuilder = callMethod(request, "getInData");
    if (inDataBuilder) {
      for (const [key, value] of Object.entries(opts.inData)) {
        callMethod(inDataBuilder, "setInDataValueByAttribute", key, value);
      }
    }
  }
  return request;
}

/**
 * Reads the actual payload object out of a publish() response — fuief docs
 * say response.getResponseData().getData(), but confirmed live in this org's
 * deployment, publish() responses are plain objects with no such methods
 * (callMethod logs "not found" and falls through) — the real shape is
 * response.responseDetails.data.payload, with the documented outData nested
 * one level further inside that as payload.outData. Without drilling all the
 * way to payload.outData, the caller ends up merging Oracle's whole response
 * wrapper (result/method/origin/toolbarName/uuid/eventSource/actions/etc.)
 * into the next call's inData instead of just the documented correlation
 * fields.
 */
function getResponsePayload(response: unknown): Record<string, unknown> | undefined {
  const responseData = callMethod(response, "getResponseData");
  const viaMethod = callMethod(responseData, "getData");
  if (viaMethod !== undefined) return viaMethod as Record<string, unknown>;
  if (responseData !== undefined) return responseData as Record<string, unknown>;
  const record = response as { responseDetails?: { data?: { payload?: Record<string, unknown> } } } | undefined;
  return record?.responseDetails?.data?.payload;
}

function extractResponseData(response: unknown): unknown {
  const payload = getResponsePayload(response);
  const outData = payload?.outData;
  return outData ?? payload ?? response;
}

/**
 * Drives Oracle Fusion Service's UI Events Framework (fuief) — this
 * project's second, and now only, integration with Oracle's Media Toolbar.
 * Previously drove the older window.svcMca.tlb.api library instead; that
 * was abandoned because this org's Oracle setup doesn't apply
 * ResolutionCd/CommReasonCd sent through it to the actual WrapUp record
 * (confirmed live — echoed back with result:"success" but never lands on
 * the record), and that legacy library's calls are invisible to this
 * framework's own engagement tracking, which is what WrapUp Synchronization
 * needs. See oracle-mca.ts's file header and git history for that older
 * implementation.
 */
class OracleMcaService {
  private provider: McaUiEventsFrameworkProvider | null = null;
  private phoneContext: McaPhoneContext | null = null;
  private interactionHandler: InteractionCommandHandler | null = null;
  private agentHandler: AgentCommandHandler | null = null;
  private outgoingCallHandler: OutgoingCallHandler | null = null;
  // Oracle's own newCommEvent doc (fuief/newcommevent.html) says the
  // response's outData "must be passed as inData to startCommEvent or
  // closeCommEvent", and startCommEvent's doc is explicit that its inData
  // "should be matching with the outData response we get in the
  // newCommEvent operation response" — without this, Oracle can't
  // correlate the accept/decline step back to the original ring
  // notification. Keyed by eventId (== WxCC interactionId, per how
  // WxCCService calls all three).
  private pendingOutData = new Map<string, Record<string, string>>();

  async init(): Promise<void> {
    try {
      await this.loadScript(UI_EVENTS_FRAMEWORK_SRC);
    } catch (err) {
      log.error("Oracle UI Events Framework: failed to load client script", errInfo(err));
      return;
    }
    if (!window.CX_SVC_UI_EVENTS_FRAMEWORK?.uiEventsFramework) {
      log.error("Oracle UI Events Framework: script loaded but uiEventsFramework is undefined");
      return;
    }
    try {
      this.provider = await window.CX_SVC_UI_EVENTS_FRAMEWORK.uiEventsFramework.initialize(
        UI_EVENTS_FRAMEWORK_APP_NAME,
        "v1"
      );
    } catch (err) {
      log.error("Oracle UI Events Framework: initialize() failed", errInfo(err));
      return;
    }
    log.info("Oracle UI Events Framework: provider initialized", {
      applicationName: UI_EVENTS_FRAMEWORK_APP_NAME,
      // Oracle's docs already got one method (getRecordContext) wrong on
      // this build — dumping the real method list (own + inherited) here
      // so anything else that's missing/renamed is visible in the logs
      // instead of failing silently or throwing.
      ownKeys: Object.keys(this.provider as object),
      prototypeMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(this.provider)),
    });

    try {
      const multiChannelAdaptorContext = await this.provider.getMultiChannelAdaptorContext();
      this.phoneContext = await multiChannelAdaptorContext.getCommunicationChannelContext(MCA_CHANNEL);
    } catch (err) {
      log.error("Oracle UI Events Framework: failed to acquire PHONE context", errInfo(err));
      return;
    }
    if (!this.phoneContext) {
      log.error("Oracle UI Events Framework: PHONE context unavailable — cannot register call handlers");
      return;
    }
    log.info("Oracle UI Events Framework: PHONE context acquired", {
      supportedEvents: callMethod(this.phoneContext, "getSupportedEvents"),
      supportedActions: callMethod(this.phoneContext, "getSupportedActions"),
    });

    this.registerCommandHandlers();
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

  /**
   * Subscribes to one phoneContext event, isolated in its own try/catch —
   * confirmed live that a subscribe() call can throw synchronously (e.g.
   * onOutgoingEvent's "App Classification missing in payload" below), and
   * without this isolation that one throw aborted every subscription after
   * it in the same registerCommandHandlers() call, silently breaking
   * call-control commands that had nothing to do with the one that failed.
   */
  private subscribeSafely(eventName: string, configureRequest: (request: unknown) => void, callback: (response: unknown) => unknown): void {
    if (!this.phoneContext || !this.provider) return;
    try {
      const request = callMethod(this.provider.requestHelper, "createSubscriptionRequest", eventName);
      configureRequest(request);
      callMethod(this.phoneContext, "subscribe", request, callback);
    } catch (err) {
      log.error(`Oracle UI Events Framework: subscribing to ${eventName} failed`, errInfo(err));
    }
  }

  private registerCommandHandlers(): void {
    if (!this.phoneContext || !this.provider) return;

    this.subscribeSafely(
      "onToolbarInteractionCommand",
      () => {},
      (response) => this.handleInteractionCommandEvent(response)
    );

    this.subscribeSafely(
      "onToolbarAgentCommand",
      () => {},
      (response) => this.handleAgentCommandEvent(response)
    );

    // Confirmed live: unlike the two subscriptions above, this one throws
    // synchronously ("App Classification missing in payload") without an
    // explicit setAppClassification call — the old legacy library also took
    // appClassification as an explicit param for this specific event, so
    // this isn't entirely surprising in hindsight.
    this.subscribeSafely(
      "onOutgoingEvent",
      (request) => callMethod(request, "setAppClassification", MCA_APP_CLASSIFICATION),
      (response) => this.handleOutgoingEvent(response)
    );
  }

  /**
   * onToolbarInteractionCommand per fuief/ontoolbarinteractioncommand.html:
   * must return a Promise resolving with the response-data object after
   * setResult()/setResultDisplayString() are called on it — a different
   * contract from the old library's cmd.sendResponse(cmd), so this builds
   * the framework's response object directly rather than reusing the old
   * `respond()` helper.
   */
  private async handleInteractionCommandEvent(response: unknown): Promise<unknown> {
    const data = callMethod(response, "getResponseData") ?? response;
    const record = data as Record<string, unknown> | undefined;
    const command = (callMethod(data, "getCommand") ?? record?.command) as McaInteractionCommand["command"];
    const eventId = (callMethod(data, "getEventId") ?? record?.eventId) as string | undefined;
    const inData = (callMethod(data, "getInData") ?? record?.inData) as Record<string, string> | undefined;

    log.info(`← Oracle interaction command: ${command}`, { eventId, inData });

    const cmd: McaInteractionCommand = {
      eventId,
      command,
      inData,
      result: "success",
      sendResponse: () => {},
    };

    if (!this.interactionHandler) {
      log.warn(`← Oracle interaction command: ${command} has no registered handler`);
      return this.finalizeCommandResponse(data, "failure", "not supported");
    }
    try {
      await this.interactionHandler(cmd);
      return this.finalizeCommandResponse(data, "success", undefined, cmd.outData);
    } catch (err) {
      log.error(`Oracle interaction command ${command} handler failed`, errInfo(err));
      return this.finalizeCommandResponse(data, "failure", errInfo(err).message);
    }
  }

  /** onToolbarAgentCommand per fuief/ontoolbaragentcommand.html — same Promise/response-object contract as interaction commands. */
  private async handleAgentCommandEvent(response: unknown): Promise<unknown> {
    const data = callMethod(response, "getResponseData") ?? response;
    const record = data as Record<string, unknown> | undefined;
    const command = (callMethod(data, "getCommand") ?? record?.command) as McaAgentCommand["command"];

    log.info(`← Oracle agent command: ${command}`, { command });

    const cmd: McaAgentCommand = {
      command,
      result: "success",
      sendResponse: () => {},
    };

    if (!this.agentHandler) {
      log.warn(`← Oracle agent command: ${command} has no registered handler`);
      return this.finalizeCommandResponse(data, "failure", "not supported");
    }
    try {
      await this.agentHandler(cmd);
      return this.finalizeCommandResponse(data, "success", undefined, cmd.outData);
    } catch (err) {
      log.error(`Oracle agent command ${command} handler failed`, errInfo(err));
      return this.finalizeCommandResponse(data, "failure", errInfo(err).message);
    }
  }

  /** Confirmed setter names from fuief/ontoolbaragentcommand.html's own code sample: setResult, setOutdata (lowercase "d"). setResultDisplayString is UNCONFIRMED by naming convention. */
  private finalizeCommandResponse(data: unknown, result: McaResult, detail?: string, outData?: Record<string, unknown>): unknown {
    callMethod(data, "setResult", result);
    if (detail) callMethod(data, "setResultDisplayString", detail);
    if (outData) callMethod(data, "setOutdata", outData);
    return data;
  }

  /**
   * onOutgoingEvent — fires when the agent initiates an outbound call from
   * Oracle's own UI. UNVERIFIED: unlike the two handlers above, no
   * documented Promise/response-object contract was found for this one —
   * mirrors the old library's behavior (no result/sendResponse expected),
   * WxCCService acknowledges via newCommEvent/outboundCommError itself.
   */
  private async handleOutgoingEvent(response: unknown): Promise<void> {
    log.info("← Oracle onOutgoingEvent (outbound call request)", response);
    if (!this.outgoingCallHandler) {
      log.warn("← Oracle onOutgoingEvent has no registered handler — outbound call request dropped");
      return;
    }
    const payload = extractResponseData(response);
    try {
      await this.outgoingCallHandler(payload);
    } catch (err) {
      log.error("Oracle onOutgoingEvent handler failed", errInfo(err));
    }
  }

  // ─── WxCC → Oracle ────────────────────────────────────────────────────────

  /**
   * Passthrough log for every raw Webex/WxCC event, regardless of whether
   * it results in an actual Oracle API call. Without this, only events that
   * happen to trigger newCommEvent/startCommEvent/closeCommEvent/etc. show
   * up on the Oracle side of the log — anything else (wrapup, hold/unhold,
   * diagnostic-only events) is only visible in WxCCService's own logging,
   * making it look like Oracle never received it at all.
   */
  logWebexEvent(eventName: string, detail: unknown): void {
    log.info(`← Webex: ${eventName}`, detail);
  }

  /**
   * Returns the eventId that startCommEvent/closeCommEvent must use for this
   * call. Normally that's just the eventId passed in (echoed back), but
   * Oracle's response is the authoritative source per its documented
   * contract (see pendingOutData) — if it comes back with a different one,
   * that's what has to be used or Oracle can't correlate the later calls
   * back to this ring notification.
   */
  async newCommEvent(eventId: string, inData: Record<string, string>): Promise<string> {
    if (!this.phoneContext || !this.provider) {
      log.warn("newCommEvent: UI Events Framework not ready — skipping", { eventId });
      return eventId;
    }

    // callStatus is left out here rather than guessed — Oracle's docs only
    // ever show it as "INCOMING" (and optional even there), with no
    // documented value for outbound at all. No source for the real status,
    // so this passes inData through as-is instead of hardcoding one.
    log.info("→ Oracle: newCommEvent", { eventId, appClassification: MCA_APP_CLASSIFICATION, inData });

    const request = buildRequest(this.provider.requestHelper, "newCommEvent", {
      eventId,
      appClassification: MCA_APP_CLASSIFICATION,
      inData,
    });
    try {
      const response = await this.phoneContext.publish(request);
      log.info("newCommEvent response", response);
      const payload = getResponsePayload(response);
      const resolvedEventId = ((callMethod(response, "getEventId") ?? payload?.eventId) as string | undefined) ?? eventId;
      if (resolvedEventId !== eventId) {
        log.info("newCommEvent: response returned a different eventId — using it for startCommEvent/closeCommEvent", {
          sent: eventId,
          resolved: resolvedEventId,
        });
      }
      const data = extractResponseData(response) as Record<string, string> | undefined;
      if (data) {
        log.info("newCommEvent: storing response data to forward into startCommEvent/closeCommEvent", { eventId: resolvedEventId, data });
        this.pendingOutData.set(resolvedEventId, data);
      } else {
        log.warn(
          "newCommEvent: response has no data — startCommEvent/closeCommEvent will go out without it, " +
            "which Oracle's docs say they need to correlate back to this ring notification",
          { eventId: resolvedEventId, response }
        );
      }
      return resolvedEventId;
    } catch (err) {
      log.error("newCommEvent: publish failed", { eventId }, errInfo(err));
      return eventId;
    }
  }

  /**
   * Merges in the data captured from newCommEvent's response, per Oracle's
   * documented contract (see pendingOutData).
   *
   * Oracle's own response echoes back a "callStatus" of "INCOMING"
   * regardless of actual direction (see newCommEvent's comment above) — if
   * that were allowed to win over our own direction-derived value (see
   * toMcaInData's callStatus handling in WxCCService), an outbound call
   * would show as INCOMING again from here on. So outData's callStatus is
   * dropped; everything else from it still wins, per the documented
   * contract.
   */
  private withPendingOutData(eventId: string, inData: Record<string, string>): Record<string, string> {
    const outData = this.pendingOutData.get(eventId);
    this.pendingOutData.delete(eventId);
    if (!outData) return inData;
    const filteredOutData = { ...outData };
    for (const key of Object.keys(filteredOutData)) {
      if (key.toLowerCase() === "callstatus") delete filteredOutData[key];
    }
    return { ...inData, ...filteredOutData };
  }

  async startCommEvent(eventId: string, inData: Record<string, string>): Promise<void> {
    if (!this.phoneContext || !this.provider) {
      log.warn("startCommEvent: UI Events Framework not ready — skipping", { eventId });
      return;
    }
    const fullInData = this.withPendingOutData(eventId, inData);
    log.info("→ Oracle: startCommEvent", { eventId, appClassification: MCA_APP_CLASSIFICATION, inData: fullInData });
    const request = buildRequest(this.provider.requestHelper, "startCommEvent", {
      eventId,
      appClassification: MCA_APP_CLASSIFICATION,
      inData: fullInData,
    });
    try {
      const response = await this.phoneContext.publish(request);
      log.info("startCommEvent response", response);
    } catch (err) {
      log.error("startCommEvent: publish failed", { eventId }, errInfo(err));
    }
  }

  async closeCommEvent(eventId: string, inData: Record<string, string>, reason: string | null = null): Promise<void> {
    if (!this.phoneContext || !this.provider) {
      log.warn("closeCommEvent: UI Events Framework not ready — skipping", { eventId });
      return;
    }
    const fullInData = this.withPendingOutData(eventId, inData);
    log.info("→ Oracle: closeCommEvent", { eventId, appClassification: MCA_APP_CLASSIFICATION, inData: fullInData, reason });
    const request = buildRequest(this.provider.requestHelper, "closeCommEvent", {
      eventId,
      appClassification: MCA_APP_CLASSIFICATION,
      reason: reason ?? undefined,
      inData: fullInData,
    });
    try {
      const response = await this.phoneContext.publish(request);
      log.info("closeCommEvent response", response);
      // WrapUp Synchronization: this org's Oracle setup doesn't apply
      // ResolutionCd sent as plain inData (confirmed live), so mirror it
      // into the actual WrapUp record via the documented
      // engagementContext.getWrapupContext().publish(...) path — only
      // reachable now because closeCommEvent itself runs through this same
      // framework (the old window.svcMca.tlb.api's closeCommEvent produced
      // no engagementContext this framework could see at all).
      if (fullInData.ResolutionCd) {
        void this.syncWrapUpFields(response, { ResolutionCd: fullInData.ResolutionCd });
      }
    } catch (err) {
      log.error("closeCommEvent: publish failed", { eventId }, errInfo(err));
    }
  }

  /**
   * Publishes WrapUp field values (e.g. "ResolutionCd", "CallNotes" —
   * without the "WrapUp." prefix, which this method adds) through the path
   * documented at fuief/wrapup-synchronization.html:
   * closeCommEvent's response → getResponseData().getEngagementContext()
   * → getWrapupContext() → publish(cxEventBusSetFieldValueOperation).
   *
   * Best-effort and non-blocking by design: any missing step here (no
   * engagementContext, no wrapup context, a rejected publish) just logs and
   * returns rather than throwing — closeCommEvent's own inData above is
   * unaffected either way. Every step goes through callMethod, since this
   * exact doc page already got one method (getRecordContext, tried
   * elsewhere) wrong on this build.
   */
  private async syncWrapUpFields(closeCommResponse: unknown, fields: Record<string, string>): Promise<void> {
    if (!this.provider) return;
    try {
      const responseData = callMethod(closeCommResponse, "getResponseData");
      const engagementContext = callMethod(responseData, "getEngagementContext");
      if (!engagementContext) {
        log.warn("syncWrapUpFields: no engagementContext on closeCommEvent response — skipping", { fields });
        return;
      }
      const wrapUpRecordContext = await (callMethod(engagementContext, "getWrapupContext") as Promise<unknown> | undefined);
      if (!wrapUpRecordContext) {
        log.warn("syncWrapUpFields: getWrapupContext() returned nothing — skipping", { fields });
        return;
      }
      const request = callMethod(this.provider.requestHelper, "createPublishRequest", "cxEventBusSetFieldValueOperation");
      for (const [name, value] of Object.entries(fields)) {
        callMethod(callMethod(request, "field"), "setValue", `WrapUp.${name}`, value);
      }
      log.info("→ Oracle UI Events Framework: syncWrapUpFields (cxEventBusSetFieldValueOperation)", { fields });
      const result = await (callMethod(wrapUpRecordContext, "publish", request) as Promise<unknown> | undefined);
      log.info("syncWrapUpFields: published", { fields, result });
    } catch (err) {
      log.error("syncWrapUpFields: failed", { fields }, errInfo(err));
    }
  }

  /** Reports that placing an agent-initiated outbound call (from onOutgoingEvent) failed. Confirmed setters: fuief/outboundcommerror.html. */
  async outboundCommError(commUuid: string, errorMsg: string, errorCode: string = "OUTDIAL_FAILED"): Promise<void> {
    if (!this.phoneContext || !this.provider) {
      log.warn("outboundCommError: UI Events Framework not ready — skipping", { commUuid });
      return;
    }
    log.info("→ Oracle: outboundCommError", { commUuid, errorCode, errorMsg });
    const request = callMethod(this.provider.requestHelper, "createPublishRequest", "outboundCommError");
    callMethod(request, "setCommUuid", commUuid);
    callMethod(request, "setErrorCode", errorCode);
    callMethod(request, "setErrorMsg", errorMsg);
    try {
      const response = await this.phoneContext.publish(request);
      log.info("outboundCommError response", response);
    } catch (err) {
      log.error("outboundCommError: publish failed", { commUuid }, errInfo(err));
    }
  }

  /**
   * UNCONFIRMED: no documented sample found for this operation on the UI
   * Events Framework (only the old, positional-args
   * svcMcaTlb.api.invokeScreenPop turned up) — best-effort guess following
   * the setter pattern confirmed for other operations. Every call goes
   * through callMethod, so a wrong name here just logs instead of throwing.
   */
  async invokeScreenPop(eventId: string, pageCode: string, pageData: unknown): Promise<void> {
    if (!this.phoneContext || !this.provider) {
      log.warn("invokeScreenPop: UI Events Framework not ready — skipping", { eventId, pageCode });
      return;
    }
    log.info("→ Oracle: invokeScreenPop", { eventId, pageCode });
    const request = buildRequest(this.provider.requestHelper, "invokeScreenPop", {
      eventId,
      appClassification: MCA_APP_CLASSIFICATION,
    });
    callMethod(request, "setPageCode", pageCode);
    callMethod(request, "setPageData", pageData);
    try {
      const response = await this.phoneContext.publish(request);
      log.info("invokeScreenPop response", response);
    } catch (err) {
      log.error("invokeScreenPop: publish failed", { eventId }, errInfo(err));
    }
  }

  /**
   * UNCONFIRMED: no documented sample found for this operation on the UI
   * Events Framework (only the old, positional-args
   * svcMcaTlb.api.agentStateEvent turned up) — best-effort guess following
   * the setter pattern confirmed for other operations. Every call goes
   * through callMethod, so a wrong name here just logs instead of throwing.
   */
  async agentStateEvent(
    eventId: string,
    isAvailable: boolean,
    isLoggedIn: boolean,
    stateCd: string,
    stateDisplayString: string,
    reasonCd: string = "",
    reasonDisplayString: string = "",
    inData: Record<string, string> = {}
  ): Promise<void> {
    if (!this.phoneContext || !this.provider) {
      log.warn("agentStateEvent: UI Events Framework not ready — skipping", { eventId });
      return;
    }
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
    const request = buildRequest(this.provider.requestHelper, "agentStateEvent", {
      eventId,
      appClassification: MCA_APP_CLASSIFICATION,
      inData,
    });
    callMethod(request, "setIsAvailable", isAvailable);
    callMethod(request, "setIsLoggedIn", isLoggedIn);
    callMethod(request, "setStateCd", stateCd);
    callMethod(request, "setStateDisplayString", stateDisplayString);
    callMethod(request, "setReasonCd", reasonCd);
    callMethod(request, "setReasonDisplayString", reasonDisplayString);
    try {
      const response = await this.phoneContext.publish(request);
      log.info("agentStateEvent response", response);
    } catch (err) {
      log.error("agentStateEvent: publish failed", { eventId }, errInfo(err));
    }
  }
}

export const oracleMca = new OracleMcaService();
