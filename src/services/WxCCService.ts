import { Desktop, type Service } from "@wxcc-desktop/sdk";
import { oracleCTI } from "./OracleCTIService";
import { log } from "./logger";

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
 * Initializes the WxCC Desktop SDK, maps contact events to Oracle CTI events,
 * and routes Oracle CTI commands back to WxCC actions.
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
      log.error("WxCC Desktop SDK failed to initialize", err);
      throw err;
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
      const data = detail as unknown as { interactionId: string; ani: string; dnis: string; queueName: string; callData?: Record<string, string> };
      this.activeCall = {
        interactionId: data.interactionId,
        ani: data.ani ?? "",
        dnis: data.dnis ?? "",
        queueName: data.queueName ?? "",
        callData: data.callData ?? {},
        startedAt: new Date(),
        state: "incoming",
      };
      log.info("eAgentOfferContact", {
        interactionId: data.interactionId,
        ani: data.ani,
        dnis: data.dnis,
        queueName: data.queueName,
      });
      oracleCTI.sendEvent("CALL_INCOMING", {
        callId: data.interactionId,
        ani: data.ani,
        dnis: data.dnis,
        queueName: data.queueName,
        callData: data.callData,
      });
      this.notify("incoming");
    });

    Desktop.agentContact.addEventListener("eAgentContact", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string; state?: string };
      if (!this.activeCall || this.activeCall.interactionId !== data.interactionId) return;
      this.activeCall = { ...this.activeCall, state: "connected" };
      log.info("eAgentContact", { interactionId: data.interactionId });
      oracleCTI.sendEvent("CALL_CONNECTED", {
        callId: data.interactionId,
        ani: this.activeCall.ani,
        dnis: this.activeCall.dnis,
        callData: this.activeCall.callData,
      });
      this.notify("connected");
    });

    Desktop.agentContact.addEventListener("eAgentContactHeld", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string };
      if (!this.activeCall) return;
      this.activeCall = { ...this.activeCall, state: "held" };
      log.info("eAgentContactHeld", { interactionId: data.interactionId });
      oracleCTI.sendEvent("CALL_HELD", { callId: data.interactionId });
      this.notify("held");
    });

    Desktop.agentContact.addEventListener("eAgentContactUnHeld", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string };
      if (!this.activeCall) return;
      this.activeCall = { ...this.activeCall, state: "connected" };
      log.info("eAgentContactUnHeld", { interactionId: data.interactionId });
      oracleCTI.sendEvent("CALL_RETRIEVED", { callId: data.interactionId });
      this.notify("connected");
    });

    Desktop.agentContact.addEventListener("eAgentWrapup", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string };
      if (!this.activeCall) return;
      this.activeCall = { ...this.activeCall, state: "wrapup" };
      const duration = Math.round(
        (Date.now() - this.activeCall.startedAt.getTime()) / 1000
      );
      log.info("eAgentWrapup", { interactionId: data.interactionId, duration });
      oracleCTI.sendEvent("CALL_WRAPUP", {
        callId: data.interactionId,
        duration,
        callData: this.activeCall.callData,
      });
      this.notify("wrapup");
    });

    Desktop.agentContact.addEventListener("eAgentContactEnded", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string };
      const duration = this.activeCall
        ? Math.round((Date.now() - this.activeCall.startedAt.getTime()) / 1000)
        : 0;
      log.info("eAgentContactEnded", { interactionId: data.interactionId, duration });
      oracleCTI.sendEvent("CALL_ENDED", {
        callId: data.interactionId,
        duration,
      });
      this.activeCall = null;
      this.notify("idle");
    });

    Desktop.screenpop.addEventListener("eScreenPop", (detail: unknown) => {
      const data = detail as { callData?: Record<string, string> };
      if (!this.activeCall) return;
      log.info("eScreenPop", { interactionId: this.activeCall.interactionId });
      oracleCTI.sendEvent("SCREEN_POP", {
        callId: this.activeCall.interactionId,
        ani: this.activeCall.ani,
        dnis: this.activeCall.dnis,
        callData: { ...this.activeCall.callData, ...(data.callData ?? {}) },
      });
    });
  }

  // ─── Oracle → WxCC ────────────────────────────────────────────────────────

  private registerOracleCommands(): void {
    oracleCTI.onCommand("MAKE_CALL", async (cmd) => {
      const payload = cmd.payload as { phoneNumber: string };
      if (!payload?.phoneNumber) {
        log.warn("MAKE_CALL command missing phoneNumber", cmd.payload);
        return;
      }
      try {
        await Desktop.dialer.startOutdial({
          data: {
            entryPointId: import.meta.env.VITE_WXCC_OUTDIAL_ENTRY_POINT ?? "",
            outboundDn: payload.phoneNumber,
          } as unknown as Service.Aqm.Dialer.tasks,
        });
        log.info("MAKE_CALL dispatched to WxCC", { phoneNumber: payload.phoneNumber });
      } catch (err) {
        log.error("MAKE_CALL failed", err);
      }
    });

    oracleCTI.onCommand("HANGUP", async () => {
      if (!this.activeCall) {
        log.warn("HANGUP received with no active call");
        return;
      }
      try {
        await Desktop.agentContact.end({ interactionId: this.activeCall.interactionId });
        log.info("HANGUP dispatched to WxCC", { interactionId: this.activeCall.interactionId });
      } catch (err) {
        log.error("HANGUP failed", err);
      }
    });

    oracleCTI.onCommand("HOLD", async () => {
      if (!this.activeCall) {
        log.warn("HOLD received with no active call");
        return;
      }
      const call = this.activeCall;
      try {
        await Desktop.agentContact.hold({
          interactionId: call.interactionId,
          isPostCallConsult: false,
          data: { mediaResourceId: call.interactionId },
        });
        log.info("HOLD dispatched to WxCC", { interactionId: call.interactionId });
      } catch (err) {
        log.error("HOLD failed", err);
      }
    });

    oracleCTI.onCommand("RETRIEVE", async () => {
      if (!this.activeCall) {
        log.warn("RETRIEVE received with no active call");
        return;
      }
      const call = this.activeCall;
      try {
        await Desktop.agentContact.unHold({
          interactionId: call.interactionId,
          isPostCallConsult: false,
          data: { mediaResourceId: call.interactionId },
        });
        log.info("RETRIEVE dispatched to WxCC", { interactionId: call.interactionId });
      } catch (err) {
        log.error("RETRIEVE failed", err);
      }
    });

    oracleCTI.onCommand("SET_READY", async () => {
      try {
        await Desktop.agentStateInfo.stateChange({
          state: "Available",
          auxCodeIdArray: "0",
        });
        log.info("SET_READY dispatched to WxCC");
      } catch (err) {
        log.error("SET_READY failed", err);
      }
    });

    oracleCTI.onCommand("SET_NOT_READY", async () => {
      try {
        await Desktop.agentStateInfo.stateChange({
          state: "Idle",
          auxCodeIdArray: "0",
        });
        log.info("SET_NOT_READY dispatched to WxCC");
      } catch (err) {
        log.error("SET_NOT_READY failed", err);
      }
    });

    oracleCTI.onCommand("COMPLETE_WRAP_UP", async () => {
      if (!this.activeCall) {
        log.warn("COMPLETE_WRAP_UP received with no active call");
        return;
      }
      try {
        await Desktop.agentContact.wrapup({
          interactionId: this.activeCall.interactionId,
          data: { wrapUpReason: "", auxCodeId: "0", isAutoWrapup: false },
        });
        log.info("COMPLETE_WRAP_UP dispatched to WxCC", { interactionId: this.activeCall.interactionId });
      } catch (err) {
        log.error("COMPLETE_WRAP_UP failed", err);
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
