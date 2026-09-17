import { Desktop, type Service } from "@wxcc-desktop/sdk";
import { oracleMca } from "./OracleMcaService";
import { log, errInfo } from "./logger";
import { MCA_ATTR, MCA_CHANNEL, MCA_DIRECTION_INBOUND, MCA_DIRECTION_OUTBOUND } from "../types/oracle-mca";
import type { McaAgentCommand, McaInteractionCommand, McaInteractionCommandName } from "../types/oracle-mca";

/** Interaction commands actually wired to a WxCC action below — also reported to Oracle via getActiveInteractionCommands. */
const SUPPORTED_INTERACTION_COMMANDS: McaInteractionCommandName[] = ["accept", "reject", "disconnect", "hold", "unhold"];

/** WxCC Admin > Outdial > Entry Points — the entry point this org uses for agent-initiated outbound calls placed via Oracle. */
const OUTDIAL_ENTRY_POINT_ID = "f5306fed-687e-45ed-9a86-a59289b28f50";

export type CallState =
  | "idle"
  | "incoming"
  | "connected"
  | "held"
  | "wrapup"
  | "error";

export interface ActiveCall {
  interactionId: string;
  /**
   * The id used when talking to Oracle (newCommEvent/startCommEvent/
   * closeCommEvent's eventId, and SVCMCA_INTERACTION_ID). Equal to
   * interactionId for inbound calls (known up front, from the WxCC event
   * that started the call). For an outbound call placed via Oracle's
   * onOutgoingEvent, this is Oracle's own call id instead — WxCC's real
   * interactionId isn't known until startOutdial resolves, but Oracle
   * already needs to be told about the call before that (see
   * registerOutboundCallHandler) and expects the same id back on every
   * subsequent call, per its onOutgoingEvent doc sample.
   */
  oracleEventId: string;
  ani: string;
  dnis: string;
  queueName: string;
  callData: Record<string, string>;
  startedAt: Date;
  state: CallState;
}

type StateChangeListener = (call: ActiveCall | null, state: CallState) => void;

/**
 * The SDK's shipped type declarations are broken — `@wxcc-desktop/sdk`'s
 * package.json points event payload types at an `upstream-types.d.ts`
 * that doesn't exist in the published package, silently masked by
 * `skipLibCheck`. So `Service.Aqm.Contact.AgentContact` does not reflect
 * the real runtime event shape; treat it as decorative, not load-bearing.
 *
 * This shape is instead confirmed against Cisco's own official sample
 * (WebexSamples/webex-contact-center-api-samples,
 * widget-samples/headless-crm-widget-sample/src/headless-crm-widget.js):
 * ANI/DNIS/queue live under `data.interaction.callAssociatedDetails`, not
 * flat on the event detail, and CAD variables live under
 * `data.interaction.callAssociatedData`, each entry wrapped as `{ value }`.
 */
interface WxCCContactEventDetail {
  interactionId?: string;
  data?: {
    interactionId?: string;
    interaction?: {
      interactionId?: string;
      callAssociatedDetails?: {
        ani?: string;
        dn?: string; // DNIS
        virtualTeamName?: string; // queue name
      };
      callAssociatedData?: Record<string, { value?: string } | string | undefined>;
    };
  };
}

interface ContactInfo {
  interactionId: string;
  ani: string;
  dnis: string;
  queueName: string;
  callData: Record<string, string>;
}

/**
 * Pulls interactionId/ani/dnis/queueName/callData out of a raw WxCC
 * contact event detail. Tries the confirmed nested shape first, falls
 * back to a flat shape in case some event type turns out to differ —
 * cheap insurance, not a claim that the flat shape is real anywhere.
 */
function extractContactInfo(detail: unknown): ContactInfo {
  const d = detail as WxCCContactEventDetail;
  const interaction = d?.data?.interaction;
  const details = interaction?.callAssociatedDetails;
  const flat = detail as { ani?: string; dnis?: string; queueName?: string; callData?: Record<string, string> };

  const callData: Record<string, string> = {};
  const cad = interaction?.callAssociatedData;
  if (cad) {
    for (const [key, entry] of Object.entries(cad)) {
      const value = typeof entry === "string" ? entry : entry?.value;
      if (value !== undefined) callData[key] = value;
    }
  }

  return {
    interactionId: interaction?.interactionId ?? d?.data?.interactionId ?? d?.interactionId ?? "",
    ani: details?.ani ?? flat?.ani ?? "",
    dnis: details?.dn ?? flat?.dnis ?? "",
    queueName: details?.virtualTeamName ?? flat?.queueName ?? "",
    callData: Object.keys(callData).length > 0 ? callData : (flat?.callData ?? {}),
  };
}

