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
    const readyMessage: OracleAdapterReadyEvent = {
      type: "oracle.cti.event",
      event: "ADAPTER_READY",
      payload: { version: ADAPTER_VERSION, capabilities: CAPABILITIES },
    };
    const target = window.parent !== window ? window.parent : window.opener;
    if (target) {
      target.postMessage(readyMessage, ORACLE_CTI_ORIGIN);
    }
  }

  destroy(): void {
    window.removeEventListener("message", this.boundListener);
    this.commandHandlers.clear();
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
    }
  }

  private handleMessage(ev: MessageEvent): void {
    // Origin validation — skip wildcard only when env var is set
    if (
      ORACLE_CTI_ORIGIN !== "*" &&
      ev.origin !== ORACLE_CTI_ORIGIN
    ) {
      return;
    }

    const data = ev.data as OracleCTICommand;
    if (!data || data.type !== "oracle.cti.command" || !data.command) return;

    const handlers = this.commandHandlers.get(data.command) ?? [];
    handlers.forEach((h) => h(data));
  }
}

export const oracleCTI = new OracleCTIService();
