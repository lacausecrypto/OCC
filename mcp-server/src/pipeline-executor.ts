/**
 * Pipeline (multi-chain) executor.
 * Runs chains in dependency order, passing outputs between them.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  PipelineDefinition,
  PipelineExecution,
  ExecutionEvent,
  ExecutionStatus,
} from "./types.js";
import { loadChain } from "./loader.js";
import { executeChain } from "./executor.js";
import { buildPipelineGraph } from "./pipeline-loader.js";
import { evaluateCondition, resolveVariables } from "./utils.js";

// ─── In-memory store ─────────────────────────────────────────────────────────

const pipelineExecutions = new Map<string, PipelineExecution>();

function getPersistFile(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "pipeline-executions.json");
  return path.join(os.tmpdir(), "occ-pipeline-executions.json");
}

function persist(): void {
  try {
    const file = getPersistFile();
    const data = JSON.stringify([...pipelineExecutions.values()].slice(-50), null, 2);
    fs.writeFile(file, data, "utf-8", () => {});
  } catch {}
}

export function loadPersistedPipelineExecutions(): void {
  try {
    const file = getPersistFile();
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as PipelineExecution[];
    for (const ex of data) {
      pipelineExecutions.set(ex.id, ex);
    }
    process.stderr.write(`[occ] Loaded ${data.length} persisted pipeline executions\n`);
  } catch {}
}

export function getPipelineExecution(id: string): PipelineExecution | undefined {
  return pipelineExecutions.get(id);
}

export function getAllPipelineExecutions(): PipelineExecution[] {
  return [...pipelineExecutions.values()].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt)
  );
}

/** Trim in-memory pipeline executions map to prevent unbounded growth. */
function trimPipelineExecutions(): void {
  if (pipelineExecutions.size > 75) {
    const sorted = [...pipelineExecutions.entries()].sort(
      (a, b) => a[1].startedAt.localeCompare(b[1].startedAt)
    );
    const toRemove = sorted.slice(0, sorted.length - 50);
    for (const [key] of toRemove) {
      pipelineExecutions.delete(key);
    }
  }
}

// ─── Variable resolution ─────────────────────────────────────────────────────

function resolveInputMapping(
  mapping: Record<string, string>,
  pipelineInput: Record<string, string>,
  chainResults: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, template] of Object.entries(mapping)) {
    let value = template;

    // Replace {input.xxx} with pipeline input
    value = value.replace(/\{input\.(\w+)\}/g, (_, k) => pipelineInput[k] ?? "");
    // Replace {input} shorthand
    value = value.replace(/\{input\}/g, JSON.stringify(pipelineInput));

    // Replace {chain_ref_id} with that chain's result
    value = value.replace(/\{(\w+)\}/g, (match, k) => {
      if (chainResults[k] !== undefined) return chainResults[k];
      if (pipelineInput[k] !== undefined) return pipelineInput[k];
      return match;
    });

    // Replace {chain_ref_id.result} explicitly
    value = value.replace(/\{(\w+)\.result\}/g, (_, k) => chainResults[k] ?? "");

    resolved[key] = value;
  }

  return resolved;
}

// evaluateCondition and resolveVariables imported from ./utils.ts

// ─── Pipeline executor ───────────────────────────────────────────────────────

type EventEmitter = (event: ExecutionEvent) => void;