/** Oracle expects the ANI without the leading "+"; WxCC sends E.164 (+1XXXXXXXXXX). */
function stripLeadingPlus(ani: string): string {
  return ani.replace(/^\+/, "");
}

/**
 * Pulls call id/ANI/display name out of onOutgoingEvent's raw payload.
 * SVCMCA_ANI/SVCMCA_DISPLAY_NAME/SVCMCA_CALL_ID are confirmed field names,
 * but only from Oracle's UI Events Framework doc (facti/outbound-calls.html)
 * — this widget's legacy-library transport forwards the raw postMessage
 * payload as-is (see onOutgoingEvent's doc comment in oracle-mca.ts), so
 * where those fields actually live in it isn't confirmed. Checks the
 * plausible nesting spots and logs the raw payload above so a wrong guess
 * here is visible rather than silently dropping every outbound call.
 */
function extractOutboundCallInfo(payload: unknown): { callId: string; ani: string; displayName: string } {
  const p = payload as Record<string, unknown> | null | undefined;
  const candidates: Array<Record<string, unknown> | undefined> = [
    p ?? undefined,
    p?.data as Record<string, unknown> | undefined,
    p?.inData as Record<string, unknown> | undefined,
    (p?.data as Record<string, unknown> | undefined)?.inData as Record<string, unknown> | undefined,
    p?.outData as Record<string, unknown> | undefined,
    (p?.data as Record<string, unknown> | undefined)?.outData as Record<string, unknown> | undefined,
  ];
  const pick = (keys: string[]): string => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      for (const key of keys) {
        const value = candidate[key];
        if (typeof value === "string" && value) return value;
      }
    }
    return "";
  };
  return {
    callId: pick(["SVCMCA_CALL_ID", "callId", "eventId"]),
    ani: pick(["SVCMCA_ANI", "ani"]),
    displayName: pick(["SVCMCA_DISPLAY_NAME", "displayName"]),
  };
}

/** Best-effort — see the NOTE at the eScreenPop listener for confidence level. */
function extractScreenPopInfo(detail: unknown): { name: string; url: string } {
  const d = detail as { data?: { screenPopName?: string; screenPopUrl?: string } };
  return { name: d?.data?.screenPopName ?? "", url: d?.data?.screenPopUrl ?? "" };
}

function getAgentxService(): any {
  if (typeof window === "undefined") return null;
  return (
    (window as any).AGENTX_SERVICE ??
    (window.parent as any)?.AGENTX_SERVICE ??
    (window.top as any)?.AGENTX_SERVICE ??
    null
  );
}

/**
 * Builds the inData object sent to Oracle's newCommEvent/startCommEvent/closeCommEvent.
 *
 * `forNewCommEvent` marks the newCommEvent-specific differences:
 * - SVCMCA_INTERACTION_ID is omitted: Oracle's own response to that call
 *   comes back with an interaction id in its outData, which
 *   OracleMcaService merges into the following startCommEvent/closeCommEvent
 *   (see pendingOutData) — sending our own value up front would just be a
 *   guess ahead of the one Oracle hands back.
 * - SVCMCA_COMMUNICATION_DIRECTION is set: this widget only ever offers
 *   inbound calls to newCommEvent.
 */
function toMcaInData(info: ContactInfo, forNewCommEvent = false): Record<string, string> {
  const inData: Record<string, string> = {
    [MCA_ATTR.ANI]: stripLeadingPlus(info.ani),
    [MCA_ATTR.DNIS]: info.dnis,
    [MCA_ATTR.QUEUE]: info.queueName,
    channel: MCA_CHANNEL,
  };
  if (forNewCommEvent) {
    inData[MCA_ATTR.COMMUNICATION_DIRECTION] = MCA_DIRECTION_INBOUND;
  } else {
    // Per Oracle guidance: IMcaStartCommInData's "standard parameters"
    // (interactionId, channel) should be explicit inData keys, not just
    // the positional eventId/channel args the API call already takes —
    // possibly related to the MSI screen-pop focus failure.
    inData[MCA_ATTR.INTERACTION_ID] = info.interactionId;
  }
  // Pass CAD variables through as-is too — harmless if Oracle doesn't
  // recognize a given key, useful if it happens to match a configured token.
  // A CAD variable literally named "ani" (case-insensitive) is Oracle's own
  // FC-DESKTOP-VIEW pop-over token, carrying the same E.164 value — strip
  // it the same way as SVCMCA_ANI above.
  const callData = Object.fromEntries(
    Object.entries(info.callData).map(([key, value]) =>
      key.toLowerCase() === "ani" ? [key, stripLeadingPlus(value)] : [key, value]
    )
  );
  return { ...callData, ...inData };
}

