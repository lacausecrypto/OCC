import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeChain, fetchExecutions, fetchExecution, cancelExecution } from "../../src/api/executions";
import { api } from "../../src/api/client";

vi.spyOn(api, "get");
vi.spyOn(api, "post");
vi.spyOn(api, "delete");

describe("executions API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executeChain calls POST /execute/:name", async () => {
    vi.mocked(api.post).mockResolvedValue({ executionId: "e1" });
    const result = await executeChain("my-chain", { topic: "AI" });
    expect(api.post).toHaveBeenCalledWith("/execute/my-chain", { input: { topic: "AI" } });
    expect(result.executionId).toBe("e1");
  });

  it("executeChain includes priority when provided", async () => {
    vi.mocked(api.post).mockResolvedValue({ executionId: "e1" });
    await executeChain("chain", { x: "1" }, 5);
    expect(api.post).toHaveBeenCalledWith("/execute/chain", { input: { x: "1" }, priority: 5 });
  });

  it("fetchExecutions calls GET /executions with pagination", async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    await fetchExecutions(10, 5);
    expect(api.get).toHaveBeenCalledWith("/executions?limit=10&offset=5");
  });

  it("fetchExecutions uses defaults", async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    await fetchExecutions();
    expect(api.get).toHaveBeenCalledWith("/executions?limit=50&offset=0");
  });

  it("fetchExecution calls GET /executions/:id", async () => {
    const exec = { id: "e1", chainName: "test", status: "done" };
    vi.mocked(api.get).mockResolvedValue(exec);
    const result = await fetchExecution("e1");
    expect(api.get).toHaveBeenCalledWith("/executions/e1");
    expect(result).toEqual(exec);
  });

  it("cancelExecution calls DELETE /executions/:id", async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined);
    await cancelExecution("e1");
    expect(api.delete).toHaveBeenCalledWith("/executions/e1");
  });
});
