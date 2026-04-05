import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchChains, fetchChainYaml, saveChain, deleteChain, fetchChainStats, fetchChainJson } from "../../src/api/chains";
import { api } from "../../src/api/client";

vi.spyOn(api, "get");
vi.spyOn(api, "post");
vi.spyOn(api, "delete");

describe("chains API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetchChains calls GET /chains", async () => {
    vi.mocked(api.get).mockResolvedValue([{ name: "test" }]);
    const result = await fetchChains();
    expect(api.get).toHaveBeenCalledWith("/chains");
    expect(result).toEqual([{ name: "test" }]);
  });

  it("fetchChainYaml calls GET /chains/:name", async () => {
    vi.mocked(api.get).mockResolvedValue("name: test\nsteps: []");
    const result = await fetchChainYaml("my-chain");
    expect(api.get).toHaveBeenCalledWith("/chains/my-chain");
    expect(result).toContain("name: test");
  });

  it("fetchChainYaml encodes special chars in name", async () => {
    vi.mocked(api.get).mockResolvedValue("");
    await fetchChainYaml("chain with spaces");
    expect(api.get).toHaveBeenCalledWith("/chains/chain%20with%20spaces");
  });

  it("saveChain calls POST /chains/:name", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    const result = await saveChain("my-chain", "yaml content");
    expect(api.post).toHaveBeenCalledWith("/chains/my-chain", { yaml: "yaml content" });
    expect(result).toEqual({ ok: true });
  });

  it("deleteChain calls DELETE /chains/:name", async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined);
    await deleteChain("my-chain");
    expect(api.delete).toHaveBeenCalledWith("/chains/my-chain");
  });

  it("fetchChainStats calls GET /chains/:name/stats", async () => {
    const stats = { totalExecutions: 5, avgDurationMs: 1000, successRate: 0.8 };
    vi.mocked(api.get).mockResolvedValue(stats);
    const result = await fetchChainStats("my-chain");
    expect(api.get).toHaveBeenCalledWith("/chains/my-chain/stats");
    expect(result).toEqual(stats);
  });

  it("fetchChainJson fetches parsed JSON via yaml-to-json", async () => {
    const mockDef = { name: "test", steps: [], output: "out" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockDef), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await fetchChainJson("test-chain");
    expect(result).toEqual(mockDef);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/yaml-to-json"),
      expect.anything(),
    );
  });
});