/**
 * Initializes the WxCC Desktop SDK, maps contact events to Oracle MCA
 * toolbar calls, and routes Oracle MCA commands back to WxCC actions.
 */
class WxCCService {
  private stateListeners: StateChangeListener[] = [];
  private activeCall: ActiveCall | null = null;

  async init(): Promise<void> {
    log.info("Initializing WxCC Desktop SDK…");
    try {
      await Desktop.config.init({
        widgetName: "wxcc-oracle-widget",
        widgetProvider: "Cisco",
      });

      Desktop.config.registerCrmConnector({
        crmPlatform: "oracle",
        crmConnectorProvider: "cisco",
      });

      this.registerWxCCEvents();
      this.registerOracleCommands();
      this.registerOutboundCallHandler();
      log.info("WxCC Desktop SDK initialized — agent connected to widget");
    } catch (err) {
      log.error("WxCC Desktop SDK failed to initialize", errInfo(err));
      throw err;
    }

    // Deliberately separate from the try/catch above: a failure loading
    // Oracle's MCA library shouldn't be mislabeled as a WxCC SDK failure,
    // and shouldn't make wxcc.init() itself reject — WxCC-side
    // functionality should keep working even if the Oracle side can't
    // load right now.
    try {
      await oracleMca.init();
      if (Desktop.agentStateInfo?.latestData?.status) {
        this.sendAgentState("initialState");
      }
    } catch (err) {
      log.error("Oracle MCA failed to initialize (WxCC SDK is still up)", errInfo(err));
    }
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== listener);
    };
  }

  getActiveCall(): ActiveCall | null {
    return this.activeCall;
  }

  // ─── WxCC → Oracle ────────────────────────────────────────────────────────

  private registerWxCCEvents(): void {
    const handleOfferContact = (source: string, detail: unknown) => {
      log.debug(`${source} raw payload`, detail);
      const info = extractContactInfo(detail);
      if (!info.interactionId) {
        log.warn(`${source}: no interactionId in payload — cannot offer contact`, detail);
        return;
      }
      // Multiple offer-shaped events (eAgentOfferContact, eAgentOfferConsult,
      // eAgentOfferCampaignReserved, eAgentAddCampaignReserved) can all fire
      // for the same interaction. Sending newCommEvent twice for the same
      // eventId is the likely cause of Oracle's toolbar library silently
      // dropping one of the two responses (it correlates its pending
      // callback by eventId, so the second call's registration clobbers the
      // first's) — visible as "no response to newCommEvent" even though
      // Oracle did receive it. Only send it once per interactionId.
      if (this.activeCall?.interactionId === info.interactionId) {
        log.debug(`${source}: already offered this interactionId — skipping duplicate newCommEvent`, info);
        return;
      }
      this.activeCall = {
        ...info,
        oracleEventId: info.interactionId,
        startedAt: new Date(),
        state: "incoming",
      };
      log.info(source, info);
      // newCommEvent is Oracle's mandatory first call on call start / offer.
      // eventId = WxCC interactionId, consistently, so inbound commands
      // (which echo eventId back) can be correlated to the right call.
      oracleMca.newCommEvent(info.interactionId, toMcaInData(info, true));
      this.notify("incoming");
    };

    Desktop.agentContact.addEventListener("eAgentOfferContact", (detail: Service.Aqm.Contact.AgentContact) => {
      handleOfferContact("eAgentOfferContact", detail);
    });

    Desktop.agentContact.addEventListener("eAgentOfferConsult", (detail: unknown) => {
      handleOfferContact("eAgentOfferConsult", detail);
    });

    Desktop.agentContact.addEventListener("eAgentOfferCampaignReserved", (detail: unknown) => {
      handleOfferContact("eAgentOfferCampaignReserved", detail);
    });

    Desktop.agentContact.addEventListener("eAgentAddCampaignReserved", (detail: unknown) => {
      handleOfferContact("eAgentAddCampaignReserved", detail);
    });

    // Cisco's own official headless-widget sample (WebexSamples/webex-
    // contact-center-api-samples, headless-crm-widget-sample) listens on
    // eAgentContactAssigned for "agent connected to the call", not
    // eAgentContact — and we've only ever confirmed eAgentContact fires at
    // all indirectly. Listen on both and share the handler rather than
    // gambling on one and finding out wrong a whole test cycle later; it's
    // logged which one actually fired either way, and connectContact() is
    // idempotent (state check) so it's harmless if both end up firing for
    // the same call.
    const connectContact = (source: string, detail: unknown) => {
      log.debug(`${source} raw payload`, detail);
      const info = extractContactInfo(detail);
      const fromEvent = info.interactionId;
      if (!this.activeCall) {
        let interactionId = fromEvent;
        if (!interactionId) {
          log.warn(`${source}: no active call tracked and no interactionId in payload — ignoring`, detail);
          return;
        }
        // Call connected directly without a preceding offer event (e.g. a
        // WxCC-side outbound call not placed through Oracle, or a direct
        // connection). Not to be confused with Oracle-initiated outbound
        // (registerOutboundCallHandler below) — that path pre-populates
        // this.activeCall itself, so this branch is skipped for it.
        this.activeCall = {
          ...info,
          interactionId,
          oracleEventId: interactionId,
          startedAt: new Date(),
          state: "incoming",
        };
        log.info(`${source}: call started without preceding offer — sending newCommEvent`, this.activeCall);
        oracleMca.newCommEvent(interactionId, toMcaInData(this.activeCall, true));
      }
      if (this.activeCall.state === "connected") {
        log.debug(`${source}: already connected — ignoring (likely another connect-signal event also firing for the same call)`);
        return;
      }
      let interactionId = fromEvent;
      if (!interactionId) {
        // Some connect-signal events (e.g. eCallRecordingStarted, used as
        // a proxy for "connected" on WebRTC calls where the usual events
        // never fire — see below) haven't had their exact payload shape
        // confirmed. Fall back to the one call we're tracking rather than
        // reject outright.
        log.debug(`${source}: no interactionId in payload — falling back to tracked call`, {
          tracked: this.activeCall.interactionId,
        });
        interactionId = this.activeCall.interactionId;
      } else if (this.activeCall.interactionId !== interactionId) {
        log.warn(`${source}: interactionId mismatch — ignoring`, {
          fromEvent: interactionId,
          tracked: this.activeCall.interactionId,
        });
        return;
      }
      this.activeCall = { ...this.activeCall, state: "connected" };
      log.info(source, { interactionId });
      oracleMca.startCommEvent(this.activeCall.oracleEventId, toMcaInData(this.activeCall));
      this.notify("connected");
    };

    // eAgentContactAssigned does fire in this environment (despite an
    // earlier assumption otherwise) — but firing startCommEvent from it
    // races ahead of newCommEvent's own ack when the agent answers fast
    // (~1-2s), since Oracle's toolbar backend apparently won't ack
    // newCommEvent once startCommEvent for the same interaction has
    // already landed. eCallRecordingStarted fires a beat later and gives
    // newCommEvent's ack time to arrive first, so it's used as the sole
    // connect signal instead. Caveat: if recording is ever disabled for
    // some call/queue in this org, that call would never trigger
    // startCommEvent — worth revisiting if that turns out to matter.
    Desktop.agentContact.addEventListener("eCallRecordingStarted", (detail: unknown) => {
      connectContact("eCallRecordingStarted", detail);
    });

    Desktop.agentContact.addEventListener("eAgentContactHeld", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentContactHeld raw payload", detail);
      const { interactionId } = extractContactInfo(detail);
      if (!this.activeCall) {
        log.warn("eAgentContactHeld: no active call tracked — ignoring", { interactionId });
        return;
      }
      this.activeCall = { ...this.activeCall, state: "held" };
      log.info("eAgentContactHeld", { interactionId });
      // NOTE: no confirmed Oracle MCA call for hold/unhold state reporting
      // — interactionControlStateChanged exists in the library's public
      // method list but its parameter contract wasn't confirmed. Local
      // state still updates (UI reflects it); Oracle isn't told yet.
      log.warn("Hold state not reported to Oracle — interactionControlStateChanged contract unverified");
      this.notify("held");
    });

    Desktop.agentContact.addEventListener("eAgentContactUnHeld", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentContactUnHeld raw payload", detail);
      const { interactionId } = extractContactInfo(detail);
      if (!this.activeCall) {
        log.warn("eAgentContactUnHeld: no active call tracked — ignoring", { interactionId });
        return;
      }
      this.activeCall = { ...this.activeCall, state: "connected" };
      log.info("eAgentContactUnHeld", { interactionId });
      log.warn("Retrieve state not reported to Oracle — interactionControlStateChanged contract unverified");
      this.notify("connected");
    });

    Desktop.agentContact.addEventListener("eAgentWrapup", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentWrapup raw payload", detail);
      const { interactionId } = extractContactInfo(detail);
      if (!this.activeCall) {
        log.warn("eAgentWrapup: no active call tracked — ignoring", { interactionId });
        return;
      }
      this.activeCall = { ...this.activeCall, state: "wrapup" };
      const duration = Math.round(
        (Date.now() - this.activeCall.startedAt.getTime()) / 1000
      );
      log.info("eAgentWrapup", { interactionId, duration });
      this.notify("wrapup");
    });

    // Confirmed by testing: this environment uses agent wrap-up, and
    // eAgentContactEnded never fires — eAgentContactWrappedUp (fired once
    // the agent completes wrap-up) is the real end-of-call signal here,
    // matching Cisco's own official headless-widget sample, which reads
    // full ANI/DNIS/queue/CAD data from this exact event rather than
    // eAgentContactEnded. This is where closeCommEvent — Oracle's other
    // mandatory call — actually needs to fire for this org.
    Desktop.agentContact.addEventListener("eAgentContactWrappedUp", (detail: unknown) => {
      log.debug("eAgentContactWrappedUp raw payload", detail);
      const info = extractContactInfo(detail);
      if (!this.activeCall) {
        log.warn("eAgentContactWrappedUp: no active call tracked — ignoring", { interactionId: info.interactionId });
        return;
      }
      const interactionId = info.interactionId || this.activeCall.interactionId;
      const duration = Math.round((Date.now() - this.activeCall.startedAt.getTime()) / 1000);
      log.info("eAgentContactWrappedUp", { interactionId, duration });
      oracleMca.closeCommEvent(this.activeCall.oracleEventId, { ...toMcaInData(this.activeCall), duration: String(duration) });
      this.activeCall = null;
      this.notify("idle");
    });

    Desktop.agentContact.addEventListener("eAgentContactEnded", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentContactEnded raw payload", detail);
      const { interactionId } = extractContactInfo(detail);
      // Confirmed by testing: in this org, eAgentContactEnded fires the
      // moment the call itself disconnects — BEFORE wrap-up starts, not
      // after. It carries no ANI/DNIS/queue/CAD data, only enough to
      // compute duration. Previously this sent closeCommEvent here (with
      // just {duration}) and nulled activeCall, which pre-empted
      // eAgentContactWrappedUp's later, data-rich closeCommEvent — that
      // handler would then see activeCall already null and skip sending
      // entirely. closeCommEvent now only ever comes from
      // eAgentContactWrappedUp; this event is logged for visibility only.
      log.info("eAgentContactEnded — closeCommEvent deferred to eAgentContactWrappedUp", { interactionId });
    });

    Desktop.screenpop.addEventListener("eScreenPop", (detail: unknown) => {
      log.debug("eScreenPop raw payload", detail);
      if (!this.activeCall) return;
      // NOTE: field names (screenPopName/screenPopUrl) are best-effort,
      // taken from a Cisco sample rather than confirmed against a live
      // payload — check the raw log above if screen pops don't land.
      const { name, url } = extractScreenPopInfo(detail);
      log.info("eScreenPop", { interactionId: this.activeCall.interactionId, name, url });
      oracleMca.invokeScreenPop(this.activeCall.oracleEventId, name, { url });
    });

    // Diagnostic-only sniffer, kept for whatever comes up next
    // (consult/transfer scenarios etc.) — the SDK's own type declarations
    // are broken (confirmed earlier — points at a non-existent
    // upstream-types.d.ts), so there's no authoritative event list to
    // check behavior against; this logs raw payloads for plausible events
    // that aren't wired to any Oracle call yet. eAgentContactWrappedUp and
    // eCallRecordingStarted graduated out of this list into real handlers
    // above.
    const DIAGNOSTIC_EVENTS = [
      "eAgentOfferContactRona",
      "eAgentContactAniUpdated",
      "eContactOwnerChanged",
      "eAgentConsultCreated",
      "eAgentConsulting",
    ] as const;
    DIAGNOSTIC_EVENTS.forEach((eventName) => {
      Desktop.agentContact.addEventListener(eventName, (detail: unknown) => {
        log.info(`[diagnostic] ${eventName} fired`, detail);
      });
    });

    // Listen for agent channel state changes from WxCC and notify Oracle via agentStateEvent.
    Desktop.agentStateInfo.addEventListener("eAgentChannelStateChanged", (detail: unknown) => {
      log.debug("eAgentChannelStateChanged raw payload", detail);
      const d = detail as {
        data?: {
          agentId?: string;
          channelType?: string;
          state?: string;
          lastStateChangeReason?: string;
          auxCodeId?: string;
          idleCode?: { id?: string; name?: string };
        };
        agentId?: string;
        channelType?: string;
        state?: string;
        lastStateChangeReason?: string;
        auxCodeId?: string;
      };

      const rawState = d?.data?.state ?? d?.state;
      this.sendAgentState("eAgentChannelStateChanged", {
        status: rawState,
        idleCode: d?.data?.idleCode,
        agentId: d?.data?.agentId ?? d?.agentId,
        channelType: d?.data?.channelType ?? d?.channelType,
      });
    });

    // In standard WxCC voice setups, agent state changes trigger eAgentStateChangeSuccess
    // which updates latestData and emits "updated" on agentStateInfo.
    Desktop.agentStateInfo.addEventListener("updated", (changes: unknown) => {
      log.debug("agentStateInfo 'updated' raw payload", changes);
      const changeList = changes as Array<{ name?: string; value?: unknown }>;
      if (Array.isArray(changeList)) {
        const hasStateChange = changeList.some(
          (c) => c?.name === "status" || c?.name === "subStatus" || c?.name === "idleCode"
        );
        if (hasStateChange) {
          this.sendAgentState("agentStateInfo.updated");
        }
      }
    });

    Desktop.agentStateInfo.addEventListener("eAgentReloginSuccess", (detail: unknown) => {
      log.debug("eAgentReloginSuccess raw payload", detail);
      this.sendAgentState("eAgentReloginSuccess");
    });

    Desktop.agentStateInfo.addEventListener("eAgentChannelReloginSuccess", (detail: unknown) => {
      log.debug("eAgentChannelReloginSuccess raw payload", detail);
      this.sendAgentState("eAgentChannelReloginSuccess");
    });

    // Directly bind to AQM agent service if present (captures eAgentStateChangeSuccess, login, and channel changes)
    const agentx = getAgentxService();
    if (agentx?.aqm?.agent) {
      log.info("Attaching direct listeners to AGENTX_SERVICE.aqm.agent");
      const agentService = agentx.aqm.agent;

      if (typeof agentService.eAgentStateChangeSuccess?.listen === "function") {
        agentService.eAgentStateChangeSuccess.listen((payload: any) => {
          log.info("[direct AQM] eAgentStateChangeSuccess fired", payload);
          const data = payload?.data;
          this.sendAgentState("direct AQM eAgentStateChangeSuccess", {
            status: data?.status,
            subStatus: data?.subStatus,
            idleCode: data?.auxCodeId ? { id: data.auxCodeId, name: data.subStatus || data.status } : undefined,
            agentId: data?.agentSessionId,
          });
        });
      }

      if (typeof agentService.eAgentStationLoginSuccess?.listen === "function") {
        agentService.eAgentStationLoginSuccess.listen((payload: any) => {
          log.info("[direct AQM] eAgentStationLoginSuccess fired", payload);
          const data = payload?.data;
          this.sendAgentState("direct AQM eAgentStationLoginSuccess", {
            status: data?.status,
            subStatus: data?.subStatus,
            idleCode: data?.auxCodeId ? { id: data.auxCodeId, name: data.subStatus || data.status } : undefined,
            agentId: data?.agentSessionId,
          });
        });
      }

      if (typeof agentService.eAgentReloginSuccess?.listen === "function") {
        agentService.eAgentReloginSuccess.listen((payload: any) => {
          log.info("[direct AQM] eAgentReloginSuccess fired", payload);
          const data = payload?.data;
          this.sendAgentState("direct AQM eAgentReloginSuccess", {
            status: data?.status,
            subStatus: data?.subStatus,
            idleCode: data?.auxCodeId ? { id: data.auxCodeId, name: data.subStatus || data.status } : undefined,
            agentId: data?.agentSessionId,
          });
        });
      }

      if (typeof agentService.eAgentChannelStateChanged?.listen === "function") {
        agentService.eAgentChannelStateChanged.listen((payload: any) => {
          log.info("[direct AQM] eAgentChannelStateChanged fired", payload);
          const data = payload?.data;
          this.sendAgentState("direct AQM eAgentChannelStateChanged", {
            status: data?.state ?? data?.status,
            subStatus: data?.lastStateChangeReason,
            idleCode: data?.auxCodeId ? { id: data.auxCodeId, name: data.lastStateChangeReason || "" } : undefined,
            agentId: data?.agentId,
            channelType: data?.channelType,
          });
        });
      }
    }
  }

  private sendAgentState(
    source: string,
    stateInfo?: {
      status?: string;
      subStatus?: string;
      idleCode?: { id?: string; name?: string };
      agentId?: string;
      channelType?: string;
    }
  ): void {
    const latest = Desktop.agentStateInfo.latestData;
    const rawState = stateInfo?.status ?? latest?.status ?? "";
    const rawSubStatus = stateInfo?.subStatus ?? latest?.subStatus ?? "";
    
    // Check both status and subStatus (e.g. status: "LoggedIn", subStatus: "Available")
    const isAvailable =
      rawState.toUpperCase() === "AVAILABLE" ||
      rawSubStatus.toUpperCase() === "AVAILABLE";

    const isLoggedIn =
      rawState.toUpperCase() !== "LOGGEDOUT" &&
      rawState.toUpperCase() !== "LOGOUT" &&
      rawState !== "";

    const stateCd = isAvailable ? "Available" : (rawState || "Idle");
    const stateDisplayString = isAvailable ? "Available" : (rawSubStatus || rawState || "Idle");

    const idleCode = stateInfo?.idleCode ?? latest?.idleCode;
    const reasonCd = idleCode?.id ?? "";
    const reasonDisplayString = idleCode?.name ?? rawSubStatus ?? "";

    const eventId = stateInfo?.agentId ?? latest?.agentProfileID ?? `agent-state-${Date.now()}`;

    log.info(`→ Oracle: agentStateEvent (${source})`, {
      rawState,
      rawSubStatus,
      isAvailable,
      isLoggedIn,
      stateCd,
      reasonCd,
      reasonDisplayString,
    });

    oracleMca.agentStateEvent(
      eventId,
      isAvailable,
      isLoggedIn,
      stateCd,
      stateDisplayString,
      reasonCd,
      reasonDisplayString,
      {
        channel: MCA_CHANNEL,
        channelType: stateInfo?.channelType ?? "ORA_SVC_PHONE",
      }
    );
  }

  // ─── Oracle → WxCC ────────────────────────────────────────────────────────

  private registerOracleCommands(): void {
    oracleMca.onInteractionCommand(async (cmd: McaInteractionCommand) => {
      // Oracle echoes back whatever id we gave it (oracleEventId) — for an
      // outbound call placed via onOutgoingEvent, that's Oracle's own call
      // id, not WxCC's real interactionId, so translate back before calling
      // into the WxCC SDK. Equivalent to using cmd.eventId as-is for inbound
      // calls, where oracleEventId === interactionId already.
      const interactionId =
        this.activeCall && cmd.eventId === this.activeCall.oracleEventId
          ? this.activeCall.interactionId
          : cmd.eventId ?? this.activeCall?.interactionId;
      if (!interactionId) {
        throw new Error(`${cmd.command}: no interactionId (missing eventId and no active call)`);
      }

      switch (cmd.command) {
        case "accept":
          await Desktop.agentContact.accept({ interactionId });
          return;
        case "reject":
        case "disconnect":
          await Desktop.agentContact.end({ interactionId });
          return;
        case "hold":
          await Desktop.agentContact.hold({
            interactionId,
            isPostCallConsult: false,
            data: { mediaResourceId: interactionId },
          });
          return;
        case "unhold":
          await Desktop.agentContact.unHold({
            interactionId,
            isPostCallConsult: false,
            data: { mediaResourceId: interactionId },
          });
          return;
        case "setActive":
        case "mute":
        case "unmute":
        case "record":
        case "stopRecord":
        case "transfer":
          throw new Error(`${cmd.command}: not implemented yet`);
        default:
          throw new Error(`Unrecognized interaction command: ${cmd.command}`);
      }
    });

    oracleMca.onAgentCommand(async (cmd: McaAgentCommand) => {
      switch (cmd.command) {
        case "makeAvailable":
          await Desktop.agentStateInfo.stateChange({ state: "Available", auxCodeIdArray: "0" });
          return;
        case "makeUnavailable":
          await Desktop.agentStateInfo.stateChange({ state: "Idle", auxCodeIdArray: "0" });
          return;
        case "getActiveInteractionCommands":
          // Confirmed shape from Oracle's docs: outData.supportedCommands
          // (array) / outData.supportedFeatures (array of {name, isEnabled}).
          // Oracle likely uses this to decide which call-control buttons
          // to show/enable in its own UI, so answering accurately matters
          // more than most of the other not-implemented cases here.
          cmd.outData = {
            supportedCommands: SUPPORTED_INTERACTION_COMMANDS,
            supportedFeatures: [],
          };
          return;
        case "getCurrentAgentState": {
          const latest = Desktop.agentStateInfo.latestData;
          const rawState = latest?.status ?? "";
          const isAvailable = rawState.toUpperCase() === "AVAILABLE";
          const isLoggedIn = rawState.toUpperCase() !== "LOGGEDOUT" && rawState.toUpperCase() !== "LOGOUT" && rawState !== "";
          cmd.outData = {
            isAvailable,
            isLoggedIn,
            stateCd: rawState || (isAvailable ? "Available" : "Idle"),
            stateDisplayString: rawState || (isAvailable ? "Available" : "Idle"),
            reasonCd: latest?.idleCode?.id ?? "",
            reasonDisplayString: latest?.idleCode?.name ?? latest?.subStatus ?? "",
          };
          return;
        }
        case "getActiveEngagements":
        case "custom":
          throw new Error(`${cmd.command}: not implemented yet`);
        default:
          throw new Error(`Unrecognized agent command: ${cmd.command}`);
      }
    });
  }

  /**
   * Handles Oracle-initiated outbound calls (agent clicks a phone number in
   * Fusion, per facti/outbound-calls.html's onOutgoingEvent). Acknowledges
   * to Oracle immediately (its doc sample does this before the call is even
   * placed), then places the call via WxCC's own outdial API. The resulting
   * call's lifecycle (connect/hold/wrap-up/close) is driven by the same
   * eAgentContact* listeners registerWxCCEvents already wires for inbound
   * calls — this only handles getting the call started and correlated back
   * to Oracle's own call id (see ActiveCall.oracleEventId).
   */
  private registerOutboundCallHandler(): void {
    oracleMca.onOutgoingCall(async (payload) => {
      const { callId, ani, displayName } = extractOutboundCallInfo(payload);
      if (!callId || !ani) {
        log.warn("onOutgoingEvent: missing call id or ANI in payload — cannot place outbound call", payload);
        return;
      }
      if (this.activeCall) {
        log.warn("onOutgoingEvent: already have an active call — ignoring outbound request", {
          callId,
          tracked: this.activeCall.interactionId,
        });
        return;
      }

      // interactionId is a placeholder (Oracle's own call id) until
      // startOutdial resolves with WxCC's real one below — Oracle needs its
      // ack before the call can even be placed, so there's no WxCC id yet.
      this.activeCall = {
        interactionId: callId,
        oracleEventId: callId,
        ani,
        dnis: "",
        queueName: "",
        callData: {},
        startedAt: new Date(),
        state: "incoming",
      };
      log.info("onOutgoingEvent: acknowledging outbound call to Oracle", { callId, ani, displayName });
      oracleMca.newCommEvent(callId, {
        [MCA_ATTR.ANI]: stripLeadingPlus(ani),
        [MCA_ATTR.COMMUNICATION_DIRECTION]: MCA_DIRECTION_OUTBOUND,
        channel: MCA_CHANNEL,
      });

      try {
        const contact = await Desktop.dialer.startOutdial({
          data: {
            entryPointId: OUTDIAL_ENTRY_POINT_ID,
            destination: stripLeadingPlus(ani),
            direction: "OUTBOUND",
            attributes: {},
            mediaType: "telephony",
            outboundType: "OUTDIAL",
          },
        });
        // Still the call we started (not superseded/cleared by a race) —
        // only then is it safe to fill in the real interactionId.
        if (this.activeCall?.oracleEventId !== callId) return;
        const resolvedId = contact ? extractContactInfo(contact).interactionId : "";
        if (resolvedId) {
          this.activeCall = { ...this.activeCall, interactionId: resolvedId };
          log.info("onOutgoingEvent: outdial placed", { callId, interactionId: resolvedId });
        } else {
          log.warn(
            "onOutgoingEvent: startOutdial resolved without a usable interactionId — relying on the connect-signal handler's fallback-to-tracked-call matching",
            { callId, contact }
          );
        }
      } catch (err) {
        log.error("onOutgoingEvent: startOutdial failed", errInfo(err));
        if (this.activeCall?.oracleEventId === callId) {
          oracleMca.outboundCommError(callId, errInfo(err).message);
          this.activeCall = null;
          this.notify("error");
        }
      }
    });
  }

  async acceptCall(interactionId: string): Promise<void> {
    await Desktop.agentContact.accept({ interactionId });
  }

  async endCall(interactionId: string): Promise<void> {
    await Desktop.agentContact.end({ interactionId });
  }

  async holdCall(interactionId: string): Promise<void> {
    await Desktop.agentContact.hold({
      interactionId,
      isPostCallConsult: false,
      data: { mediaResourceId: interactionId },
    });
  }

  async retrieveCall(interactionId: string): Promise<void> {
    await Desktop.agentContact.unHold({
      interactionId,
      isPostCallConsult: false,
      data: { mediaResourceId: interactionId },
    });
  }

  async completeWrapup(interactionId: string): Promise<void> {
    await Desktop.agentContact.wrapup({
      interactionId,
      data: { wrapUpReason: "", auxCodeId: "0", isAutoWrapup: false },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private notify(state: CallState): void {
    this.stateListeners.forEach((l) => l(this.activeCall, state));
  }
}

export const wxcc = new WxCCService();
