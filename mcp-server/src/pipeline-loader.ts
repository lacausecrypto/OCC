/**
 * Pipeline (multi-chain) YAML loader + validator + dependency graph.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";
import type { PipelineDefinition } from "./types.js";
import { sanitizeName } from "./loader.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const ChainRefSchema = z.object({
  id: z.string().min(1),
  chain: z.string().min(1),
  label: z.string().optional(),
  depends_on: z.array(z.string()).optional().default([]),
  condition: z.string().optional(),
  inputs: z.record(z.string(), z.string()).default({}),
  summarize_output: z.union([z.boolean(), z.number()]).optional(),
});

const PipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    optional: z.boolean().optional(),
  })).optional().default([]),
  chains: z.array(ChainRefSchema).min(1),
  output: z.string().min(1),
});

// ─── Directory ───────────────────────────────────────────────────────────────

function getPipelinesDir(): string {
  if (process.env.PIPELINES_DIR) return process.env.PIPELINES_DIR;
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "pipelines");
  // Resolve relative to this file (mcp-server/dist/ or mcp-server/src/)
  const fileDir = path.dirname(fileURLToPath(import.meta.url));
  const fromFile = path.resolve(fileDir, "..", "..", "pipelines");
  if (fs.existsSync(fromFile)) return fromFile;
  return path.join(process.cwd(), "pipelines");
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function listPipelines(): string[] {
  const dir = getPipelinesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map(f => f.replace(/\.ya?ml$/, ""))
    .sort();
}

export function loadPipeline(name: string): PipelineDefinition {
  const safeName = sanitizeName(name);
  const dir = getPipelinesDir();
  const yamlPath = path.join(dir, `${safeName}.yaml`);
  const ymlPath = path.join(dir, `${safeName}.yml`);
  const filePath = fs.existsSync(yamlPath) ? yamlPath : ymlPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pipeline "${name}" not found`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);
  const result = PipelineSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid pipeline "${name}":\n${errors}`);
  }

  return result.data as PipelineDefinition;
}

export function loadPipelineRaw(name: string): string {
  const safeName = sanitizeName(name);
  const dir = getPipelinesDir();
  const yamlPath = path.join(dir, `${safeName}.yaml`);
  const ymlPath = path.join(dir, `${safeName}.yml`);
  const filePath = fs.existsSync(yamlPath) ? yamlPath : ymlPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pipeline "${name}" not found`);
  }

  return fs.readFileSync(filePath, "utf-8");
}

export function savePipeline(name: string, pipeline: PipelineDefinition): void {
  const safeName = sanitizeName(name);
  const dir = getPipelinesDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${safeName}.yaml`);
  const content = yaml.dump(pipeline, { lineWidth: 200, noRefs: true, sortKeys: false });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function deletePipeline(name: string): void {
  const safeName = sanitizeName(name);
  const dir = getPipelinesDir();
  const yamlPath = path.join(dir, `${safeName}.yaml`);
  const ymlPath = path.join(dir, `${safeName}.yml`);
  const filePath = fs.existsSync(yamlPath) ? yamlPath : ymlPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pipeline "${name}" not found`);
  }

  fs.unlinkSync(filePath);
}

// ─── Dependency graph ────────────────────────────────────────────────────────

export interface PipelineGraph {
  waves: string[][]; // each wave is a set of chain ref IDs that can run in parallel
}

export function buildPipelineGraph(pipeline: PipelineDefinition): PipelineGraph {
  const chainMap = new Map(pipeline.chains.map(c => [c.id, c]));

  // Validate references
  for (const chain of pipeline.chains) {
    for (const dep of chain.depends_on ?? []) {
      if (!chainMap.has(dep)) {
        throw new Error(`Pipeline "${pipeline.name}": chain "${chain.id}" depends on unknown chain "${dep}"`);
      }
    }
  }

  // Validate output
  if (!chainMap.has(pipeline.output)) {
    throw new Error(`Pipeline "${pipeline.name}": output "${pipeline.output}" references unknown chain`);
  }

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const chain of pipeline.chains) {
    inDegree.set(chain.id, (chain.depends_on ?? []).length);
    adj.set(chain.id, []);
  }

  for (const chain of pipeline.chains) {
    for (const dep of chain.depends_on ?? []) {
      adj.get(dep)!.push(chain.id);
    }
  }

  const waves: string[][] = [];
  const remaining = new Set(pipeline.chains.map(c => c.id));

  while (remaining.size > 0) {
    const wave = [...remaining].filter(id => (inDegree.get(id) ?? 0) === 0);
    if (wave.length === 0) {
      throw new Error(`Pipeline "${pipeline.name}": circular dependency detected`);
    }

    waves.push(wave);

    for (const id of wave) {
      remaining.delete(id);
      for (const next of adj.get(id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      }
    }
  }

  return { waves };
}
