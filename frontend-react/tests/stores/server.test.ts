import { describe, it, expect, vi, beforeEach } from "vitest";
import { useServerStore } from "../../src/stores/server";

describe("useServerStore", () => {
  beforeEach(() => {
    useServerStore.setState({
      occServerUrl: "http://localhost:4242",
      serverOnline: false,
      apiKey: null,
    });
    vi.restoreAllMocks();
  });

  it("has correct initial state", () => {
    const state = useServerStore.getState();
    expect(state.occServerUrl).toBe("http://localhost:4242");
    expect(state.serverOnline).toBe(false);
    expect(state.apiKey).toBeNull();
  });

  it("setServerUrl updates URL", () => {
    useServerStore.getState().setServerUrl("http://custom:9999");
    expect(useServerStore.getState().occServerUrl).toBe("http://custom:9999");
  });

  it("setApiKey updates key", () => {
    useServerStore.getState().setApiKey("my-secret");
    expect(useServerStore.getState().apiKey).toBe("my-secret");
  });

  it("setApiKey clears key with null", () => {
    useServerStore.getState().setApiKey("key");
    useServerStore.getState().setApiKey(null);
    expect(useServerStore.getState().apiKey).toBeNull();
  });

  it("checkHealth sets serverOnline=true on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await useServerStore.getState().checkHealth();
    expect(result).toBe(true);
    expect(useServerStore.getState().serverOnline).toBe(true);
  });

  it("checkHealth sets serverOnline=true for status=ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    const result = await useServerStore.getState().checkHealth();
    expect(result).toBe(true);
    expect(useServerStore.getState().serverOnline).toBe(true);
  });

  it("checkHealth sets serverOnline=false on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const result = await useServerStore.getState().checkHealth();
    expect(result).toBe(false);
    expect(useServerStore.getState().serverOnline).toBe(false);
  });

  it("checkHealth sets serverOnline=false on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );
    const result = await useServerStore.getState().checkHealth();
    expect(result).toBe(false);
    expect(useServerStore.getState().serverOnline).toBe(false);
  });
});
