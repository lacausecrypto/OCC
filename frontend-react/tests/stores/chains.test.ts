import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChainsStore } from "../../src/stores/chains";

vi.mock("../../src/api/chains", () => ({
  fetchChains: vi.fn(),
}));

vi.mock("../../src/api/pipelines", () => ({
  fetchPipelines: vi.fn(),
}));

import { fetchChains } from "../../src/api/chains";
import { fetchPipelines } from "../../src/api/pipelines";

describe("useChainsStore", () => {
  beforeEach(() => {
    useChainsStore.setState({
      chains: [],
      pipelines: [],
      loading: false,
      error: null,
      searchQuery: "",
      sortBy: "name",
      filterType: "all",
      viewMode: "grid",
      sizeFilter: "",
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useChainsStore.getState();
    expect(state.chains).toEqual([]);
    expect(state.pipelines).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.searchQuery).toBe("");
    expect(state.sortBy).toBe("name");
    expect(state.filterType).toBe("all");
    expect(state.viewMode).toBe("grid");
  });

  it("setSearchQuery updates query", () => {
    useChainsStore.getState().setSearchQuery("test");
    expect(useChainsStore.getState().searchQuery).toBe("test");
  });

  it("setSortBy updates sort", () => {
    useChainsStore.getState().setSortBy("steps");
    expect(useChainsStore.getState().sortBy).toBe("steps");
  });

  it("setFilterType updates filter", () => {
    useChainsStore.getState().setFilterType("chain");
    expect(useChainsStore.getState().filterType).toBe("chain");
  });

  it("setViewMode updates view mode", () => {
    useChainsStore.getState().setViewMode("list");
    expect(useChainsStore.getState().viewMode).toBe("list");
  });

  it("setSizeFilter updates size filter", () => {
    useChainsStore.getState().setSizeFilter("large");
    expect(useChainsStore.getState().sizeFilter).toBe("large");
  });

  it("fetchChains loads chains successfully", async () => {
    const mockChains = [{ name: "test-chain", stepCount: 3 }];
    vi.mocked(fetchChains).mockResolvedValue(mockChains);

    await useChainsStore.getState().fetchChains();
    expect(useChainsStore.getState().chains).toEqual(mockChains);
    expect(useChainsStore.getState().loading).toBe(false);
    expect(useChainsStore.getState().error).toBeNull();
  });

  it("fetchChains handles error", async () => {
    vi.mocked(fetchChains).mockRejectedValue(new Error("API down"));

    await useChainsStore.getState().fetchChains();
    expect(useChainsStore.getState().chains).toEqual([]);
    expect(useChainsStore.getState().loading).toBe(false);
    expect(useChainsStore.getState().error).toBe("API down");
  });

  it("fetchPipelines loads pipelines successfully", async () => {
    const mockPipelines = [{ name: "test-pipeline", chainCount: 2 }];
    vi.mocked(fetchPipelines).mockResolvedValue(mockPipelines);

    await useChainsStore.getState().fetchPipelines();
    expect(useChainsStore.getState().pipelines).toEqual(mockPipelines);
  });

  it("fetchPipelines handles error", async () => {
    vi.mocked(fetchPipelines).mockRejectedValue(new Error("Failed"));

    await useChainsStore.getState().fetchPipelines();
    expect(useChainsStore.getState().error).toBe("Failed");
  });

  it("fetchAll loads both chains and pipelines", async () => {
    const mockChains = [{ name: "chain1" }];
    const mockPipelines = [{ name: "pipe1" }];
    vi.mocked(fetchChains).mockResolvedValue(mockChains);
    vi.mocked(fetchPipelines).mockResolvedValue(mockPipelines);

    await useChainsStore.getState().fetchAll();
    expect(useChainsStore.getState().chains).toEqual(mockChains);
    expect(useChainsStore.getState().pipelines).toEqual(mockPipelines);
    expect(useChainsStore.getState().loading).toBe(false);
  });

  it("fetchAll handles error from either API", async () => {
    vi.mocked(fetchChains).mockRejectedValue(new Error("Chains failed"));
    vi.mocked(fetchPipelines).mockResolvedValue([]);

    await useChainsStore.getState().fetchAll();
    expect(useChainsStore.getState().error).toBe("Chains failed");
    expect(useChainsStore.getState().loading).toBe(false);
  });
});
