import type { SessionGetResponse, SessionState, SessionUpdateEvent } from "@ai-ide/shared";
import { createEmptySessionState } from "@ai-ide/shared";

export type Bridge = Window["aiIde"];

export function getBridge(): Bridge | null {
  if (typeof window !== "undefined" && window.aiIde) return window.aiIde;
  return null;
}

export async function loadInitialSession(): Promise<SessionGetResponse> {
  const bridge = getBridge();
  if (!bridge) {
    const state = createEmptySessionState("offline");
    return {
      state,
      sessions: [],
      activeSessionId: state.sessionId,
    };
  }
  return bridge.session.get();
}

export function subscribeSession(
  cb: (event: SessionUpdateEvent) => void,
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => undefined;
  return bridge.session.subscribe(cb);
}

export type { SessionState };
