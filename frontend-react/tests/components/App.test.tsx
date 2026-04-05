import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Mock all stores and components before importing App
vi.mock("../../src/stores/server", () => ({
  useServerStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = {
      checkHealth: vi.fn(),
      serverOnline: false,
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../../src/stores/monitor", () => ({
  useMonitorStore: Object.assign(
    vi.fn((selector?: (s: unknown) => unknown) => {
      const state = { sseStatus: "disconnected" };
      return selector ? selector(state) : state;
    }),
    { getState: () => ({ connect: vi.fn() }) },
  ),
}));

vi.mock("../../src/stores/design", () => ({
  useDesignStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = { applyBlend: vi.fn() };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../../src/components/layout", () => ({
  AppLayout: () => <div data-testid="app-layout">AppLayout</div>,
}));

import App from "../../src/App";

describe("App", () => {
  it("renders AppLayout", () => {
    const { getByTestId } = render(<App />);
    expect(getByTestId("app-layout")).toBeInTheDocument();
  });
});
