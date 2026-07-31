import { useEffect, useState } from "react";
import type { SessionState, SessionSummary, SessionUpdateEvent } from "@ai-ide/shared";
import { getBridge, loadInitialSession, subscribeSession } from "../bridge";

export type SessionView = {
  state: SessionState | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
};

export function useSessionState(): SessionView {
  const [state, setState] = useState<SessionState | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const bridgeReady = useBridgeReady();

  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    void loadInitialSession().then((initial) => {
      if (cancelled) return;
      setState(initial.state);
      setSessions(initial.sessions);
      setActiveSessionId(initial.activeSessionId);
    });
    const unsub = subscribeSession((event: SessionUpdateEvent) => {
      setState(event.state);
      setSessions(event.sessions);
      setActiveSessionId(event.activeSessionId);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [bridgeReady]);

  return { state, sessions, activeSessionId };
}

/** Preload may finish after first React paint — poll until window.aiIde exists. */
export function useBridgeReady(): boolean {
  const [ready, setReady] = useState(() => getBridge() !== null);

  useEffect(() => {
    if (ready) return;
    const id = window.setInterval(() => {
      if (getBridge()) {
        setReady(true);
        window.clearInterval(id);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [ready]);

  return ready;
}
