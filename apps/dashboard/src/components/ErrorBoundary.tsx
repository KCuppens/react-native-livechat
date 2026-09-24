import { Component, type ErrorInfo, type ReactNode } from "react";

/** Last line of defense: a render error shows a recoverable screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode; variant?: "page" | "pane" }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("dashboard render error", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    if (this.props.variant === "pane") {
      // Inside a layout column: compact, no page heading, no full-height card.
      return (
        <div className="empty" role="alert" style={{ alignSelf: "center" }}>
          Couldn't display this conversation.{" "}
          <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="auth">
        <div className="auth-card" role="alert">
          <h1>Something went wrong</h1>
          <p>This screen hit an unexpected error.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
              Reload
            </button>
            {/* Retrying the same route can crash again: offer a way out of it. */}
            <a className="btn" href="/">
              Go to inbox
            </a>
          </div>
        </div>
      </div>
    );
  }
}
