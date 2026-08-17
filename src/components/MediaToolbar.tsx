import { wxcc } from "../services/WxCCService";
import { useCallState } from "../hooks/useCallState";
import type { ActiveCall, CallState } from "../services/WxCCService";
import "./MediaToolbar.css";

const STATE_LABELS: Record<CallState, string> = {
  idle: "Ready",
  incoming: "Incoming Call",
  connected: "Connected",
  held: "On Hold",
  wrapup: "Wrap Up",
  error: "Error",
};

const STATE_COLORS: Record<CallState, string> = {
  idle: "var(--color-idle)",
  incoming: "var(--color-incoming)",
  connected: "var(--color-connected)",
  held: "var(--color-held)",
  wrapup: "var(--color-wrapup)",
  error: "var(--color-error)",
};

function formatDuration(startedAt: Date): string {
  const secs = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function CallDetails({ call }: { call: ActiveCall }) {
  return (
    <div className="call-details">
      <span className="call-ani" title="Caller ID">{call.ani || "Unknown"}</span>
      {call.dnis && <span className="call-dnis" title="DNIS">{call.dnis}</span>}
      {call.queueName && (
        <span className="call-queue" title="Queue">{call.queueName}</span>
      )}
      <span className="call-duration">{formatDuration(call.startedAt)}</span>
    </div>
  );
}

function ActionButtons({
  call,
  callState,
}: {
  call: ActiveCall | null;
  callState: CallState;
}) {
  const handleAccept = () => call && wxcc.acceptCall(call.interactionId);
  const handleHangup = () => {
    if (!call) return;
    // eAgentContactEnded (wired in WxCCService) reports closeCommEvent to
    // Oracle itself — no need to call Oracle directly from here too.
    wxcc.endCall(call.interactionId);
  };
  const handleHold = () => call && wxcc.holdCall(call.interactionId);
  const handleRetrieve = () => call && wxcc.retrieveCall(call.interactionId);
  const handleWrapup = () => call && wxcc.completeWrapup(call.interactionId);

  if (callState === "incoming") {
    return (
      <div className="action-buttons">
        <button className="btn btn-accept" onClick={handleAccept} title="Accept">
          ✓ Accept
        </button>
        <button className="btn btn-decline" onClick={handleHangup} title="Decline">
          ✕ Decline
        </button>
      </div>
    );
  }

  if (callState === "connected") {
    return (
      <div className="action-buttons">
        <button className="btn btn-hold" onClick={handleHold} title="Hold">
          ⏸ Hold
        </button>
        <button className="btn btn-hangup" onClick={handleHangup} title="End Call">
          ✕ End
        </button>
      </div>
    );
  }

  if (callState === "held") {
    return (
      <div className="action-buttons">
        <button className="btn btn-retrieve" onClick={handleRetrieve} title="Retrieve">
          ▶ Retrieve
        </button>
        <button className="btn btn-hangup" onClick={handleHangup} title="End Call">
          ✕ End
        </button>
      </div>
    );
  }

  if (callState === "wrapup") {
    return (
      <div className="action-buttons">
        <button className="btn btn-wrapup" onClick={handleWrapup} title="Complete Wrap Up">
          ✓ Complete
        </button>
      </div>
    );
  }

  return null;
}

export function MediaToolbar() {
  const { call, callState, isInitialized, initError } = useCallState();

  if (initError) {
    return (
      <div className="toolbar toolbar--error">
        <span className="status-dot" style={{ background: STATE_COLORS.error }} />
        <span className="status-label">WxCC Error: {initError}</span>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="toolbar toolbar--loading">
        <span className="spinner" />
        <span className="status-label">Connecting to WxCC…</span>
      </div>
    );
  }

  return (
    <div className="toolbar" data-state={callState}>
      <div className="toolbar-status">
        <span
          className="status-dot"
          style={{ background: STATE_COLORS[callState] }}
        />
        <span className="status-label">{STATE_LABELS[callState]}</span>
      </div>

      {call && <CallDetails call={call} />}

      <ActionButtons call={call} callState={callState} />
    </div>
  );
}
