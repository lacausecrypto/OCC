import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";

function ThrowingComponent({ error }: { error: Error }) {
  throw error;
}

function GoodComponent() {
  return <div>Everything is fine</div>;
}

describe("ErrorBoundary", () => {
  // Suppress React error boundary console errors in tests
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <GoodComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Everything is fine")).toBeInTheDocument();
  });

  it("renders error message when child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent error={new Error("Test error message")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test error message")).toBeInTheDocument();
  });

  it("renders Try again button", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent error={new Error("oops")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  it("resets error state on Try again click", () => {
    // We need a component that can toggle between throwing and not
    let shouldThrow = true;
    function MaybeThrow() {
      if (shouldThrow) throw new Error("boom");
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    // Stop throwing before clicking retry
    shouldThrow = false;
    fireEvent.click(screen.getByText("Try again"));

    // Re-render to apply the state reset
    rerender(
      <ErrorBoundary>
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });

  it("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingComponent error={new Error("fail")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
  });
});
