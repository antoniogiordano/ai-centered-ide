/**
 * One-way channel into the composer for material produced outside of it: the
 * preview crop, the full-view shot, the picked DOM element. The composer owns
 * attachment and draft state, and the alternative — lifting that state into App
 * and threading it through the chrome — would couple the whole shell to a
 * feature that only fires on a keystroke.
 */

export type ComposerInboxItem = {
  /** Also the attachment id, so the annotation dialog can target it. */
  id: string;
  /** Appended to the current draft rather than replacing it. */
  text?: string;
  image?: {
    name: string;
    mime: string;
    dataBase64: string;
    previewDataUrl?: string;
  };
  /** Open the annotation dialog on the image as soon as it lands. */
  annotate?: boolean;
};

const listeners = new Set<(item: ComposerInboxItem) => void>();

export function sendToComposer(item: ComposerInboxItem): void {
  for (const listener of listeners) listener(item);
}

export function onComposerInbox(
  listener: (item: ComposerInboxItem) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
