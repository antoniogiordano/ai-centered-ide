import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ClipboardEvent,
  type RefObject,
} from "react";
import type { SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { ImageAnnotateDialog } from "./ImageAnnotateDialog";

const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const FOCUS_HINT = isApple
  ? "Press ⌘I to talk to the agent"
  : "Press Ctrl+I to talk to the agent";

const ATTACH_HINT = isApple ? "Attach · ⌘U" : "Attach · Ctrl+U";
const TEXT_PREVIEW_MAX_BYTES = 12_000;
const TEXT_PREVIEW_MAX_LINES = 200;
const MAX_ATTACHMENTS = 10;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type LocalAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  path?: string;
  mime?: string;
  dataBase64?: string;
  textPreview?: string;
  previewDataUrl?: string;
};

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running"
  );
}

function filePath(file: File): string | undefined {
  const withPath = file as File & { path?: string };
  return typeof withPath.path === "string" && withPath.path
    ? withPath.path
    : undefined;
}

function isProbablyText(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "application/xml" ||
    mime === "application/x-yaml"
  ) {
    return true;
  }
  return /\.(md|txt|json|ts|tsx|js|jsx|mjs|cjs|css|html|yml|yaml|toml|rs|go|py|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|zsh|bash|sql|graphql|vue|svelte)$/i.test(
    name,
  );
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Small JPEG thumb for IPC/transcript — keep under previewDataUrl schema cap. */
async function makeThumbnailDataUrl(
  src: string,
  maxEdge = 96,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => reject(new Error("thumb load failed"));
    img.src = src;
  });
}

function fullImageDataUrl(att: LocalAttachment): string | null {
  if (att.kind !== "image") return null;
  if (att.dataBase64) {
    return `data:${att.mime || "image/png"};base64,${att.dataBase64}`;
  }
  return att.previewDataUrl ?? null;
}

async function buildAttachment(file: File): Promise<LocalAttachment | null> {
  const id = crypto.randomUUID();
  const path = filePath(file);
  const mime = file.type || undefined;
  const isImage =
    (mime?.startsWith("image/") ?? false) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);

  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) return null;
    const dataBase64 = await fileToBase64(file);
    const full = `data:${mime || "image/png"};base64,${dataBase64}`;
    let previewDataUrl: string | undefined;
    try {
      previewDataUrl = await makeThumbnailDataUrl(full);
    } catch {
      previewDataUrl = undefined;
    }
    return {
      id,
      kind: "image",
      name: file.name,
      ...(path ? { path } : {}),
      mime: mime || "image/png",
      dataBase64,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    };
  }

  let textPreview: string | undefined;
  if (isProbablyText(mime ?? "", file.name) && file.size <= TEXT_PREVIEW_MAX_BYTES) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    textPreview =
      lines.length > TEXT_PREVIEW_MAX_LINES
        ? `${lines.slice(0, TEXT_PREVIEW_MAX_LINES).join("\n")}\n…`
        : text;
  }

  let dataBase64: string | undefined;
  // Keep bytes for import_attachment when under size cap; else path-only.
  if (file.size <= MAX_IMAGE_BYTES) {
    dataBase64 = await fileToBase64(file);
  }

  return {
    id,
    kind: "file",
    name: file.name,
    ...(path ? { path } : {}),
    ...(mime ? { mime } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textPreview ? { textPreview } : {}),
  };
}

function dataUrlToBase64(dataUrl: string): { mime: string; dataBase64: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return { mime: "image/png", dataBase64: dataUrl };
  return { mime: match[1]!, dataBase64: match[2]! };
}

