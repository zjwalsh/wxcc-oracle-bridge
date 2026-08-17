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

  /** Registered by WxCCService — commands Oracle sends about an active call (accept/hold/disconnect/transfer/...). */
  onInteractionCommand(handler: InteractionCommandHandler): void {
    this.interactionHandler = handler;
  }

  /** Registered by WxCCService — commands Oracle sends about agent state (makeAvailable/makeUnavailable/...). */
  onAgentCommand(handler: AgentCommandHandler): void {
    this.agentHandler = handler;
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
    log.info("→ Oracle: newCommEvent", { eventId, inData });
    this.api.newCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      inData,
      null,
      (res) => log.debug("newCommEvent response", res),
      MCA_CHANNEL_TYPE
    );
  }

  startCommEvent(eventId: string, inData: Record<string, string>): void {
    if (!this.api) return;
    log.info("→ Oracle: startCommEvent", { eventId, inData });
    this.api.startCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      inData,
      (res) => log.debug("startCommEvent response", res),
      MCA_CHANNEL_TYPE
    );
  }

  closeCommEvent(eventId: string, inData: Record<string, string>, reason: string | null = null): void {
    if (!this.api) return;
    log.info("→ Oracle: closeCommEvent", { eventId, inData, reason });
    this.api.closeCommEvent(
      MCA_CHANNEL,
      MCA_APP_CLASSIFICATION,
      eventId,
      inData,
      reason,
      (res) => log.debug("closeCommEvent response", res),
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
      (res) => log.debug("invokeScreenPop response", res),
      MCA_CHANNEL_TYPE
    );
  }
}

export const oracleMca = new OracleMcaService();
