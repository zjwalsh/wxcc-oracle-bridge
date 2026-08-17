import { Desktop } from "@wxcc-desktop/sdk";

/**
 * Shared logger for this widget, backed by the WxCC Desktop SDK's logging
 * pool. Entries mirror to the browser console during dev and are also
 * captured into the agent's exportable Desktop logs in production
 * (Desktop.logger.browserDownloadLogsJson/Text), so issues can be diagnosed
 * from a log bundle without reproducing them live.
 */
export const log = Desktop.logger.createLogger("wxcc-oracle-widget");

/**
 * Desktop.logger's log pool serializes arguments (JSON.stringify under
 * the hood) for the exportable log bundle. `Error` objects survive the
 * console mirror fine but serialize to `{}` there — `message`/`stack`
 * aren't enumerable own properties — so a caught error logged directly
 * (`log.error("failed", err)`) silently loses its actual content in the
 * exported logs. Pass errors through this first: `log.error("failed", errInfo(err))`.
 */
export function errInfo(err: unknown): { name?: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
