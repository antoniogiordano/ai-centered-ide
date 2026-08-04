import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportUiError } from "../lib/uiErrors";

type Props = { children: ReactNode };
type State = { crashed: boolean };

/**
 * Catches React render errors so the shell stays up and the ErrorDialog can show.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportUiError({
      title: "UI crashed",
      message: error.message || "A component threw while rendering.",
      detail: [error.stack, info.componentStack].filter(Boolean).join("\n\n"),
      source: "react",
    });
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <strong>Something went wrong in the UI.</strong>
          <p>Details are in the error dialog. Reload the window if the app stays broken.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => this.setState({ crashed: false })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
