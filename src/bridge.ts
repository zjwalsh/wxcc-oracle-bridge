import { wxcc } from "./services/WxCCService";
import { log } from "./services/logger";

/**
 * Entry point for the headless WxCC↔Oracle CTI bridge. No UI — this is
 * loaded by WxCC Desktop as an `agentx-custom-desktop` widget, which
 * injects this script directly into the Desktop's own document (that's
 * what makes the SDK's `AGENTX_SERVICE` global available to it; it does
 * not exist inside a separately-loaded iframe). Build with
 * `npm run build:widget` and point the desktop layout's headless widget
 * `script` at the resulting single-file bundle.
 *
 * wxcc.init() also initializes the Oracle MCA toolbar connection
 * (OracleMcaService) internally — see WxCCService.init().
 */
wxcc.init().catch((err) => {
  log.error("WxCC Desktop SDK failed to initialize", err);
});
