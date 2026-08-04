/**
 * Configure Monaco workers for Vite before any editor.create() call.
 * Without this, TS/JS modes throw "MonacoEnvironment.getWorkerUrl" / toUrl errors.
 */
let configured = false;

export async function ensureMonacoEnvironment(): Promise<void> {
  if (configured) return;
  configured = true;

  const [
    { default: EditorWorker },
    { default: JsonWorker },
    { default: CssWorker },
    { default: HtmlWorker },
    { default: TsWorker },
  ] = await Promise.all([
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("monaco-editor/esm/vs/language/json/json.worker?worker"),
    import("monaco-editor/esm/vs/language/css/css.worker?worker"),
    import("monaco-editor/esm/vs/language/html/html.worker?worker"),
    import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
  ]);

  (
    globalThis as unknown as {
      MonacoEnvironment?: {
        getWorker: (_: string, label: string) => Worker;
      };
    }
  ).MonacoEnvironment = {
    getWorker(_: string, label: string) {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") {
        return new CssWorker();
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new HtmlWorker();
      }
      if (label === "typescript" || label === "javascript") {
        return new TsWorker();
      }
      return new EditorWorker();
    },
  };
}
