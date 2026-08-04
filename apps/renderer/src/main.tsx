import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ErrorDialog } from "./components/ErrorDialog";
import { installUiErrorHandlers } from "./lib/uiErrors";
import "./styles/tokens.css";

installUiErrorHandlers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
      <ErrorDialog />
    </AppErrorBoundary>
  </StrictMode>,
);
