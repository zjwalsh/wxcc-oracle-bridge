// Oracle Fusion Media Toolbar CTI Adapter message protocol

// MessageEvent.origin is always scheme://host:port with no path — but
// it's easy to accidentally paste a full page URL into the env var, and
// a path-bearing value would then never match, silently dropping every
// real message from Oracle. Normalize through URL.origin so either form
// works.
function resolveOracleOrigin(raw: string | undefined): string {
  if (!raw) return "*";
  try {
    return new URL(raw).origin;
  } catch {
    return raw; // not a parseable URL — assume it's already a bare origin
  }
}

export const ORACLE_CTI_ORIGIN = resolveOracleOrigin(import.meta.env.VITE_ORACLE_FUSION_ORIGIN);

// ─── Commands received FROM Oracle Fusion ──────────────────────────────────

export type OracleCommandType =
  | "MAKE_CALL"
  | "HANGUP"
  | "HOLD"
  | "RETRIEVE"
  | "CONFERENCE"
  | "TRANSFER"
  | "SET_READY"
  | "SET_NOT_READY"
  | "SET_WRAP_UP"
  | "COMPLETE_WRAP_UP";

export interface OracleCTICommand {
  type: "oracle.cti.command";
  command: OracleCommandType;
  payload?: OracleMakeCallPayload | OracleCallRefPayload | OracleTransferPayload;
}

export interface OracleMakeCallPayload {
  phoneNumber: string;
  subject?: string;
  callData?: Record<string, string>;
}

export interface OracleCallRefPayload {
  callId: string;
}

export interface OracleTransferPayload {
  callId: string;
  destination: string;
}

// ─── Events sent TO Oracle Fusion ──────────────────────────────────────────

export type OracleEventType =
  | "CALL_INCOMING"
  | "CALL_CONNECTED"
  | "CALL_HELD"
  | "CALL_RETRIEVED"
  | "CALL_ENDED"
  | "CALL_WRAPUP"
  | "SCREEN_POP"
  | "AGENT_READY"
  | "AGENT_NOT_READY"
  | "ADAPTER_READY"
  | "ADAPTER_ERROR";

export interface OracleCTIEvent {
  type: "oracle.cti.event";
  event: OracleEventType;
  payload: OracleCTIEventPayload;
}

export interface OracleCTIEventPayload {
  callId?: string;
  ani?: string;       // Caller ID (Automatic Number Identification)
  dnis?: string;      // Dialed Number Identification Service
  queueName?: string;
  duration?: number;  // seconds
  callData?: Record<string, string>; // CAD variables for screen pop
  reason?: string;
}

// ─── Handshake ──────────────────────────────────────────────────────────────

export interface OracleAdapterReadyPayload {
  version: string;
  capabilities: OracleAdapterCapability[];
}

export interface OracleAdapterReadyEvent {
  type: "oracle.cti.event";
  event: "ADAPTER_READY";
  payload: OracleAdapterReadyPayload;
}

export type OracleAdapterCapability =
  | "INBOUND"
  | "OUTBOUND"
  | "HOLD_RETRIEVE"
  | "CONFERENCE"
  | "TRANSFER"
  | "SCREEN_POP"
  | "WRAP_UP";
