/**
 * Integration tests for all existing chain YAML definitions.
 *
 * For every .yaml / .yml file in the chains/ directory, we verify:
 *   - It parses as valid YAML
 *   - It validates against the Zod schema (via loadChain)
 *   - It has a name, at least 1 step, and a valid output
 *   - Its dependency graph builds without errors
 *   - No circular dependencies
 *   - All depends_on references exist
 *   - output var matches a step's output_var
 *   - All step IDs are unique
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  loadChain,
  buildDependencyGraph,
  getChainsDir,
} from "../src/loader.js";
import type { ChainDefinition } from "../src/types.js";

// ── Discover chain files ─────────────────────────────────────────────────────

const chainsDir = path.resolve(__dirname, "..", "..", "chains");

let chainFiles: string[] = [];

beforeAll(() => {
  // Point CHAINS_DIR at the real chains directory
  process.env.CHAINS_DIR = chainsDir;
  chainFiles = fs
    .readdirSync(chainsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
});

// ── Tests per chain ──────────────────────────────────────────────────────────

describe("Chain YAML definitions", () => {
  // We build the file list eagerly so describe.each works
  const files = fs.existsSync(chainsDir)
    ? fs
        .readdirSync(chainsDir)
        .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && f !== "test.yaml")
        .sort()
    : [];

  if (files.length === 0) {
    it.skip("no chain files found — skipping", () => {});
    return;
  }

  describe.each(files)("%s", (file) => {
    const filePath = path.join(chainsDir, file);
    const chainName = path.basename(file, path.extname(file));

    it("parses as valid YAML", () => {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = yaml.load(raw);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });

    it("validates against the Zod schema (loadChain)", () => {
      process.env.CHAINS_DIR = chainsDir;
      // loadChain performs Zod safeParse internally and throws on failure
      const chain = loadChain(chainName);
      expect(chain).toBeDefined();
    });

    it("has a name", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      expect(chain.name).toBeTruthy();
      expect(typeof chain.name).toBe("string");
      expect(chain.name.length).toBeGreaterThan(0);
    });

    it("has at least 1 step", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      expect(chain.steps.length).toBeGreaterThanOrEqual(1);
    });

    it("has a valid output field", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      expect(chain.output).toBeTruthy();
      expect(typeof chain.output).toBe("string");
    });

    it("output var matches a step's output_var", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      const outputVars = new Set(chain.steps.map((s) => s.output_var));
      expect(outputVars.has(chain.output)).toBe(true);
    });

    it("all step IDs are unique", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      const ids = chain.steps.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("all depends_on references exist", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      const stepIds = new Set(chain.steps.map((s) => s.id));
      for (const step of chain.steps) {
        for (const dep of step.depends_on ?? []) {
          expect(stepIds.has(dep)).toBe(true);
        }
      }
    });

    it("dependency graph builds without errors", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      const graph = buildDependencyGraph(chain);
      expect(graph).toBeDefined();
      expect(graph.waves.length).toBeGreaterThanOrEqual(1);
    });

    it("no circular dependencies", () => {
      process.env.CHAINS_DIR = chainsDir;
      const chain = loadChain(chainName);
      // buildDependencyGraph throws on circular deps — if it returns, we're good
      expect(() => buildDependencyGraph(chain)).not.toThrow();
    });
  });
});