export async function executePipeline(
  pipeline: PipelineDefinition,
  input: Record<string, string>,
  emit: EventEmitter
): Promise<string> {
  const executionId = "pip_" + crypto.randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Validate required inputs
  for (const inputDef of pipeline.inputs ?? []) {
    if (!inputDef.optional && input[inputDef.name] === undefined) {
      throw new Error(`Missing required pipeline input: "${inputDef.name}"`);
    }
  }

  const execution: PipelineExecution = {
    id: executionId,
    pipelineName: pipeline.name,
    status: "running",
    input,
    chains: {},
    startedAt,
  };

  // Init chain statuses
  for (const chainRef of pipeline.chains) {
    execution.chains[chainRef.id] = {
      chainRefId: chainRef.id,
      chainName: chainRef.chain,
      status: "pending",
    };
  }

  pipelineExecutions.set(executionId, execution);
  trimPipelineExecutions();
  persist();

  emit({ type: "execution_started", executionId, chainName: `pipeline:${pipeline.name}` });

  const graph = buildPipelineGraph(pipeline);
  const chainResults: Record<string, string> = {};

  // Add pipeline inputs to results for resolution
  for (const [k, v] of Object.entries(input)) {
    chainResults[`input.${k}`] = v;
    chainResults[k] = v;
  }

  try {
    for (const wave of graph.waves) {
      await Promise.all(
        wave.map(async (chainRefId) => {
          const chainRef = pipeline.chains.find(c => c.id === chainRefId)!;
          const chainStatus = execution.chains[chainRefId];

          // Check condition
          if (chainRef.condition) {
            if (!evaluateCondition(resolveVariables(chainRef.condition, chainResults))) {
              chainStatus.status = "skipped";
              chainResults[chainRefId] = "";
              emit({
                type: "step_log",
                executionId,
                stepId: chainRefId,
                message: `Pipeline chain "${chainRefId}" skipped (condition: ${chainRef.condition})`,
                level: "info",
              });
              persist();
              return;
            }
          }

          // Load the chain
          let chain;
          try {
            chain = loadChain(chainRef.chain);
          } catch (err) {
            const error = `Chain "${chainRef.chain}" not found: ${(err as Error).message}`;
            chainStatus.status = "error";
            chainStatus.error = error;
            emit({ type: "step_error", executionId, stepId: chainRefId, error });
            persist();
            throw new Error(error);
          }

          // Resolve inputs
          const chainInput = resolveInputMapping(chainRef.inputs, input, chainResults);

          chainStatus.status = "running";
          emit({
            type: "step_started",
            executionId,
            stepId: chainRefId,
            label: chainRef.label ?? `${chainRef.chain} (${chainRefId})`,
          });

          emit({
            type: "step_log",
            executionId,
            stepId: chainRefId,
            message: `Running chain "${chainRef.chain}" with inputs: ${Object.keys(chainInput).join(", ")}`,
            level: "info",
          });

          try {
            const startTime = Date.now();

            // Execute the chain, forwarding events with prefixed stepId
            const result = await executeChain(chain, chainInput, (event) => {
              // Prefix step events with the chain ref ID for disambiguation
              if ("stepId" in event) {
                emit({ ...event, stepId: `${chainRefId}/${event.stepId}` } as ExecutionEvent);
              }
            });

            const durationMs = Date.now() - startTime;
            chainStatus.status = "done";
            chainStatus.result = result;
            chainStatus.durationMs = durationMs;
            // Get the underlying execution ID from the result
            chainResults[chainRefId] = result;

            emit({
              type: "step_done",
              executionId,
              stepId: chainRefId,
              durationMs,
            });

            emit({
              type: "step_log",
              executionId,
              stepId: chainRefId,
              message: `Chain "${chainRef.chain}" completed in ${(durationMs / 1000).toFixed(1)}s (${result.length} chars)`,
              level: "info",
            });

            persist();
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            chainStatus.status = "error";
            chainStatus.error = error;
            emit({ type: "step_error", executionId, stepId: chainRefId, error });
            persist();
            throw err;
          }
        })
      );
    }

    // Final result
    const outputChainId = pipeline.output;
    const result = chainResults[outputChainId] ?? "";
    execution.status = "done";
    execution.result = result;
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(startedAt).getTime();

    emit({
      type: "execution_done",
      executionId,
      result,
      durationMs: execution.durationMs,
    });
    persist();

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    execution.status = "error";
    execution.error = error;
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(startedAt).getTime();

    for (const chainStatus of Object.values(execution.chains)) {
      if (chainStatus.status === "pending") {
        chainStatus.status = "skipped";
      }
    }

    emit({ type: "execution_error", executionId, error });
    persist();
    throw err;
  }
}
