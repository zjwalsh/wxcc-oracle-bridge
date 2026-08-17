import { useState, useEffect } from "react";
import { wxcc, type ActiveCall, type CallState } from "../services/WxCCService";

export interface CallStateHook {
  call: ActiveCall | null;
  callState: CallState;
  isInitialized: boolean;
  initError: string | null;
}

export function useCallState(): CallStateHook {
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    wxcc
      .init()
      .then(() => {
        if (!cancelled) setIsInitialized(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      });

    const unsub = wxcc.onStateChange((updatedCall, state) => {
      if (!cancelled) {
        setCall(updatedCall);
        setCallState(state);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { call, callState, isInitialized, initError };
}
