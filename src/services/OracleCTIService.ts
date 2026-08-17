import type {
  OracleCTICommand,
  OracleCTIEvent,
  OracleCTIEventPayload,
  OracleEventType,
  OracleCommandType,
  OracleAdapterCapability,
  OracleAdapterReadyEvent,
} from "../types/oracle-cti";
import { ORACLE_CTI_ORIGIN } from "../types/oracle-cti";
import { log } from "./logger";

type CommandHandler = (cmd: OracleCTICommand) => void;

const ADAPTER_VERSION = "1.0.0";

const CAPABILITIES: OracleAdapterCapability[] = [
  "INBOUND",
  "OUTBOUND",
  "HOLD_RETRIEVE",
  "CONFERENCE",
  "TRANSFER",
  "SCREEN_POP",
  "WRAP_UP",
];

/**
 * Bridges the widget with Oracle Fusion's Media Toolbar CTI framework via
 * cross-origin postMessage. Sends events up to Oracle and dispatches
 * incoming commands to registered handlers.
 */
class OracleCTIService {
  private commandHandlers = new Map<OracleCommandType, CommandHandler[]>();
  private boundListener: (ev: MessageEvent) => void;

  constructor() {
    this.boundListener = this.handleMessage.bind(this);
  }

  init(): void {
    window.addEventListener("message", this.boundListener);
    this.logFrameTopology();
    const readyMessage: OracleAdapterReadyEvent = {
      type: "oracle.cti.event",
      event: "ADAPTER_READY",
      payload: { version: ADAPTER_VERSION, capabilities: CAPABILITIES },
    };
    const target = window.parent !== window ? window.parent : window.opener;
    if (target) {
      target.postMessage(readyMessage, ORACLE_CTI_ORIGIN);
      log.info("Oracle CTI adapter ready — sent ADAPTER_READY", readyMessage.payload);
    } else {
      log.warn(
        "Oracle CTI adapter has no parent/opener window to message — widget is not embedded in a frame, events to Oracle will be dropped"
      );
    }
  }

  destroy(): void {
    window.removeEventListener("message", this.boundListener);
    this.commandHandlers.clear();
    log.info("Oracle CTI adapter destroyed");
  }

  onCommand(command: OracleCommandType, handler: CommandHandler): () => void {
    const handlers = this.commandHandlers.get(command) ?? [];
    handlers.push(handler);
    this.commandHandlers.set(command, handlers);
    return () => this.offCommand(command, handler);
  }

  private offCommand(command: OracleCommandType, handler: CommandHandler): void {
    const handlers = this.commandHandlers.get(command) ?? [];
    this.commandHandlers.set(
      command,
      handlers.filter((h) => h !== handler)
    );
  }

  sendEvent(event: OracleEventType, payload: OracleCTIEventPayload): void {
    const message: OracleCTIEvent = { type: "oracle.cti.event", event, payload };
    const target = window.parent !== window ? window.parent : window.opener;
    if (target) {
      target.postMessage(message, ORACLE_CTI_ORIGIN);
      log.info(`→ Oracle: ${event}`, payload);
    } else {
      log.warn(`→ Oracle: ${event} dropped — no parent/opener window`, payload);
    }
  }

  /**
   * postMessage has no delivery confirmation — a successful `→ Oracle:`
   * log line only proves the call was made, not that Oracle received it.
   * If window.parent turns out to be same-origin as us (readable), it's
   * almost certainly WxCC Desktop's own window, not Oracle Fusion — the
   * widget now runs inside Desktop's document, so there may be another
   * frame layer between here and Oracle that this code doesn't know
   * about. Cross-origin (unreadable) is consistent with window.parent
   * genuinely being Oracle Fusion, as intended.
   */
  private logFrameTopology(): void {
    if (window.parent === window) {
      log.info("No parent frame (window.parent === window) — top-level window");
      return;
    }
    try {
      const href = window.parent.location.href;
      log.warn(
        "window.parent is SAME-ORIGIN and readable — this is likely WxCC Desktop's own window, not Oracle Fusion. Events sent via window.parent may not be reaching Oracle at all.",
        href
      );
    } catch {
      log.info(
        "window.parent is cross-origin (not readable) — consistent with it genuinely being Oracle Fusion"
      );
    }
    // window.parent being cross-origin doesn't mean it's the TOP window —
    // postMessage only delivers to the exact window object it's called
    // on, not to anything further up the chain. If there's another frame
    // between window.parent and window.top, sending to window.parent
    // alone would miss a listener registered at the true top.
    log.info("window.parent === window.top?", window.parent === window.top);
  }

  private handleMessage(ev: MessageEvent): void {
    // The widget now runs inside WxCC Desktop's own document (see
    // src/bridge.ts), so this listener sees every postMessage in that
    // shared window — including WxCC Desktop's own internal traffic to
    // its other widgets/iframes. Silently ignoring anything not from
    // Oracle is expected, normal, high-frequency behavior, not worth
    // logging per-message.
    if (
      ORACLE_CTI_ORIGIN !== "*" &&
      ev.origin !== ORACLE_CTI_ORIGIN
    ) {
      return;
    }

    const data = ev.data as OracleCTICommand;
    if (!data || data.type !== "oracle.cti.command" || !data.command) return;

    log.info(`← Oracle: ${data.command}`, data.payload);
    const handlers = this.commandHandlers.get(data.command) ?? [];
    if (handlers.length === 0) {
      log.warn(`← Oracle: ${data.command} has no registered handler`);
    }
    handlers.forEach((h) => h(data));
  }
}

export const oracleCTI = new OracleCTIService();
