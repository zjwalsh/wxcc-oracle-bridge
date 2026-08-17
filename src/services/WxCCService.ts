import { Desktop, type Service } from "@wxcc-desktop/sdk";
import { oracleMca } from "./OracleMcaService";
import { log, errInfo } from "./logger";
import { MCA_ATTR } from "../types/oracle-mca";
import type { McaAgentCommand, McaInteractionCommand, McaInteractionCommandName } from "../types/oracle-mca";

/** Interaction commands actually wired to a WxCC action below — also reported to Oracle via getActiveInteractionCommands. */
const SUPPORTED_INTERACTION_COMMANDS: McaInteractionCommandName[] = ["accept", "reject", "disconnect", "hold", "unhold"];

export type CallState =
  | "idle"
  | "incoming"
  | "connected"
  | "held"
  | "wrapup"
  | "error";

export interface ActiveCall {
  interactionId: string;
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

/** Best-effort — see the NOTE at the eScreenPop listener for confidence level. */
function extractScreenPopInfo(detail: unknown): { name: string; url: string } {
  const d = detail as { data?: { screenPopName?: string; screenPopUrl?: string } };
  return { name: d?.data?.screenPopName ?? "", url: d?.data?.screenPopUrl ?? "" };
}

/** Builds the inData object sent to Oracle's newCommEvent/startCommEvent/closeCommEvent. */
function toMcaInData(info: ContactInfo): Record<string, string> {
  const inData: Record<string, string> = {
    [MCA_ATTR.ANI]: info.ani,
    [MCA_ATTR.DNIS]: info.dnis,
    [MCA_ATTR.QUEUE]: info.queueName,
  };
  // Pass CAD variables through as-is too — harmless if Oracle doesn't
  // recognize a given key, useful if it happens to match a configured token.
  return { ...info.callData, ...inData };
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
    Desktop.agentContact.addEventListener("eAgentOfferContact", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentOfferContact raw payload", detail);
      const info = extractContactInfo(detail);
      this.activeCall = {
        ...info,
        startedAt: new Date(),
        state: "incoming",
      };
      log.info("eAgentOfferContact", info);
      // newCommEvent is Oracle's mandatory first call for any communication.
      // eventId = WxCC interactionId, consistently, so inbound commands
      // (which echo eventId back) can be correlated to the right call.
      oracleMca.newCommEvent(info.interactionId, toMcaInData(info));
      this.notify("incoming");
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
      const { interactionId } = extractContactInfo(detail);
      if (!this.activeCall) {
        log.warn(`${source}: no active call tracked — ignoring`, { interactionId });
        return;
      }
      if (this.activeCall.state === "connected") {
        log.debug(`${source}: already connected — ignoring (likely the other of eAgentContact/eAgentContactAssigned also firing)`);
        return;
      }
      if (this.activeCall.interactionId !== interactionId) {
        // Was a silent `return` before with no logging at all — the exact
        // kind of gap that made startCommEvent never firing invisible.
        log.warn(`${source}: interactionId mismatch — ignoring`, {
          fromEvent: interactionId,
          tracked: this.activeCall.interactionId,
        });
        return;
      }
      this.activeCall = { ...this.activeCall, state: "connected" };
      log.info(source, { interactionId });
      oracleMca.startCommEvent(interactionId, toMcaInData(this.activeCall));
      this.notify("connected");
    };

    Desktop.agentContact.addEventListener("eAgentContact", (detail: Service.Aqm.Contact.AgentContact) => {
      connectContact("eAgentContact", detail);
    });

    Desktop.agentContact.addEventListener("eAgentContactAssigned", (detail: Service.Aqm.Contact.AgentContact) => {
      connectContact("eAgentContactAssigned", detail);
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

    Desktop.agentContact.addEventListener("eAgentContactEnded", (detail: Service.Aqm.Contact.AgentContact) => {
      log.debug("eAgentContactEnded raw payload", detail);
      const { interactionId } = extractContactInfo(detail);
      const duration = this.activeCall
        ? Math.round((Date.now() - this.activeCall.startedAt.getTime()) / 1000)
        : 0;
      log.info("eAgentContactEnded", { interactionId, duration });
      // closeCommEvent is Oracle's other mandatory call — disconnects the
      // engagement on Oracle's side.
      oracleMca.closeCommEvent(interactionId, { duration: String(duration) });
      this.activeCall = null;
      this.notify("idle");
    });

    Desktop.screenpop.addEventListener("eScreenPop", (detail: unknown) => {
      log.debug("eScreenPop raw payload", detail);
      if (!this.activeCall) return;
      // NOTE: field names (screenPopName/screenPopUrl) are best-effort,
      // taken from a Cisco sample rather than confirmed against a live
      // payload — check the raw log above if screen pops don't land.
      const { name, url } = extractScreenPopInfo(detail);
      log.info("eScreenPop", { interactionId: this.activeCall.interactionId, name, url });
      oracleMca.invokeScreenPop(this.activeCall.interactionId, name, { url });
    });
  }

  // ─── Oracle → WxCC ────────────────────────────────────────────────────────

  private registerOracleCommands(): void {
    oracleMca.onInteractionCommand(async (cmd: McaInteractionCommand) => {
      const interactionId = cmd.eventId ?? this.activeCall?.interactionId;
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
        case "getCurrentAgentState":
        case "getActiveEngagements":
        case "custom":
          throw new Error(`${cmd.command}: not implemented yet`);
        default:
          throw new Error(`Unrecognized agent command: ${cmd.command}`);
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
