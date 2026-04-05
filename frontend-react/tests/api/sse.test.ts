import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSEManager } from "../../src/api/sse";

describe("SSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  it("starts as disconnected", () => {
    expect(manager.status).toBe("disconnected");
  });

  it("connects to URL", async () => {
    manager.connect("/events");
    // Wait for setTimeout in mock EventSource
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.status).toBe("connected");
  });

  it("calls onStatusChange on connect", async () => {
    const statusFn = vi.fn();
    manager.onStatusChange = statusFn;
    manager.connect("/events");
    await new Promise((r) => setTimeout(r, 10));
    expect(statusFn).toHaveBeenCalledWith("connected");
  });

  it("disconnects cleanly", async () => {
    const statusFn = vi.fn();
    manager.onStatusChange = statusFn;
    manager.connect("/events");
    await new Promise((r) => setTimeout(r, 10));
    manager.disconnect();
    expect(manager.status).toBe("disconnected");
    expect(statusFn).toHaveBeenCalledWith("disconnected");
  });

  it("disconnect when not connected is safe", () => {
    expect(() => manager.disconnect()).not.toThrow();
    expect(manager.status).toBe("disconnected");
  });

  it("parses JSON messages and calls onEvent", async () => {
    const eventFn = vi.fn();
    manager.onEvent = eventFn;
    manager.connect("/test");
    await new Promise((r) => setTimeout(r, 10));

    // Simulate message
    const es = (manager as unknown as { eventSource: { onmessage: (msg: { data: string }) => void } }).eventSource;
    es.onmessage({
      data: JSON.stringify({ type: "execution_started", executionId: "abc", chainName: "test" }),
    });
    expect(eventFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "execution_started", executionId: "abc" }),
    );
  });

  it("ignores empty/whitespace messages (heartbeats)", async () => {
    const eventFn = vi.fn();
    manager.onEvent = eventFn;
    manager.connect("/test");
    await new Promise((r) => setTimeout(r, 10));

    const es = (manager as unknown as { eventSource: { onmessage: (msg: { data: string }) => void } }).eventSource;
    es.onmessage({ data: "" });
    es.onmessage({ data: "   " });
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("ignores unparseable messages", async () => {
    const eventFn = vi.fn();
    manager.onEvent = eventFn;
    manager.connect("/test");
    await new Promise((r) => setTimeout(r, 10));

    const es = (manager as unknown as { eventSource: { onmessage: (msg: { data: string }) => void } }).eventSource;
    es.onmessage({ data: "not json" });
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("replaces existing connection on re-connect", async () => {
    manager.connect("/events1");
    await new Promise((r) => setTimeout(r, 10));
    manager.connect("/events2");
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.status).toBe("connected");
  });
});