export function ComposerBar(props: {
  state: SessionState | null;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { state, inputRef } = props;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const attachInputId = useId();
  const busy = isBusy(state?.status);
  const canSend =
    !busy && (Boolean(value.trim()) || attachments.length > 0);

  const activePlaceholder =
    state?.mode === "plan"
      ? "Describe the goal — we’ll shape phases and checklists together…"
      : "Continue development — the agent follows the Plan tab…";

  const editing = attachments.find((a) => a.id === editingId) ?? null;

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const next: LocalAttachment[] = [];
    for (const file of list) {
      const att = await buildAttachment(file);
      if (att) next.push(att);
    }
    setAttachments((prev) => {
      const merged = [...prev];
      for (const att of next) {
        if (merged.length >= MAX_ATTACHMENTS) break;
        if (
          att.kind === "image" &&
          merged.filter((a) => a.kind === "image").length >= MAX_IMAGES
        ) {
          continue;
        }
        merged.push(att);
      }
      return merged;
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setEditingId((cur) => (cur === id ? null : cur));
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const bridge = getBridge();
    const content = value.trim();
    if (!bridge || busy) return;
    if (!content && attachments.length === 0) return;
    const PREVIEW_MAX = 200_000;
    const payload = await Promise.all(
      attachments.map(async (a) => {
        let preview = a.previewDataUrl;
        if (preview && preview.length > PREVIEW_MAX) {
          try {
            const full = fullImageDataUrl(a);
            preview = full ? await makeThumbnailDataUrl(full) : undefined;
          } catch {
            preview = undefined;
          }
          if (preview && preview.length > PREVIEW_MAX) preview = undefined;
        }
        return {
          id: a.id,
          kind: a.kind,
          name: a.name,
          ...(a.path ? { path: a.path } : {}),
          ...(a.mime ? { mime: a.mime } : {}),
          ...(a.dataBase64 ? { dataBase64: a.dataBase64 } : {}),
          ...(a.textPreview ? { textPreview: a.textPreview } : {}),
          ...(preview ? { previewDataUrl: preview } : {}),
        };
      }),
    );
    setValue("");
    setAttachments([]);
    setEditingId(null);
    await bridge.session.sendMessage(content, {
      ...(payload.length ? { attachments: payload } : {}),
    });
    inputRef.current?.focus();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "u") return;
      if (editingId) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA") return;
      e.preventDefault();
      fileInputRef.current?.click();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editingId]);

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    if (e.currentTarget === e.target) setDragOver(false);
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (busy) return;
    if (e.dataTransfer.files?.length) {
      await addFiles(e.dataTransfer.files);
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await addFiles(files);
    }
  }

  return (
    <>
      <form className="composer-bar" onSubmit={(e) => void submit(e)}>
        <div
          className={`composer-shell ${focused ? "composer-shell-focused" : ""} ${dragOver ? "composer-shell-drag" : ""}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
        >
          <div className="composer-main">
            {attachments.length > 0 ? (
              <div className="composer-attachments" aria-label="Attachments">
                {attachments.map((att) =>
                  att.kind === "image" && (att.previewDataUrl || att.dataBase64) ? (
                    <div key={att.id} className="composer-thumb-wrap">
                      <button
                        type="button"
                        className="composer-thumb"
                        onClick={() => setEditingId(att.id)}
                        title="Annotate image"
                        aria-label={`Annotate ${att.name}`}
                      >
                        <img
                          src={att.previewDataUrl ?? fullImageDataUrl(att) ?? ""}
                          alt={att.name}
                        />
                      </button>
                      <button
                        type="button"
                        className="composer-thumb-remove"
                        onClick={() => removeAttachment(att.id)}
                        aria-label={`Remove ${att.name} · Delete`}
                        title="Remove · Delete"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div key={att.id} className="composer-file-chip">
                      <span className="composer-file-chip-name" title={att.path ?? att.name}>
                        {att.name}
                      </span>
                      <button
                        type="button"
                        className="composer-file-chip-remove"
                        onClick={() => removeAttachment(att.id)}
                        aria-label={`Remove ${att.name} · Delete`}
                        title="Remove · Delete"
                      >
                        ×
                      </button>
                    </div>
                  ),
                )}
              </div>
            ) : null}
            <div className="composer-row">
              <input
                ref={inputRef}
                name="message"
                className="composer-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onPaste={(e) => void onPaste(e)}
                placeholder={focused || value || attachments.length ? activePlaceholder : FOCUS_HINT}
                aria-label="Message to the agent"
                readOnly={busy}
              />
              <input
                ref={fileInputRef}
                id={attachInputId}
                type="file"
                multiple
                className="composer-file-input"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="composer-attach"
                disabled={busy}
                title={ATTACH_HINT}
                aria-label={ATTACH_HINT}
                onClick={() => fileInputRef.current?.click()}
              >
                {ATTACH_HINT}
              </button>
              <button
                type="submit"
                className="composer-send"
                disabled={!canSend}
                title={busy ? "Agent is working…" : "Send · Enter"}
                aria-label="Send · Enter"
              >
                {busy ? (
                  <span className="composer-send-busy" aria-hidden>
                    …
                  </span>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </form>

      {editing && fullImageDataUrl(editing) ? (
        <ImageAnnotateDialog
          src={fullImageDataUrl(editing)!}
          name={editing.name}
          onCancel={() => setEditingId(null)}
          onDone={(dataUrl) => {
            void (async () => {
              const { mime, dataBase64 } = dataUrlToBase64(dataUrl);
              let previewDataUrl: string | undefined;
              try {
                previewDataUrl = await makeThumbnailDataUrl(dataUrl);
              } catch {
                previewDataUrl = undefined;
              }
              setAttachments((prev) =>
                prev.map((a) =>
                  a.id === editing.id
                    ? {
                        ...a,
                        mime,
                        dataBase64,
                        ...(previewDataUrl
                          ? { previewDataUrl }
                          : { previewDataUrl: undefined }),
                      }
                    : a,
                ),
              );
              setEditingId(null);
            })();
          }}
        />
      ) : null}
    </>
  );
}
