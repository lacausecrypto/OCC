import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSSE } from "../../src/hooks/useSSE";
import { useMonitorStore } from "../../src/stores/monitor";

// Mock monitor store
vi.mock("../../src/stores/monitor", () => ({
  useMonitorStore: vi.fn(),
}));

// Mock canvasExec store for monitor
vi.mock("../../src/stores/canvasExec", () => ({
  useCanvasExecStore: {
    getState: () => ({
      handleEvent: vi.fn(),
      clearExecState: vi.fn(),
    }),
  },
}));

vi.mock("../../src/api/sse", () => ({
  sseManager: {
    onStatusChange: null,
    onEvent: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}));

describe("useSSE", () => {
  const mockConnect = vi.fn();
  const mockDisconnect = vi.fn();

  beforeEach(() => {
    vi.mocked(useMonitorStore).mockReturnValue({
      connect: mockConnect,
      disconnect: mockDisconnect,
      sseStatus: "disconnected",
    } as never);
    vi.clearAllMocks();
  });

  it("returns sseStatus, connectSSE, and disconnectSSE", () => {
    const result = useSSE();
    expect(result).toHaveProperty("sseStatus");
    expect(result).toHaveProperty("connectSSE");
    expect(result).toHaveProperty("disconnectSSE");
  });

  it("connectSSE calls connect with /events", () => {
    const result = useSSE();
    result.connectSSE();
    expect(mockConnect).toHaveBeenCalledWith("/events");
  });

  it("disconnectSSE calls disconnect", () => {
    const result = useSSE();
    result.disconnectSSE();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
