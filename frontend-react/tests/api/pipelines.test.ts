import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPipelines, fetchPipelineJson, executePipeline, fetchPipelineExecution } from "../../src/api/pipelines";
import { api } from "../../src/api/client";

vi.spyOn(api, "get");
vi.spyOn(api, "post");

describe("pipelines API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetchPipelines calls GET /pipelines", async () => {
    vi.mocked(api.get).mockResolvedValue([{ name: "pipe1" }]);
    const result = await fetchPipelines();
    expect(api.get).toHaveBeenCalledWith("/pipelines");
    expect(result).toEqual([{ name: "pipe1" }]);
  });

  it("fetchPipelineJson calls GET /pipelines/:name/json", async () => {
    const def = { name: "test", chains: [], output: "out" };
    vi.mocked(api.get).mockResolvedValue(def);
    const result = await fetchPipelineJson("test-pipe");
    expect(api.get).toHaveBeenCalledWith("/pipelines/test-pipe/json");
    expect(result).toEqual(def);
  });

  it("executePipeline calls POST /pipelines/:name/execute", async () => {
    vi.mocked(api.post).mockResolvedValue({ executionId: "pe1" });
    const result = await executePipeline("pipe", { data: "x" });
    expect(api.post).toHaveBeenCalledWith("/pipelines/pipe/execute", { input: { data: "x" } });
    expect(result.executionId).toBe("pe1");
  });

  it("fetchPipelineExecution calls GET /pipeline-executions/:id", async () => {
    const exec = { id: "pe1", pipelineName: "test" };
    vi.mocked(api.get).mockResolvedValue(exec);
    const result = await fetchPipelineExecution("pe1");
    expect(api.get).toHaveBeenCalledWith("/pipeline-executions/pe1");
    expect(result).toEqual(exec);
  });
});
