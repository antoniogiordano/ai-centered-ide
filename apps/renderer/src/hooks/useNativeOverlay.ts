import { useEffect, useState } from "react";

/**
 * The live preview is a native view composited *over* the renderer, so any
 * React overlay — dialog, palette, crop selection — would be painted
 * underneath it and stay invisible. Overlays declare themselves here, and the
 * preview pane hides the native view while at least one is up.
 */

let openCount = 0;
const listeners = new Set<(blocked: boolean) => void>();

function emit(): void {
  const blocked = openCount > 0;
  for (const listener of listeners) listener(blocked);
}

/** Call from any component that renders a full-screen overlay. */
export function useNativeOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    openCount += 1;
    emit();
    return () => {
      openCount = Math.max(0, openCount - 1);
      emit();
    };
  }, [active]);
}

export function useNativeOverlayBlocked(): boolean {
  const [blocked, setBlocked] = useState(() => openCount > 0);
  useEffect(() => {
    listeners.add(setBlocked);
    setBlocked(openCount > 0);
    return () => {
      listeners.delete(setBlocked);
    };
  }, []);
  return blocked;
}
