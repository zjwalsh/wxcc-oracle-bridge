import { Desktop, type Service } from "@wxcc-desktop/sdk";
import { oracleCTI } from "./OracleCTIService";

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
      oracleCTI.sendEvent("CALL_HELD", { callId: data.interactionId });
      this.notify("held");
    });

    Desktop.agentContact.addEventListener("eAgentContactUnHeld", (detail: Service.Aqm.Contact.AgentContact) => {
      const data = detail as unknown as { interactionId: string };
      if (!this.activeCall) return;
      this.activeCall = { ...this.activeCall, state: "connected" };
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
      if (!payload?.phoneNumber) return;
      await Desktop.dialer.startOutdial({
        data: {
          entryPointId: import.meta.env.VITE_WXCC_OUTDIAL_ENTRY_POINT ?? "",
          outboundDn: payload.phoneNumber,
        } as unknown as Service.Aqm.Dialer.tasks,
      });
    });

    oracleCTI.onCommand("HANGUP", async () => {
      if (!this.activeCall) return;
      await Desktop.agentContact.end({ interactionId: this.activeCall.interactionId });
    });

    oracleCTI.onCommand("HOLD", async () => {
      if (!this.activeCall) return;
      const call = this.activeCall;
      await Desktop.agentContact.hold({
        interactionId: call.interactionId,
        isPostCallConsult: false,
        data: { mediaResourceId: call.interactionId },
      });
    });

    oracleCTI.onCommand("RETRIEVE", async () => {
      if (!this.activeCall) return;
      const call = this.activeCall;
      await Desktop.agentContact.unHold({
        interactionId: call.interactionId,
        isPostCallConsult: false,
        data: { mediaResourceId: call.interactionId },
      });
    });

    oracleCTI.onCommand("SET_READY", async () => {
      await Desktop.agentStateInfo.stateChange({
        state: "Available",
        auxCodeIdArray: "0",
      });
    });

    oracleCTI.onCommand("SET_NOT_READY", async () => {
      await Desktop.agentStateInfo.stateChange({
        state: "Idle",
        auxCodeIdArray: "0",
      });
    });

    oracleCTI.onCommand("COMPLETE_WRAP_UP", async () => {
      if (!this.activeCall) return;
      await Desktop.agentContact.wrapup({
        interactionId: this.activeCall.interactionId,
        data: { wrapUpReason: "", auxCodeId: "0", isAutoWrapup: false },
      });
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
