import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";
import {
  loadChain,
  saveChain,
  deleteChain,
  listChains,
  loadChainRaw,
  getChainsDir,
  buildDependencyGraph,
} from "../src/loader.js";
import type { ChainDefinition } from "../src/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let originalChainsDir: string | undefined;

function writeYaml(filename: string, obj: unknown): void {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, yaml.dump(obj), "utf-8");
}

function writeRawYaml(filename: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, filename), content, "utf-8");
}

/** Minimal valid chain object */
function minimalChain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-chain",
    steps: [
      {
        id: "step1",
        prompt: "Do something",
        output_var: "result",
      },
    ],
    output: "result",
    ...overrides,
  };
}

/** Build a ChainDefinition in-memory (already validated shape) for buildDependencyGraph */
function chainDef(steps: Array<Record<string, unknown>>, output: string): ChainDefinition {
  return {
    name: "graph-test",
    steps: steps.map((s) => ({
      id: s.id as string,
      prompt: s.prompt as string ?? "p",
      output_var: s.output_var as string ?? s.id as string,
      depends_on: (s.depends_on as string[]) ?? [],
      tools: [],
      ...(s.type ? { type: s.type } : {}),
    })) as ChainDefinition["steps"],
    output,
    inputs: [],
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-loader-test-"));
  originalChainsDir = process.env.CHAINS_DIR;
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  if (originalChainsDir === undefined) {
    delete process.env.CHAINS_DIR;
  } else {
    process.env.CHAINS_DIR = originalChainsDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Schema Validation (StepSchema via loadChain)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Schema Validation", () => {
  it("loads a valid minimal chain (required fields only)", () => {
    writeYaml("minimal.yaml", minimalChain());
    const chain = loadChain("minimal");
    expect(chain.name).toBe("test-chain");
    expect(chain.steps).toHaveLength(1);
    expect(chain.output).toBe("result");
  });

  it("loads a valid full chain (all fields populated)", () => {
    const full = {
      name: "full-chain",
      description: "A fully specified chain",
      version: "1.2.3",
      inputs: [
        { name: "topic", description: "The topic to research", optional: false },
        { name: "style", optional: true },
      ],
      steps: [
        {
          id: "research",
          type: "agent",
          label: "Research Step",
          model: "claude-sonnet-4-20250514",
          prompt: "Research {topic}",
          tools: ["web_search", "read_file"],
          depends_on: [],
          output_var: "research_result",
          cwd: "/tmp",
          condition: '{style} == "formal"',
          retry: { max: 3, delay_ms: 1000, backoff: 2 },
          fallback_models: ["claude-opus-4-20250514"],
          context_strategy: { research_result: "full" },
          pre_tools: [
            { type: "current_datetime", inject_as: "now" },
          ],
        },
        {
          id: "write",
          type: "agent",
          prompt: "Write about {research_result}",
          depends_on: ["research"],
          output_var: "final",
        },
      ],
      output: "final",
    };
    writeYaml("full.yaml", full);
    const chain = loadChain("full");
    expect(chain.name).toBe("full-chain");
    expect(chain.description).toBe("A fully specified chain");
    expect(chain.version).toBe("1.2.3");
    expect(chain.inputs).toHaveLength(2);
    expect(chain.steps).toHaveLength(2);
    expect(chain.steps[0].retry?.max).toBe(3);
    expect(chain.steps[0].fallback_models).toEqual(["claude-opus-4-20250514"]);
    expect(chain.steps[0].context_strategy).toEqual({ research_result: "full" });
  });

  describe("step types", () => {
    const stepTypes = ["agent", "router", "gate", "evaluator", "transform", "merge", "browser"] as const;

    for (const type of stepTypes) {
      it(`accepts step type: ${type}`, () => {
        const chain = minimalChain({
          steps: [
            { id: "s1", type, prompt: "do it", output_var: "out" },
          ],
        });
        writeYaml("typed.yaml", chain);
        const loaded = loadChain("typed");
        expect(loaded.steps[0].type).toBe(type);
      });
    }

    it("accepts step type: loop", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", type: "loop", prompt: "loop it", output_var: "out" },
        ],
      });
      writeYaml("loop.yaml", chain);
      const loaded = loadChain("loop");
      expect(loaded.steps[0].type).toBe("loop");
    });

    it("rejects unknown step type", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", type: "unknown_type", prompt: "nope", output_var: "out" },
        ],
      });
      writeYaml("bad-type.yaml", chain);
      expect(() => loadChain("bad-type")).toThrow(/Invalid chain/);
    });
  });

  describe("invalid chains", () => {
    it("rejects missing name", () => {
      writeYaml("noname.yaml", {
        steps: [{ id: "s1", prompt: "p", output_var: "o" }],
        output: "o",
      });
      expect(() => loadChain("noname")).toThrow(/Invalid chain/);
    });

    it("rejects missing steps", () => {
      writeYaml("nosteps.yaml", { name: "bad", output: "o" });
      expect(() => loadChain("nosteps")).toThrow(/Invalid chain/);
    });

    it("rejects empty steps array", () => {
      writeYaml("empty.yaml", { name: "bad", steps: [], output: "o" });
      expect(() => loadChain("empty")).toThrow(/Invalid chain/);
    });

    it("rejects step missing id", () => {
      writeYaml("noid.yaml", {
        name: "bad",
        steps: [{ prompt: "p", output_var: "o" }],
        output: "o",
      });
      expect(() => loadChain("noid")).toThrow(/Invalid chain/);
    });

    it("rejects step missing prompt", () => {
      writeYaml("noprompt.yaml", {
        name: "bad",
        steps: [{ id: "s1", output_var: "o" }],
        output: "o",
      });
      expect(() => loadChain("noprompt")).toThrow(/Invalid chain/);
    });

    it("rejects step missing output_var", () => {
      writeYaml("nooutvar.yaml", {
        name: "bad",
        steps: [{ id: "s1", prompt: "p" }],
        output: "o",
      });
      expect(() => loadChain("nooutvar")).toThrow(/Invalid chain/);
    });

    it("rejects bad retry config (missing max)", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", prompt: "p", output_var: "out", retry: { delay_ms: 500 } },
        ],
      });
      writeYaml("badretry.yaml", chain);
      expect(() => loadChain("badretry")).toThrow(/Invalid chain/);
    });
  });

  describe("optional fields", () => {
    it("accepts condition field", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", prompt: "p", output_var: "out", condition: '{x} == "yes"' },
        ],
      });
      writeYaml("cond.yaml", chain);
      const loaded = loadChain("cond");
      expect(loaded.steps[0].condition).toBe('{x} == "yes"');
    });

    it("accepts retry with all fields", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", prompt: "p", output_var: "out", retry: { max: 5, delay_ms: 2000, backoff: 3 } },
        ],
      });
      writeYaml("retry.yaml", chain);
      const loaded = loadChain("retry");
      expect(loaded.steps[0].retry).toEqual({ max: 5, delay_ms: 2000, backoff: 3 });
    });

    it("accepts fallback_models", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", prompt: "p", output_var: "out", fallback_models: ["model-a", "model-b"] },
        ],
      });
      writeYaml("fb.yaml", chain);
      const loaded = loadChain("fb");
      expect(loaded.steps[0].fallback_models).toEqual(["model-a", "model-b"]);
    });

    it("accepts context_strategy", () => {
      const chain = minimalChain({
        steps: [
          { id: "s1", prompt: "p", output_var: "out", context_strategy: { prev: "summarize" } },
        ],
      });
      writeYaml("ctx.yaml", chain);
      const loaded = loadChain("ctx");
      expect(loaded.steps[0].context_strategy).toEqual({ prev: "summarize" });
    });
  });

  describe("pre_tools validation", () => {
    const preToolTypes = [
      "current_datetime",
      "http_fetch",
      "web_search",
      "read_file",
      "write_file",
      "bash",
      "env_var",
    ] as const;

    for (const type of preToolTypes) {
      it(`accepts pre_tool type: ${type}`, () => {
        const chain = minimalChain({
          steps: [
            {
              id: "s1",
              prompt: "p",
              output_var: "out",
              pre_tools: [{ type, inject_as: "val" }],
            },
          ],
        });
        writeYaml("pt.yaml", chain);
        const loaded = loadChain("pt");
        expect(loaded.steps[0].pre_tools![0].type).toBe(type);
      });
    }

    it("rejects invalid pre_tool type", () => {
      const chain = minimalChain({
        steps: [
          {
            id: "s1",
            prompt: "p",
            output_var: "out",
            pre_tools: [{ type: "invalid_tool", inject_as: "val" }],
          },
        ],
      });
      writeYaml("badpt.yaml", chain);
      expect(() => loadChain("badpt")).toThrow(/Invalid chain/);
    });

    it("rejects pre_tool missing inject_as", () => {
      const chain = minimalChain({
        steps: [
          {
            id: "s1",
            prompt: "p",
            output_var: "out",
            pre_tools: [{ type: "bash" }],
          },
        ],
      });
      writeYaml("noinject.yaml", chain);
      expect(() => loadChain("noinject")).toThrow(/Invalid chain/);
    });
  });

  describe("browser step fields", () => {
    it("accepts browser_url, browser_task, browser_max_steps", () => {
      const chain = minimalChain({
        steps: [
          {
            id: "browse",
            type: "browser",
            prompt: "browse the web",
            output_var: "page",
            browser_url: "https://example.com",
            browser_task: "Extract the main heading",
            browser_max_steps: 10,
          },
        ],
      });
      writeYaml("browser.yaml", chain);
      const loaded = loadChain("browser");
      expect(loaded.steps[0].browser_url).toBe("https://example.com");
      expect(loaded.steps[0].browser_task).toBe("Extract the main heading");
      expect(loaded.steps[0].browser_max_steps).toBe(10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Dependency Graph (buildDependencyGraph)
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildDependencyGraph", () => {
  it("linear chain (A->B->C): 3 waves of 1", () => {
    const chain = chainDef(
      [
        { id: "A", prompt: "a", output_var: "a_out", depends_on: [] },
        { id: "B", prompt: "b", output_var: "b_out", depends_on: ["A"] },
        { id: "C", prompt: "c", output_var: "c_out", depends_on: ["B"] },
      ],
      "c_out",
    );
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(3);
    expect(graph.waves[0]).toEqual(["A"]);
    expect(graph.waves[1]).toEqual(["B"]);
    expect(graph.waves[2]).toEqual(["C"]);
  });

  it("parallel steps (A,B->C): wave 1=[A,B], wave 2=[C]", () => {
    const chain = chainDef(
      [
        { id: "A", prompt: "a", output_var: "a_out", depends_on: [] },
        { id: "B", prompt: "b", output_var: "b_out", depends_on: [] },
        { id: "C", prompt: "c", output_var: "c_out", depends_on: ["A", "B"] },
      ],
      "c_out",
    );
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(2);
    expect(graph.waves[0].sort()).toEqual(["A", "B"]);
    expect(graph.waves[1]).toEqual(["C"]);
  });

  it("diamond pattern (A->B,C->D): 3 waves", () => {
    const chain = chainDef(
      [
        { id: "A", prompt: "a", output_var: "a_out", depends_on: [] },
        { id: "B", prompt: "b", output_var: "b_out", depends_on: ["A"] },
        { id: "C", prompt: "c", output_var: "c_out", depends_on: ["A"] },
        { id: "D", prompt: "d", output_var: "d_out", depends_on: ["B", "C"] },
      ],
      "d_out",
    );
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(3);
    expect(graph.waves[0]).toEqual(["A"]);
    expect(graph.waves[1].sort()).toEqual(["B", "C"]);
    expect(graph.waves[2]).toEqual(["D"]);
  });

  it("single step: 1 wave", () => {
    const chain = chainDef(
      [{ id: "only", prompt: "p", output_var: "out", depends_on: [] }],
      "out",
    );
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(1);
    expect(graph.waves[0]).toEqual(["only"]);
  });

  it("detects circular dependency (A->B->A)", () => {
    const chain = chainDef(
      [
        { id: "A", prompt: "a", output_var: "a_out", depends_on: ["B"] },
        { id: "B", prompt: "b", output_var: "b_out", depends_on: ["A"] },
      ],
      "a_out",
    );
    expect(() => buildDependencyGraph(chain)).toThrow(/Circular dependency/);
  });

  it("throws on unknown dependency reference", () => {
    const chain = chainDef(
      [
        { id: "A", prompt: "a", output_var: "a_out", depends_on: ["nonexistent"] },
      ],
      "a_out",
    );
    expect(() => buildDependencyGraph(chain)).toThrow(/unknown step "nonexistent"/);
  });

  it("throws when chain.output does not match any step output_var", () => {
    const chain = chainDef(
      [{ id: "A", prompt: "a", output_var: "a_out", depends_on: [] }],
      "missing_var",
    );
    expect(() => buildDependencyGraph(chain)).toThrow(
      /Chain output "missing_var" does not match any step output_var/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. File Operations
// ═══════════════════════════════════════════════════════════════════════════════

describe("File Operations", () => {
  describe("getChainsDir", () => {
    it("returns CHAINS_DIR from env", () => {
      expect(getChainsDir()).toBe(tmpDir);
    });
  });

  describe("listChains", () => {
    it("returns .yaml and .yml files without extension", () => {
      writeYaml("alpha.yaml", minimalChain());
      writeYaml("beta.yml", minimalChain());
      fs.writeFileSync(path.join(tmpDir, "ignore.txt"), "not a chain");

      const names = listChains().sort();
      expect(names).toEqual(["alpha", "beta"]);
    });

    it("returns empty array for empty directory", () => {
      expect(listChains()).toEqual([]);
    });

    it("returns empty array for nonexistent directory", () => {
      process.env.CHAINS_DIR = path.join(tmpDir, "does-not-exist");
      expect(listChains()).toEqual([]);
    });
  });

  describe("loadChain", () => {
    it("loads a .yaml file", () => {
      writeYaml("mychain.yaml", minimalChain({ name: "mychain" }));
      const chain = loadChain("mychain");
      expect(chain.name).toBe("mychain");
    });

    it("falls back to .yml extension", () => {
      writeYaml("fallback.yml", minimalChain({ name: "fallback" }));
      const chain = loadChain("fallback");
      expect(chain.name).toBe("fallback");
    });

    it("prefers .yaml over .yml when both exist", () => {
      writeYaml("both.yaml", minimalChain({ name: "from-yaml" }));
      writeYaml("both.yml", minimalChain({ name: "from-yml" }));
      const chain = loadChain("both");
      expect(chain.name).toBe("from-yaml");
    });

    it("throws on missing chain", () => {
      expect(() => loadChain("nonexistent")).toThrow(/Chain "nonexistent" not found/);
    });
  });

  describe("saveChain", () => {
    it("creates directory if needed", () => {
      const subDir = path.join(tmpDir, "nested", "chains");
      process.env.CHAINS_DIR = subDir;

      const chain: ChainDefinition = {
        name: "saved",
        steps: [{ id: "s1", prompt: "p", output_var: "out", depends_on: [], tools: [] }],
        output: "out",
        inputs: [],
      };
      saveChain("saved", chain);

      expect(fs.existsSync(path.join(subDir, "saved.yaml"))).toBe(true);
    });

    it("writes valid YAML that can be re-loaded", () => {
      const chain: ChainDefinition = {
        name: "roundtrip",
        description: "test roundtrip",
        steps: [
          {
            id: "s1",
            prompt: "do the thing",
            output_var: "result",
            depends_on: [],
            tools: ["web_search"],
          },
        ],
        output: "result",
        inputs: [{ name: "query", description: "search query" }],
      };
      saveChain("roundtrip", chain);

      const reloaded = loadChain("roundtrip");
      expect(reloaded.name).toBe("roundtrip");
      expect(reloaded.description).toBe("test roundtrip");
      expect(reloaded.steps[0].prompt).toBe("do the thing");
      expect(reloaded.steps[0].tools).toEqual(["web_search"]);
    });
  });

  describe("deleteChain", () => {
    it("removes the file", () => {
      writeYaml("doomed.yaml", minimalChain());
      expect(fs.existsSync(path.join(tmpDir, "doomed.yaml"))).toBe(true);

      deleteChain("doomed");
      expect(fs.existsSync(path.join(tmpDir, "doomed.yaml"))).toBe(false);
    });

    it("removes .yml file", () => {
      writeYaml("doomed2.yml", minimalChain());
      deleteChain("doomed2");
      expect(fs.existsSync(path.join(tmpDir, "doomed2.yml"))).toBe(false);
    });

    it("throws on missing chain", () => {
      expect(() => deleteChain("ghost")).toThrow(/Chain "ghost" not found/);
    });
  });

  describe("loadChainRaw", () => {
    it("returns raw YAML string", () => {
      const rawContent = "name: raw-test\nsteps:\n  - id: s1\n    prompt: hello\n    output_var: out\noutput: out\n";
      writeRawYaml("rawchain.yaml", rawContent);

      const raw = loadChainRaw("rawchain");
      expect(raw).toBe(rawContent);
    });

    it("returns raw string from .yml file", () => {
      writeRawYaml("rawchain2.yml", "name: yml-raw\n");
      const raw = loadChainRaw("rawchain2");
      expect(raw).toBe("name: yml-raw\n");
    });

    it("throws on missing chain", () => {
      expect(() => loadChainRaw("missing")).toThrow(/Chain "missing" not found/);
    });
  });
});
