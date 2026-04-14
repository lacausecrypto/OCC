#!/usr/bin/env node
/**
 * OCC CLI — Command-line interface for the Claude Chain Orchestrator.
 *
 * Usage:
 *   occ list                          List all chains and pipelines
 *   occ run <chain> [--input k=v]     Execute a chain
 *   occ validate [path]               Lint and validate chains
 *   occ dry-run <chain> [--input k=v] Preview execution without LLM calls
 *   occ status <executionId>          Check execution status
 *   occ logs <executionId>            Stream execution logs (SSE)
 *   occ health                        Check server health
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ─────────────────────────────────────────────────────────────────

const BASE_URL = process.env.OCC_URL || `http://localhost:${process.env.REST_PORT || 4242}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseInputArgs(args: string[]): Record<string, string> {
  const input: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" || args[i] === "-i") {
      const kv = args[++i];
      if (kv) {
        const eq = kv.indexOf("=");
        if (eq > 0) {
          input[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
    }
  }
  return input;
}

// CLI helper: returns the parsed JSON or raw text. Callers narrow locally by
// asserting on the response shape, so `data` is intentionally polymorphic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJSON(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  const url = `${BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text };
    }
  } catch {
    console.error(`\x1b[31mError: Cannot connect to OCC server at ${BASE_URL}\x1b[0m`);
    console.error(`\nThe server is not running. Start it with:\n`);
    console.error(`  \x1b[1mocc start\x1b[0m`);
    console.error(`\nOr manually:`);
    console.error(`  cd mcp-server && npm run rest\n`);
    console.error(`\x1b[2mTip: run \x1b[0m\x1b[1mocc doctor\x1b[0m\x1b[2m to check all prerequisites.\x1b[0m`);
    process.exit(1);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// Token costs per million tokens (March 2026)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.25, output: 1.25 },
};

// ─── Global flags ───────────────────────────────────────────────────────────

const JSON_OUTPUT = process.argv.includes("--json");

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdList() {
  const { data: chains } = await fetchJSON("/chains");
  const { data: pipelines } = await fetchJSON("/pipelines");

  if (JSON_OUTPUT) { console.log(JSON.stringify({ chains, pipelines })); return; }

  console.log("\x1b[1mChains:\x1b[0m");
  if (Array.isArray(chains) && chains.length > 0) {
    for (const c of chains) {
      const steps = c.stepCount ? ` (${c.stepCount} steps)` : "";
      console.log(`  \x1b[36m${c.name}\x1b[0m${steps}${c.description ? ` — ${c.description}` : ""}`);
    }
  } else {
    console.log("  (none)");
  }

  console.log(`\n\x1b[1mPipelines:\x1b[0m`);
  if (Array.isArray(pipelines) && pipelines.length > 0) {
    for (const p of pipelines) {
      const chains = p.chainCount ? ` (${p.chainCount} chains)` : "";
      console.log(`  \x1b[35m${p.name}\x1b[0m${chains}${p.description ? ` — ${p.description}` : ""}`);
    }
  } else {
    console.log("  (none)");
  }
}

async function cmdRun(chainName: string, args: string[]) {
  const input = parseInputArgs(args);
  const priority = parsePriority(args);

  if (!JSON_OUTPUT) {
    console.log(`\x1b[1mExecuting:\x1b[0m ${chainName}`);
    if (Object.keys(input).length > 0) console.log(`\x1b[1mInputs:\x1b[0m ${JSON.stringify(input)}`);
  }

  const { status, data } = await fetchJSON(`/execute/${chainName}`, "POST", { input, priority });
  if (status >= 400) {
    console.error(`\x1b[31mError:\x1b[0m ${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }

  if (data.queued) {
    if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
    console.log(`\x1b[33mQueued:\x1b[0m ${data.jobId} (position ${data.position})`);
    console.log(`  ${data.message}`);
    return;
  }

  const executionId = data.executionId;
  if (JSON_OUTPUT) { console.log(JSON.stringify({ executionId })); return; }
  console.log(`\x1b[1mExecution:\x1b[0m ${executionId}`);
  console.log(`\x1b[2mStreaming logs...\x1b[0m\n`);

  await streamLogs(executionId);
}

async function streamLogs(executionId: string) {
  const url = `${BASE_URL}/executions/${executionId}/stream`;
  try {
    const res = await fetch(url);
    if (!res.body) {
      console.error("No stream body");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          formatEvent(event);

          if (event.type === "execution_done") {
            console.log(`\n\x1b[32m--- Result ---\x1b[0m`);
            const result = event.result || "";
            console.log(result.length > 2000 ? result.slice(0, 2000) + "\n...(truncated)" : result);
            return;
          }
          if (event.type === "execution_error") {
            console.error(`\n\x1b[31mExecution failed:\x1b[0m ${event.error}`);
            process.exit(1);
          }
        } catch {
          // Non-JSON line (heartbeat, etc.)
        }
      }
    }
  } catch (err) {
    console.error(`Stream error: ${err}`);
  }
}

interface StreamEvent {
  type: string;
  chainName?: string;
  label?: string;
  stepId?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  result?: unknown;
  [k: string]: unknown;
}

function formatEvent(event: StreamEvent) {
  switch (event.type) {
    case "execution_started":
      console.log(`\x1b[1m[START]\x1b[0m Chain: ${event.chainName}`);
      break;
    case "step_started":
      console.log(`  \x1b[36m[STEP]\x1b[0m ${event.label || event.stepId} ...`);
      break;
    case "step_done":
      console.log(`  \x1b[32m[DONE]\x1b[0m ${event.stepId} (${formatDuration(event.durationMs ?? 0)}${event.inputTokens ? `, ${event.inputTokens}+${event.outputTokens} tokens` : ""})`);
      break;
    case "step_error":
      console.log(`  \x1b[31m[FAIL]\x1b[0m ${event.stepId}: ${event.error}`);
      break;
    case "step_cache_hit":
      console.log(`  \x1b[33m[CACHE]\x1b[0m ${event.stepId}`);
      break;
    case "step_waiting_approval":
      console.log(`  \x1b[33m[GATE]\x1b[0m ${event.stepId} — waiting for approval`);
      break;
    case "step_log":
      console.log(`  \x1b[2m[LOG]\x1b[0m ${event.message}`);
      break;
  }
}

async function cmdValidate(targetPath: string) {
  // Load linter dynamically (works both compiled and in dev)
  const linterPath = path.resolve(__dirname, "..", "linter.js");
  const loaderPath = path.resolve(__dirname, "..", "loader.js");

  let lintChain: typeof import("../linter.js").lintChain;
  let loadChain: typeof import("../loader.js").loadChain;
  let listChains: typeof import("../loader.js").listChains;

  try {
    const linter = await import(pathToFileURL(linterPath).href);
    const loader = await import(pathToFileURL(loaderPath).href);
    lintChain = linter.lintChain;
    loadChain = loader.loadChain;
    listChains = loader.listChains;
  } catch {
    console.error("\x1b[31mError: Build first — run `npm run build` in mcp-server/\x1b[0m");
    process.exit(1);
  }

  // Set CHAINS_DIR if path provided — normalize to absolute path
  if (targetPath && fs.existsSync(targetPath)) {
    if (fs.statSync(targetPath).isDirectory()) {
      process.env.CHAINS_DIR = path.resolve(targetPath);
    } else {
      process.env.CHAINS_DIR = path.resolve(path.dirname(targetPath));
    }
  }

  const names = listChains();
  if (names.length === 0) {
    console.log("\x1b[33mNo chains found.\x1b[0m");
    return;
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const name of names) {
    try {
      const chain = loadChain(name);
      const issues = lintChain(chain);

      const errors = issues.filter((i: { level: string }) => i.level === "error");
      const warnings = issues.filter((i: { level: string }) => i.level === "warning");
      totalErrors += errors.length;
      totalWarnings += warnings.length;

      if (issues.length === 0) {
        console.log(`  \x1b[32m✓\x1b[0m ${name} (${chain.steps.length} steps)`);
      } else {
        const symbol = errors.length > 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[33m⚠\x1b[0m";
        console.log(`  ${symbol} ${name} (${chain.steps.length} steps)`);
        for (const issue of issues) {
          const color = issue.level === "error" ? "31" : issue.level === "warning" ? "33" : "2";
          const prefix = issue.stepId ? `${issue.stepId}: ` : "";
          console.log(`    \x1b[${color}m${issue.level}\x1b[0m ${prefix}${issue.message}`);
        }
      }
    } catch (err) {
      totalErrors++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${(err as Error).message}`);
    }
  }

  console.log(`\n\x1b[1m${names.length} chains\x1b[0m validated: \x1b[31m${totalErrors} errors\x1b[0m, \x1b[33m${totalWarnings} warnings\x1b[0m`);
  if (totalErrors > 0) process.exit(1);
}

async function cmdDryRun(chainName: string, args: string[]) {
  const input = parseInputArgs(args);

  const linterPath = path.resolve(__dirname, "..", "linter.js");
  const loaderPath = path.resolve(__dirname, "..", "loader.js");

  let dryRunChain: typeof import("../linter.js").dryRunChain;
  let loadChain: typeof import("../loader.js").loadChain;

  try {
    const linter = await import(pathToFileURL(linterPath).href);
    const loader = await import(pathToFileURL(loaderPath).href);
    dryRunChain = linter.dryRunChain;
    loadChain = loader.loadChain;
  } catch {
    console.error("\x1b[31mError: Build first — run `npm run build` in mcp-server/\x1b[0m");
    process.exit(1);
  }

  let chain;
  try {
    chain = loadChain(chainName);
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${(err as Error).message}`);
    process.exit(1);
  }

  const result = dryRunChain(chain, input);

  // Display issues
  if (result.issues.length > 0) {
    console.log(`\x1b[1mIssues:\x1b[0m`);
    for (const issue of result.issues) {
      const color = issue.level === "error" ? "31" : issue.level === "warning" ? "33" : "2";
      const prefix = issue.stepId ? `${issue.stepId}: ` : "";
      console.log(`  \x1b[${color}m${issue.level}\x1b[0m ${prefix}${issue.message}`);
    }
    console.log();
  }

  // Display execution plan
  console.log(`\x1b[1mExecution Plan:\x1b[0m ${chain.name} (${chain.description || ""})\n`);

  let currentWave = 0;
  for (const step of result.plan) {
    if (step.wave !== currentWave) {
      currentWave = step.wave;
      const parallel = result.plan.filter((s: { wave: number }) => s.wave === currentWave).length;
      console.log(`\x1b[1m  Wave ${currentWave}\x1b[0m${parallel > 1 ? ` (${parallel} parallel)` : ""}`);
    }
    console.log(`    \x1b[36m${step.stepId}\x1b[0m [${step.model}]${step.dependsOn.length ? ` ← ${step.dependsOn.join(", ")}` : ""}`);
    console.log(`    \x1b[2m${step.promptPreview}\x1b[0m\n`);
  }

  // Display cost estimate
  console.log(`\x1b[1mEstimated Cost:\x1b[0m`);
  console.log(`  Steps: ${result.estimatedCost.totalSteps} (${result.estimatedCost.parallelWaves} waves)`);
  console.log(`  Models:`);

  let totalMinCost = 0;
  let totalMaxCost = 0;
  for (const [model, countRaw] of Object.entries(result.estimatedCost.models)) {
    const count = countRaw as number;
    const costs = MODEL_COSTS[model] || MODEL_COSTS["claude-sonnet-4-6"];
    // Estimate: ~2K input + ~1K output tokens per step average
    const minCost = count * (2000 * costs.input + 1000 * costs.output) / 1_000_000;
    const maxCost = count * (5000 * costs.input + 3000 * costs.output) / 1_000_000;
    totalMinCost += minCost;
    totalMaxCost += maxCost;
    console.log(`    ${model}: ${count} step${count > 1 ? "s" : ""} (~$${minCost.toFixed(3)}-$${maxCost.toFixed(3)})`);
  }
  console.log(`  \x1b[1mTotal: ~$${totalMinCost.toFixed(3)}-$${totalMaxCost.toFixed(3)}\x1b[0m`);
}

async function cmdStatus(executionId: string) {
  const { status, data } = await fetchJSON(`/executions/${executionId}`);
  if (status === 404) {
    console.error(`\x1b[31mExecution not found:\x1b[0m ${executionId}`);
    process.exit(1);
  }

  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }

  const statusColor = data.status === "done" ? "32" : data.status === "error" ? "31" : data.status === "running" ? "36" : "33";
  console.log(`\x1b[1mExecution:\x1b[0m ${data.id}`);
  console.log(`\x1b[1mChain:\x1b[0m ${data.chainName}`);
  console.log(`\x1b[1mStatus:\x1b[0m \x1b[${statusColor}m${data.status}\x1b[0m`);
  if (data.durationMs) console.log(`\x1b[1mDuration:\x1b[0m ${formatDuration(data.durationMs)}`);
  if (data.error) console.log(`\x1b[31mError:\x1b[0m ${data.error}`);

  console.log(`\n\x1b[1mSteps:\x1b[0m`);
  interface StepSummary { status: string; durationMs?: number; inputTokens?: number; outputTokens?: number; error?: string }
  for (const [stepId, step] of Object.entries(data.steps) as [string, StepSummary][]) {
    const sc = step.status === "done" ? "32" : step.status === "error" ? "31" : step.status === "running" ? "36" : "2";
    const dur = step.durationMs ? ` (${formatDuration(step.durationMs)})` : "";
    const tokens = step.inputTokens ? ` [${step.inputTokens}+${step.outputTokens} tokens]` : "";
    console.log(`  \x1b[${sc}m${step.status.padEnd(7)}\x1b[0m ${stepId}${dur}${tokens}`);
    if (step.error) console.log(`          \x1b[31m${step.error}\x1b[0m`);
  }

  if (data.result && data.status === "done") {
    console.log(`\n\x1b[32m--- Result ---\x1b[0m`);
    console.log(data.result.length > 2000 ? data.result.slice(0, 2000) + "\n...(truncated)" : data.result);
  }
}

async function cmdLogs(executionId: string) {
  console.log(`\x1b[2mStreaming logs for ${executionId}...\x1b[0m\n`);
  await streamLogs(executionId);
}

async function cmdHealth() {
  const { status, data } = await fetchJSON("/health");
  if (status === 200) {
    if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
    console.log(`\x1b[32mOCC server is running\x1b[0m`);
    console.log(`  Version: ${data.version}`);
    console.log(`  Running executions: ${data.runningExecutions}`);
    if (data.queue) {
      console.log(`  Queue: ${data.queue.queued} queued, ${data.queue.running} running, ${data.queue.done} done`);
    }
    if (data.mcpServers?.length > 0) {
      console.log(`  MCP servers: ${data.mcpServers.join(", ")}`);
    }
    console.log(`  URL: ${BASE_URL}`);
  } else {
    console.error(`\x1b[31mServer returned ${status}\x1b[0m`);
    process.exit(1);
  }
}

async function cmdCancel(executionId: string) {
  const { status, data } = await fetchJSON(`/executions/${executionId}`, "DELETE");
  if (status === 404) {
    console.error(`\x1b[31mExecution not found or already finished:\x1b[0m ${executionId}`);
    process.exit(1);
  }
  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
  console.log(`\x1b[32mCancelled:\x1b[0m ${executionId}`);
}

async function cmdQueue() {
  const { data: stats } = await fetchJSON("/queue");
  const { data: jobs } = await fetchJSON("/queue/jobs?limit=20");

  if (JSON_OUTPUT) { console.log(JSON.stringify({ stats, jobs })); return; }

  console.log(`\x1b[1mQueue Stats:\x1b[0m`);
  console.log(`  Queued:   ${stats.queued}`);
  console.log(`  Running:  ${stats.running}`);
  console.log(`  Done:     ${stats.done}`);
  console.log(`  Errors:   ${stats.errored}`);
  console.log(`  Workers:  ${stats.activeWorkers}/${stats.maxWorkers}`);
  if (stats.avgWaitSeconds > 0) {
    console.log(`  Avg wait: ${stats.avgWaitSeconds}s`);
  }

  if (Array.isArray(jobs) && jobs.length > 0) {
    console.log(`\n\x1b[1mRecent Jobs:\x1b[0m`);
    for (const job of jobs) {
      const sc = job.status === "done" ? "32" : job.status === "error" ? "31" : job.status === "running" ? "36" : "33";
      const exec = job.executionId ? ` → ${job.executionId}` : "";
      console.log(`  \x1b[${sc}m${job.status.padEnd(7)}\x1b[0m ${job.name} (p${job.priority})${exec}`);
    }
  }
}

async function cmdTimeline(executionId: string) {
  const { status, data } = await fetchJSON(`/executions/${executionId}/timeline`);
  if (status === 404) {
    console.error(`\x1b[31mExecution not found:\x1b[0m ${executionId}`);
    process.exit(1);
  }

  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }

  console.log(`\x1b[1mTimeline for ${executionId}:\x1b[0m\n`);
  if (!Array.isArray(data) || data.length === 0) {
    console.log("  (no checkpoints)");
    return;
  }
  for (const entry of data) {
    const sc = entry.status === "done" ? "32" : entry.status === "error" ? "31" : "36";
    const dur = entry.durationMs ? ` (${formatDuration(entry.durationMs)})` : "";
    const tokens = entry.inputTokens ? ` [${entry.inputTokens}+${entry.outputTokens} tok]` : "";
    console.log(`  \x1b[${sc}m${entry.status.padEnd(7)}\x1b[0m ${entry.stepId}${dur}${tokens}  \x1b[2m${entry.checkpointAt}\x1b[0m`);
  }
}

async function cmdStats(chainName: string) {
  const { status, data } = await fetchJSON(`/chains/${chainName}/stats`);
  if (status >= 400) {
    console.error(`\x1b[31mError:\x1b[0m ${data.error || "Stats unavailable"}`);
    process.exit(1);
  }

  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }

  console.log(`\x1b[1mStats for ${chainName}:\x1b[0m`);
  console.log(`  Total runs:     ${data.totalRuns}`);
  console.log(`  Success rate:   ${data.successRate.toFixed(1)}%`);
  console.log(`  Avg duration:   ${formatDuration(data.avgDurationMs)}`);
  console.log(`  Total tokens:   ${data.totalTokens.input} input, ${data.totalTokens.output} output`);

  const costs = MODEL_COSTS["claude-sonnet-4-6"];
  const estCost = (data.totalTokens.input * costs.input + data.totalTokens.output * costs.output) / 1_000_000;
  if (estCost > 0) {
    console.log(`  Est. total cost: ~$${estCost.toFixed(3)} (Sonnet rates)`);
  }
}

async function cmdApprove(executionId: string, stepId: string, approved: boolean) {
  const { status, data } = await fetchJSON(
    `/executions/${executionId}/approve/${stepId}`,
    "POST",
    { approved }
  );
  if (status === 404) {
    console.error(`\x1b[31mNo pending approval found\x1b[0m`);
    process.exit(1);
  }
  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
  console.log(`\x1b[32m${approved ? "Approved" : "Rejected"}:\x1b[0m ${executionId} / ${stepId}`);
}

async function cmdRunPipeline(pipelineName: string, args: string[]) {
  const input = parseInputArgs(args);
  const priority = parsePriority(args);

  console.log(`\x1b[1mExecuting pipeline:\x1b[0m ${pipelineName}`);
  if (Object.keys(input).length > 0) {
    console.log(`\x1b[1mInputs:\x1b[0m ${JSON.stringify(input)}`);
  }

  const { status, data } = await fetchJSON(`/pipelines/${pipelineName}/execute`, "POST", { input, priority });
  if (status >= 400) {
    console.error(`\x1b[31mError:\x1b[0m ${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }

  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
  console.log(`\x1b[1mExecution:\x1b[0m ${data.executionId}`);
}

function parsePriority(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--priority" || args[i] === "-p") {
      const val = Number(args[i + 1]);
      if (!isNaN(val)) return Math.max(1, Math.min(10, Math.round(val)));
    }
  }
  return 5;
}

async function cmdGenerate(description: string) {
  console.log(`\x1b[1mGenerating chain:\x1b[0m ${description}\n`);

  const { status, data } = await fetchJSON("/generate-chain", "POST", { description });
  if (status >= 400) {
    console.error(`\x1b[31mError:\x1b[0m ${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }

  if (data.status === "questions") {
    // Claude needs more info — show questions
    if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
    console.log(`\x1b[33mClaude has questions:\x1b[0m`);
    for (const q of data.questions ?? []) {
      console.log(`  - ${q}`);
    }
    console.log(`\nSession: ${data.sessionId}`);
    console.log(`Answer with: occ generate-answer ${data.sessionId} "your answers here"`);
    return;
  }

  if (data.status === "created") {
    if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
    console.log(`\x1b[32mChain created:\x1b[0m ${data.chainName}`);
    if (data.summary) {
      console.log(`\n${data.summary.slice(0, 500)}`);
    }
    console.log(`\nYAML saved to chains/${data.chainName}.yaml`);
    console.log(`Run it: occ run ${data.chainName} --input <key>=<value>`);
    return;
  }

  // Unknown status
  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
  console.log(JSON.stringify(data, null, 2));
}

async function cmdGenerateAnswer(sessionId: string, answers: string) {
  const { status, data } = await fetchJSON("/generate-chain", "POST", { sessionId, answers });
  if (status >= 400) {
    console.error(`\x1b[31mError:\x1b[0m ${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }

  if (data.status === "created") {
    if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
    console.log(`\x1b[32mChain created:\x1b[0m ${data.chainName}`);
    console.log(`Run it: occ run ${data.chainName} --input <key>=<value>`);
    return;
  }

  if (JSON_OUTPUT) { console.log(JSON.stringify(data)); return; }
  console.log(JSON.stringify(data, null, 2));
}

// ─── occ init ──────────────────────────────────────────────────────────────

const EXAMPLE_CHAINS: Record<string, string> = {
  "hello-world": `name: hello-world
description: "Your first OCC chain"
inputs:
  - name: topic
    description: "What to research"
steps:
  - id: research
    model: claude-haiku-4-5
    prompt: |
      Give me 5 key facts about "{input.topic}".
      Be concise, one sentence per fact.
    output_var: facts
  - id: summary
    model: claude-haiku-4-5
    depends_on: [research]
    prompt: |
      Based on these facts, write a 3-sentence summary:
      {facts}
    output_var: result
output: result
`,
  "web-analyzer": `name: web-analyzer
description: "Fetch and analyze a web page (pre-tool demo, 0 token data collection)"
inputs:
  - name: url
    type: url
    description: "URL to analyze"
    default: "https://en.wikipedia.org/wiki/Artificial_intelligence"
steps:
  - id: analyze
    model: claude-haiku-4-5
    pre_tools:
      - type: http_fetch
        url: "{input.url}"
        inject_as: page_content
    prompt: |
      Analyze this web page and provide:
      1. Title
      2. Summary (3 sentences)
      3. Key topics (5 bullet points)

      PAGE CONTENT:
      {page_content}
    output_var: analysis
output: analysis
`,
  "parallel-pros-cons": `name: parallel-pros-cons
description: "Parallel execution demo: 2 agents run simultaneously, then merge"
inputs:
  - name: topic
    description: "Topic to evaluate"
steps:
  - id: pros
    model: claude-haiku-4-5
    prompt: "List 5 compelling advantages of {input.topic}. One sentence each."
    output_var: pros_list
  - id: cons
    model: claude-haiku-4-5
    prompt: "List 5 significant disadvantages of {input.topic}. One sentence each."
    output_var: cons_list
  - id: verdict
    model: claude-haiku-4-5
    depends_on: [pros, cons]
    prompt: |
      Based on this analysis, give a final verdict in 3 sentences.
      PROS: {pros_list}
      CONS: {cons_list}
    output_var: final_verdict
output: final_verdict
`,
};

const INIT_ENV = `# OCC (Orchestrator Chain Chimera) configuration
# See: https://github.com/lacausecrypto/OCC

# Server
REST_PORT=4242
REST_HOST=127.0.0.1

# Paths
CHAINS_DIR=./chains
PIPELINES_DIR=./pipelines
WORKSPACE_DIR=.

# Execution
CLAUDE_CLI=claude
CLAUDE_TIMEOUT_MS=1800000
MAX_CONCURRENT_EXECUTIONS=5

# Storage
# OCC_DB=./occ.db
# OCC_QUEUE_DB=./occ-queue.db

# Security (uncomment for production)
# OCC_API_KEY=your-secret-key
# OCC_ENCRYPTION_KEY=generate-with-node-crypto

# Logging
LOG_LEVEL=info
`;

function cmdInit(projectName?: string) {
  const dir = projectName ? path.resolve(projectName) : process.cwd();

  if (projectName) {
    if (fs.existsSync(dir)) {
      console.error(`\x1b[31mError:\x1b[0m Directory "${projectName}" already exists`);
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create directories
  const chainsDir = path.join(dir, "chains");
  const pipelinesDir = path.join(dir, "pipelines");
  if (!fs.existsSync(chainsDir)) fs.mkdirSync(chainsDir, { recursive: true });
  if (!fs.existsSync(pipelinesDir)) fs.mkdirSync(pipelinesDir, { recursive: true });

  // Write .env
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, INIT_ENV);
  }

  // Write example chains
  let chainCount = 0;
  for (const [chainName, yaml] of Object.entries(EXAMPLE_CHAINS)) {
    const chainPath = path.join(chainsDir, `${chainName}.yaml`);
    if (!fs.existsSync(chainPath)) {
      fs.writeFileSync(chainPath, yaml);
      chainCount++;
    }
  }

  // Write .gitignore
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `*.db\n*.db-wal\n*.db-shm\nnode_modules/\n.env\n`);
  }

  console.log(`
\x1b[1m\x1b[32mOCC project initialized!\x1b[0m  ${projectName ? dir : "(current directory)"}

  \x1b[36mchains/\x1b[0m              ${chainCount} example chain(s)
  \x1b[36mpipelines/\x1b[0m           ready for multi-chain workflows
  \x1b[36m.env\x1b[0m                 server configuration
  \x1b[36m.gitignore\x1b[0m           ignores databases and .env

\x1b[1mNext steps:\x1b[0m
  ${projectName ? `cd ${projectName}\n  ` : ""}occ doctor             check prerequisites
  occ start              start the server
  occ run hello-world -i topic="quantum computing"
`);
}

// ─── occ start ─────────────────────────────────────────────────────────────

async function cmdStart() {
  // Find the rest.js entry point
  const candidates = [
    path.resolve("node_modules/occ-orchestrator/dist/rest.js"),      // npm global
    path.resolve("dist/rest.js"),                                     // from source (in mcp-server/)
    path.resolve("mcp-server/dist/rest.js"),                          // from source (in repo root)
    path.join(__dirname, "../rest.js"),                                // relative to bin
  ];

  let restPath: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { restPath = c; break; }
  }

  if (!restPath) {
    // Try to find via npm root
    try {
      const { execSync } = await import("node:child_process");
      const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
      const npmPath = path.join(npmRoot, "occ-orchestrator/dist/rest.js");
      if (fs.existsSync(npmPath)) restPath = npmPath;
    } catch {}
  }

  if (!restPath) {
    console.error(`\x1b[31mError:\x1b[0m Cannot find OCC server entry point.`);
    console.error(`\nIf installed from source, run from the mcp-server/ directory:`);
    console.error(`  cd mcp-server && npm run rest`);
    console.error(`\nIf installed via npm, make sure occ-orchestrator is installed:`);
    console.error(`  npm install -g occ-orchestrator`);
    process.exit(1);
  }

  console.log(`\x1b[1mStarting OCC server...\x1b[0m`);
  console.log(`\x1b[2m${restPath}\x1b[0m\n`);

  const { spawn } = await import("node:child_process");
  const child = spawn("node", [restPath], {
    stdio: "inherit",
    env: { ...process.env },
    cwd: process.cwd(),
  });

  child.on("error", (err) => {
    console.error(`\x1b[31mFailed to start server:\x1b[0m ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });

  // Forward signals
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ─── occ doctor ────────────────────────────────────────────────────────────

async function cmdDoctor() {
  const { execFileSync } = await import("node:child_process");

  console.log(`\x1b[1mOCC Doctor\x1b[0m\n`);

  const results: Array<{ label: string; ok: boolean; detail: string; fix?: string }> = [];

  // Node.js
  const nodeVer = process.version;
  const nodeMajor = parseInt(nodeVer.slice(1));
  results.push({
    label: "Node.js",
    ok: nodeMajor >= 20,
    detail: nodeVer,
    fix: nodeMajor < 20 ? "Install Node.js 20+: https://nodejs.org" : undefined,
  });

  // Claude CLI
  let claudeOk = false;
  let claudeDetail = "Not found";
  let claudeFix: string | undefined = "npm install -g @anthropic-ai/claude-code";
  try {
    const ver = execFileSync(process.env.CLAUDE_CLI ?? "claude", ["--version"], { timeout: 5000, encoding: "utf-8" }).trim().split("\n")[0];
    claudeOk = true;
    claudeDetail = ver;
    claudeFix = undefined;
  } catch {}
  results.push({ label: "Claude CLI", ok: claudeOk, detail: claudeDetail, fix: claudeFix });

  // Claude auth
  let authOk = false;
  let authDetail: string;
  let authFix: string | undefined = 'Run: claude  (opens browser)';
  if (claudeOk) {
    try {
      execFileSync(process.env.CLAUDE_CLI ?? "claude", ["-p", "hi", "--max-turns", "1", "--output-format", "json"], { timeout: 20000, encoding: "utf-8" });
      authOk = true;
      authDetail = "Authenticated";
      authFix = undefined;
    } catch (e) {
      const stderr = (e as { stderr?: { toString(): string } })?.stderr?.toString();
      authDetail = stderr?.slice(0, 80) || "Failed to verify";
    }
  } else {
    authDetail = "Install Claude CLI first";
  }
  results.push({ label: "Claude CLI auth", ok: authOk, detail: authDetail, fix: authFix });

  // Ollama
  let ollamaOk = false;
  let ollamaDetail = "Not running";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("http://localhost:11434/api/tags", { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    ollamaOk = true;
    ollamaDetail = `Running, ${models.length} model(s)${models.length > 0 ? ": " + models.map((m) => m.name).slice(0, 3).join(", ") : ""}`;
  } catch {}
  results.push({ label: "Ollama (optional)", ok: ollamaOk, detail: ollamaDetail, fix: ollamaOk ? undefined : "https://ollama.com/download" });

  // Docker
  let dockerOk = false;
  let dockerDetail = "Not found";
  try {
    const ver = execFileSync("docker", ["--version"], { timeout: 3000, encoding: "utf-8" }).trim().split("\n")[0];
    dockerOk = true;
    dockerDetail = ver;
  } catch {}
  results.push({ label: "Docker (optional)", ok: dockerOk, detail: dockerDetail, fix: dockerOk ? undefined : "https://docker.com/get-started" });

  // Chains directory
  const chainsDir = process.env.CHAINS_DIR ?? "./chains";
  let chainsOk = false;
  let chainsDetail = "Not found";
  try {
    const files = fs.readdirSync(chainsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    chainsOk = files.length > 0;
    chainsDetail = `${files.length} chain(s) in ${chainsDir}`;
  } catch {}
  results.push({ label: "Chains directory", ok: chainsOk, detail: chainsDetail, fix: chainsOk ? undefined : "Run: occ init" });

  // OCC Server
  let serverOk = false;
  let serverDetail = "Not running";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json() as { ok?: boolean; version?: string };
    serverOk = !!data.ok;
    serverDetail = `Running v${data.version ?? "?"}`;
  } catch {}
  results.push({ label: "OCC Server", ok: serverOk, detail: serverDetail, fix: serverOk ? undefined : "Run: occ start" });

  // Print results
  let allRequired = true;
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : (r.label.includes("optional") ? "\x1b[33m○\x1b[0m" : "\x1b[31m✗\x1b[0m");
    console.log(`  ${icon} \x1b[1m${r.label}\x1b[0m: ${r.detail}`);
    if (r.fix) console.log(`    \x1b[2m→ ${r.fix}\x1b[0m`);
    if (!r.ok && !r.label.includes("optional")) allRequired = false;
  }

  console.log();
  if (allRequired) {
    console.log(`\x1b[32mAll required checks passed!\x1b[0m`);
  } else {
    console.log(`\x1b[33mSome required checks failed. Fix them and run \x1b[1mocc doctor\x1b[0m\x1b[33m again.\x1b[0m`);
    process.exit(1);
  }
}

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
\x1b[1mOCC (Orchestrator Chain Chimera) CLI\x1b[0m

\x1b[1mUsage:\x1b[0m
  occ <command> [options]

\x1b[1mSetup:\x1b[0m
  init [name]                       Create a new OCC project with example chains
  start                             Start the OCC server
  doctor                            Check all prerequisites (Node, Claude CLI, Ollama...)

\x1b[1mChain execution:\x1b[0m
  run <chain> [--input k=v]         Execute a chain
  run-pipeline <name> [--input k=v] Execute a pipeline
  list                              List all chains and pipelines
  validate [path]                   Lint and validate all chains
  dry-run <chain> [--input k=v]     Preview execution plan (0 tokens)

\x1b[1mMonitoring:\x1b[0m
  status <executionId>              Check execution status
  logs <executionId>                Stream execution logs (SSE)
  cancel <executionId>              Cancel a running execution
  queue                             Show queue stats
  timeline <executionId>            Step checkpoint history
  stats <chainName>                 Execution stats for a chain

\x1b[1mHuman-in-the-loop:\x1b[0m
  approve <execId> <stepId>         Approve a gate step
  reject <execId> <stepId>          Reject a gate step

\x1b[1mGeneration:\x1b[0m
  generate "<description>"          Natural language to chain YAML
  generate-answer <id> "<answers>"  Continue chain generation

\x1b[1mSystem:\x1b[0m
  health                            Check server health

\x1b[1mFlags:\x1b[0m
  --input k=v, -i k=v              Chain input (repeatable)
  --priority N, -p N                Execution priority 1-10
  --json                            Output raw JSON

\x1b[1mQuick start:\x1b[0m
  occ init my-project && cd my-project
  occ doctor
  occ start
  occ run hello-world -i topic="quantum computing"

\x1b[1mEnvironment:\x1b[0m
  OCC_URL          Server URL (default: http://localhost:4242)
  CHAINS_DIR       Chains directory (default: ./chains)
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

// Strip --json from args for command parsing
const args = process.argv.slice(2).filter((a) => a !== "--json");
const command = args[0];

switch (command) {
  case "init":
    cmdInit(args[1]);
    break;
  case "start":
  case "serve":
  case "server":
    cmdStart();
    break;
  case "doctor":
  case "check":
    cmdDoctor();
    break;
  case "list":
  case "ls":
    cmdList();
    break;
  case "run":
  case "exec":
    if (!args[1]) { console.error("Usage: occ run <chain> [--input k=v]"); process.exit(1); }
    cmdRun(args[1], args.slice(2));
    break;
  case "run-pipeline":
  case "run-pipe":
    if (!args[1]) { console.error("Usage: occ run-pipeline <name> [--input k=v]"); process.exit(1); }
    cmdRunPipeline(args[1], args.slice(2));
    break;
  case "validate":
  case "lint":
    cmdValidate(args[1] || process.env.CHAINS_DIR || "");
    break;
  case "dry-run":
  case "dryrun":
  case "preview":
    if (!args[1]) { console.error("Usage: occ dry-run <chain> [--input k=v]"); process.exit(1); }
    cmdDryRun(args[1], args.slice(2));
    break;
  case "status":
    if (!args[1]) { console.error("Usage: occ status <executionId>"); process.exit(1); }
    cmdStatus(args[1]);
    break;
  case "logs":
  case "stream":
    if (!args[1]) { console.error("Usage: occ logs <executionId>"); process.exit(1); }
    cmdLogs(args[1]);
    break;
  case "cancel":
    if (!args[1]) { console.error("Usage: occ cancel <executionId>"); process.exit(1); }
    cmdCancel(args[1]);
    break;
  case "queue":
    cmdQueue();
    break;
  case "timeline":
    if (!args[1]) { console.error("Usage: occ timeline <executionId>"); process.exit(1); }
    cmdTimeline(args[1]);
    break;
  case "stats":
    if (!args[1]) { console.error("Usage: occ stats <chainName>"); process.exit(1); }
    cmdStats(args[1]);
    break;
  case "approve":
    if (!args[1] || !args[2]) { console.error("Usage: occ approve <executionId> <stepId>"); process.exit(1); }
    cmdApprove(args[1], args[2], true);
    break;
  case "reject":
    if (!args[1] || !args[2]) { console.error("Usage: occ reject <executionId> <stepId>"); process.exit(1); }
    cmdApprove(args[1], args[2], false);
    break;
  case "generate":
  case "gen":
    if (!args[1]) { console.error("Usage: occ generate \"<description>\""); process.exit(1); }
    cmdGenerate(args.slice(1).join(" "));
    break;
  case "generate-answer":
  case "gen-answer":
    if (!args[1] || !args[2]) { console.error("Usage: occ generate-answer <sessionId> \"<answers>\""); process.exit(1); }
    cmdGenerateAnswer(args[1], args.slice(2).join(" "));
    break;
  case "health":
  case "ping":
    cmdHealth();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
