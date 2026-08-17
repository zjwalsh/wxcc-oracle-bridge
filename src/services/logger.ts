import { Desktop } from "@wxcc-desktop/sdk";

/**
 * Shared logger for this widget, backed by the WxCC Desktop SDK's logging
 * pool. Entries mirror to the browser console during dev and are also
 * captured into the agent's exportable Desktop logs in production
 * (Desktop.logger.browserDownloadLogsJson/Text), so issues can be diagnosed
 * from a log bundle without reproducing them live.
 */
export const log = Desktop.logger.createLogger("wxcc-oracle-widget");
