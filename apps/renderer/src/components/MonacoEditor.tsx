import { useEffect, useRef, useState } from "react";
import { ensureMonacoEnvironment } from "../lib/monacoEnv";
import { reportUiError } from "../lib/uiErrors";

type Props = {
  value: string;
  path?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
};

type MonacoApi = typeof import("monaco-editor");
type MonacoEditorInstance = import("monaco-editor").editor.IStandaloneCodeEditor;

/**
 * Monaco loaded on demand (Phase 7.8). Default read-only; explicit edit mode via readOnly=false.
 */
export function MonacoEditor(props: Props) {
  const { value, path, readOnly = true, onChange } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;

    async function boot() {
      try {
        await ensureMonacoEnvironment();
        const monaco = await import("monaco-editor");
        if (disposed || !hostRef.current) return;
        monacoRef.current = monaco;

        // File preview does not need language-service diagnostics (avoids worker storms).
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: true,
          noSuggestionDiagnostics: true,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: true,
          noSuggestionDiagnostics: true,
        });

        const editor = monaco.editor.create(hostRef.current, {
          value,
          language: languageFromPath(path),
          readOnly,
          theme: "vs-dark",
          minimap: { enabled: false },
          fontSize: 13,
          automaticLayout: true,
          wordWrap: "on",
          scrollBeyondLastLine: false,
        });
        editorRef.current = editor;

        if (!readOnly && onChange) {
          editor.onDidChangeModelContent(() => {
            onChange(editor.getValue());
          });
        }
        setReady(true);
        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        reportUiError({
          title: "Editor failed to load",
          message,
          ...(err instanceof Error && err.stack
            ? { detail: err.stack }
            : {}),
          source: "monaco",
        });
      }
    }

    void boot();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // Recreate when path/readOnly changes; value synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready) return;
    if (editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value, ready]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !ready) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelLanguage(model, languageFromPath(path));
  }, [path, ready]);

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
      <div ref={hostRef} style={{ height: "100%", minHeight: 160 }} />
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
