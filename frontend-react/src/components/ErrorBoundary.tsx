import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[OCC] React error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: 12,
            padding: 40,
            color: "var(--m-text2)",
            fontFamily: "var(--m-font)",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--c-error)" }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 12, fontFamily: "var(--m-font-mono, monospace)", maxWidth: 500, textAlign: "center" }}>
            {this.state.error?.message}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid var(--m-border)",
              background: "var(--m-surface)",
              color: "var(--m-text)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
