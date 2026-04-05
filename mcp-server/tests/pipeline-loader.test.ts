import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { listPipelines, loadPipeline, loadPipelineRaw, buildPipelineGraph } from "../src/pipeline-loader.js";

const pipelinesDir = path.join(process.cwd(), "..", "pipelines");

beforeAll(() => {
  process.env.PIPELINES_DIR = pipelinesDir;
  process.env.CHAINS_DIR = path.join(process.cwd(), "..", "chains");
});

describe("Pipeline Loader", () => {
  it("listPipelines returns array of pipeline names", () => {
    const names = listPipelines();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("research-to-content");
    expect(names).toContain("product-intelligence");
  });

  it("loadPipeline returns valid pipeline definition", () => {
    const pip = loadPipeline("research-to-content");
    expect(pip.name).toBe("research-to-content");
    expect(pip.chains.length).toBeGreaterThan(0);
    expect(pip.chains[0].id).toBeTruthy();
    expect(pip.chains[0].chain).toBeTruthy();
  });

  it("loadPipelineRaw returns YAML string", () => {
    const raw = loadPipelineRaw("research-to-content");
    expect(typeof raw).toBe("string");
    expect(raw).toContain("name: research-to-content");
  });

  it("throws on invalid pipeline name", () => {
    expect(() => loadPipeline("../../etc/passwd")).toThrow("Invalid name");
  });

  it("throws on non-existent pipeline", () => {
    expect(() => loadPipeline("nonexistent-pipeline-xyz")).toThrow();
  });

  it("buildPipelineGraph creates dependency waves", () => {
    const pip = loadPipeline("research-to-content");
    const graph = buildPipelineGraph(pip);
    expect(Array.isArray(graph.waves)).toBe(true);
    expect(graph.waves.length).toBeGreaterThan(0);
    // First wave has no dependencies
    expect(graph.waves[0].length).toBeGreaterThan(0);
  });

  it("loads all pipelines without errors", () => {
    const names = listPipelines();
    for (const name of names) {
      expect(() => loadPipeline(name)).not.toThrow();
    }
  });
});
