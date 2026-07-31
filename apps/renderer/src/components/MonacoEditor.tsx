import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  path?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
};

/**
 * Monaco loaded on demand (Phase 7.8). Default read-only; explicit edit mode via readOnly=false.
 */
export function MonacoEditor(props: Props) {
  const { value, path, readOnly = true, onChange } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let editor: { dispose: () => void } | null = null;

    async function boot() {
      try {
        const monaco = await import("monaco-editor");
        if (disposed || !hostRef.current) return;
        editor = monaco.editor.create(hostRef.current, {
          value,
          language: languageFromPath(path),
          readOnly,
          theme: "vs-dark",
          minimap: { enabled: false },
          fontSize: 13,
          automaticLayout: true,
        });
        if (!readOnly && onChange) {
          const model = (editor as unknown as { getModel: () => { onDidChangeContent: (cb: () => void) => void; getValue: () => string } | null }).getModel();
          model?.onDidChangeContent(() => {
            onChange(model.getValue());
          });
        }
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void boot();
    return () => {
      disposed = true;
      editor?.dispose();
    };
  }, [path, readOnly]);

  if (error) {
    return (
      <pre className="empty-state" style={{ whiteSpace: "pre-wrap" }}>
        Monaco failed to load: {error}
        {"\n\n"}
        {value}
      </pre>
    );
  }

  return (
    <div className="monaco-host">
      {!ready ? <div className="empty-state">Loading editor…</div> : null}
      <div ref={hostRef} style={{ height: "100%", minHeight: 280 }} />
    </div>
  );
}

function languageFromPath(path?: string): string {
  if (!path) return "plaintext";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".html")) return "html";
  return "plaintext";
}
