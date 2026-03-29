import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type {
  CacheEntry,
  ChainDefinition,
  ChainExecution,
  ChainStep,
  ExecutionEvent,
  PreTool,
  StepResult,
} from "./types.js";
import { buildDependencyGraph } from "./loader.js";

// ─── In-memory execution store ────────────────────────────────────────────────

const executions = new Map<string, ChainExecution>();

// Map executionId → active ChildProcesses (for cancellation — supports parallel steps)
const activeProcesses = new Map<string, Set<ChildProcess>>();

// ─── Persistence ──────────────────────────────────────────────────────────────

function getExecutionsFile(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "executions.json");
  }
  return process.env.EXECUTIONS_FILE ?? path.join(os.tmpdir(), "occ-executions.json");
}

function persistExecutions(): void {
  try {
    const file = getExecutionsFile();
    const data = JSON.stringify([...executions.values()].slice(-200), null, 2);
    fs.writeFile(file, data, "utf-8", () => {}); // non-blocking, best-effort
  } catch { /* ignore */ }
}

export function loadPersistedExecutions(): void {
  try {
    const file = getExecutionsFile();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf-8");
    let data: ChainExecution[];
    try {
      data = JSON.parse(raw) as ChainExecution[];
    } catch (parseErr) {
      process.stderr.write(`[occ] WARNING: executions.json is corrupted, backing up and starting fresh\n`);
      fs.copyFileSync(file, file + ".backup." + Date.now());
      fs.writeFileSync(file, "[]", "utf-8");
      return;
    }
    // Fix orphaned running executions from previous crash
    for (const ex of data) {
      if (ex.status === "running") {
        ex.status = "error";
        ex.error = "Interrupted — server restarted";
        ex.finishedAt = new Date().toISOString();
      }
    }

    // Purge executions older than 7 days to prevent unbounded growth
    const maxAge = Number(process.env.EXECUTION_MAX_AGE_DAYS) || 7;
    const cutoff = Date.now() - maxAge * 86400000;
    let purged = 0;
    for (const ex of data) {
      const ts = new Date(ex.startedAt).getTime();
      if (ts >= cutoff) {
        executions.set(ex.id, ex);
      } else {
        purged++;
      }
    }
    process.stderr.write(`[occ] Loaded ${executions.size} persisted executions${purged ? ` (purged ${purged} older than ${maxAge}d)` : ""}\n`);
  } catch (err) {
    process.stderr.write(`[occ] WARNING: Failed to load executions: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export function getExecution(id: string): ChainExecution | undefined {
  return executions.get(id);
}

export function getAllExecutions(): ChainExecution[] {
  return [...executions.values()].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt)
  );
}

/** Trim in-memory executions map to prevent unbounded growth. */
function trimExecutions(): void {
  if (executions.size > 250) {
    const sorted = [...executions.entries()].sort(
      (a, b) => a[1].startedAt.localeCompare(b[1].startedAt)
    );
    const toRemove = sorted.slice(0, sorted.length - 200);
    for (const [key] of toRemove) {
      executions.delete(key);
    }
  }
}

// ─── Step-level caching ──────────────────────────────────────────────────────

function getCacheDir(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.resolve(chainsDir, "..", "cache");
  }
  return path.join(os.tmpdir(), "occ-cache");
}

function createCacheKey(stepId: string, resolvedPrompt: string, model?: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(stepId);
  hash.update(resolvedPrompt);
  hash.update(model ?? "");
  return hash.digest("hex");
}

function loadCache(chainName: string, cacheKey: string, ttlMinutes: number): CacheEntry | null {
  try {
    const cacheDir = getCacheDir();
    const cacheFile = path.join(cacheDir, chainName, `${cacheKey}.json`);
    if (!fs.existsSync(cacheFile)) return null;
    const raw = fs.readFileSync(cacheFile, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;
    const age = (Date.now() - new Date(entry.createdAt).getTime()) / 60000;
    if (age > ttlMinutes) {
      // Expired — remove cache file
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function saveCache(chainName: string, entry: CacheEntry): void {
  try {
    const cacheDir = path.join(getCacheDir(), chainName);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `${entry.key}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

// ─── Output validation (guardrails) ─────────────────────────────────────────

function validateOutput(
  output: string,
  step: ChainStep,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): string[] {
  const errors: string[] = [];

  // Check guardrails
  if (step.guardrails) {
    for (const guard of step.guardrails) {
      switch (guard.type) {
        case "max_length":
          if (output.length > (guard.value as number)) errors.push(`Output exceeds max length ${guard.value}`);
          break;
        case "min_length":
          if (output.length < (guard.value as number)) errors.push(`Output below min length ${guard.value}`);
          break;
        case "must_contain":
          if (!output.includes(guard.value as string)) errors.push(`Output missing required: "${guard.value}"`);
          break;
        case "must_not_contain":
          if (output.includes(guard.value as string)) errors.push(`Output contains forbidden: "${guard.value}"`);
          break;
        case "regex_match":
          if (!new RegExp(guard.value as string).test(output)) errors.push(`Output doesn't match regex: ${guard.value}`);
          break;
        case "json_valid":
          try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
          break;
      }
    }
  }

  // Check legacy fields
  if (step.output_must_contain) {
    for (const s of step.output_must_contain) {
      if (!output.includes(s)) errors.push(`Missing required string: "${s}"`);
    }
  }
  if (step.output_must_not_contain) {
    for (const s of step.output_must_not_contain) {
      if (output.includes(s)) errors.push(`Contains forbidden string: "${s}"`);
    }
  }
  if (step.output_max_length && output.length > step.output_max_length) {
    errors.push(`Output ${output.length} chars exceeds max ${step.output_max_length}`);
  }
  if (step.output_schema === "json") {
    try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
  }

  return errors;
}

// ─── Execution cancellation ───────────────────────────────────────────────────

export function cancelExecution(id: string): boolean {
  const children = activeProcesses.get(id);
  if (!children || children.size === 0) {
    // Still allow cancelling the execution record even if no active processes
    const execution = executions.get(id);
    if (!execution || execution.status !== "running") return false;
  }

  // Kill all active child processes for this execution (handles parallel steps)
  if (children) {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
        // Force kill after 3s if still alive
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] kill SIGKILL failed: ${e}\n`); }
        }, 3000);
      } catch (e) { process.stderr.write(`[occ] kill SIGTERM failed: ${e}\n`); }
    }
  }

  const execution = executions.get(id);
  if (execution && execution.status === "running") {
    execution.status = "error";
    execution.error = "Cancelled by user";
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(execution.startedAt).getTime();
    for (const step of Object.values(execution.steps)) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "skipped";
      }
    }
    persistExecutions();
  }
  activeProcesses.delete(id);
  return true;
}

// ─── Variable resolution ──────────────────────────────────────────────────────

function resolveVariables(
  template: string,
  vars: Record<string, string>
): string {
  // Supports: {key}, {key|"fallback"}, {key|fallback}, {input.key}
  return template.replace(
    /\{(\w+)(?:\.(\w+))?(?:\|"?([^"}\s]*)"?)?\}/g,
    (_match, key: string, subkey: string | undefined, fallback: string | undefined) => {
      // Try {key.subkey} first (e.g. {input.topic})
      if (subkey) {
        const compound = `${key}.${subkey}`;
        if (vars[compound] !== undefined) return vars[compound];
      }
      if (vars[key] !== undefined) return vars[key];
      if (fallback !== undefined && fallback !== "") return fallback;
      return _match; // keep original if no match
    }
  );
}

// ─── Pre-tool executor ────────────────────────────────────────────────────────

async function executePreTools(
  preTools: PreTool[],
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const tool of preTools) {
    try {
      let result = "";
      switch (tool.type) {
        case "current_datetime":
          result = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "medium" });
          break;
        case "http_fetch": {
          const url = resolveVariables(tool.url ?? "", vars);
          const resp = await fetch(url);
          result = await resp.text();
          if (result.length > 50000) {
            result = result.slice(0, 50000) + "\n[truncated]";
            onLog(`http_fetch truncated to 50KB for ${url}`, "warn");
          }
          break;
        }
        case "web_search": {
          const query = resolveVariables(tool.query ?? "", vars);
          const searchPrompt = `Search the web for: ${query}\n\nProvide a comprehensive summary of the most relevant and recent results. Include key facts, numbers, dates, and sources.`;
          const { stdout } = await runClaude(searchPrompt, { id: "_search", output_var: "_", tools: ["WebSearch"], model: "claude-haiku-4-5", prompt: "" } as ChainStep, () => {});
          result = stdout;
          break;
        }
        case "read_file": {
          const filePath = resolveVariables(tool.path ?? "", vars);
          result = fs.readFileSync(filePath, "utf-8");
          if (result.length > 50000) {
            result = result.slice(0, 50000) + "\n[truncated]";
            onLog(`read_file truncated to 50KB for ${filePath}`, "warn");
          }
          break;
        }
        case "write_file": {
          const filePath = resolveVariables(tool.path ?? "", vars);
          const fileContent = resolveVariables(tool.content ?? "", vars);
          const dir = filePath.substring(0, filePath.lastIndexOf("/"));
          if (dir) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, fileContent, "utf-8");
          result = filePath;
          onLog(`write_file → ${filePath} (${fileContent.length} chars)`, "info");
          break;
        }
        case "bash": {
          // SECURITY NOTE: Variables are intentionally injected into shell commands
          // without escaping. Chain authors control the commands and variable content.
          // This is by design — chains are trusted user-authored automation scripts.
          const command = resolveVariables(tool.command ?? "", vars);
          result = execSync(command, { timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
          break;
        }
        case "env_var":
          result = process.env[tool.var_name ?? ""] ?? "";
          break;
      }
      results[tool.inject_as] = result;
      onLog(`pre-tool ${tool.type} → {${tool.inject_as}} (${result.length} chars)`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[tool.inject_as] = `[PRE-TOOL ERROR: ${message}]`;
      onLog(`pre-tool ${tool.type} failed: ${message}`, "error");
    }
  }
  return results;
}

// ─── claude -p invocation ─────────────────────────────────────────────────────

interface ClaudeResult {
  stdout: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min default
const MAX_OUTPUT = 5_000_000; // 5MB max output size to prevent unbounded memory growth
const MAX_CONCURRENT_EXECUTIONS = Number(process.env.MAX_CONCURRENT_EXECUTIONS) || 5;

// ─── Claude binary validation (once at startup, not per step) ────────────────

let claudeBinValidated = false;
let claudeBinPath = "";

export function validateClaudeBinary(): void {
  const claudeBin = process.env.CLAUDE_BIN ?? "claude";
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${whichCmd} "${claudeBin}"`, { encoding: "utf-8", timeout: 5000 });
    claudeBinPath = claudeBin;
    claudeBinValidated = true;
    process.stderr.write(`[occ] Claude binary verified: ${claudeBin}\n`);
  } catch {
    process.stderr.write(`[occ] WARNING: Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_BIN env var.\n`);
    claudeBinPath = claudeBin; // still set so error is clear if used
  }
}

// ─── Concurrent execution tracking ──────────────────────────────────────────

let runningExecutionCount = 0;

export function getRunningExecutionCount(): number {
  return runningExecutionCount;
}

export function canStartExecution(): boolean {
  return runningExecutionCount < MAX_CONCURRENT_EXECUTIONS;
}

function runClaude(
  prompt: string,
  step: ChainStep,
  onChunk: (chunk: string) => void,
  executionId?: string,
  timeoutMs?: number
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
    ];

    if (step.model) {
      args.push("--model", step.model);
    }

    if (step.tools && step.tools.length > 0) {
      args.push("--allowedTools", ...step.tools);
    }

    // Always use stdin when tools are present (prompt after --allowedTools args is ambiguous)
    const USE_STDIN = prompt.length > 65536 || (step.tools && step.tools.length > 0);
    if (!USE_STDIN) args.push(prompt);

    const claudeBin = claudeBinPath || process.env.CLAUDE_BIN || "claude";
    if (!claudeBinValidated) {
      // Fallback: validate once if startup check was skipped
      const whichCmd = process.platform === "win32" ? "where" : "which";
      try {
        execSync(`${whichCmd} "${claudeBin}"`, { encoding: "utf-8", timeout: 5000 });
        claudeBinValidated = true;
        claudeBinPath = claudeBin;
      } catch {
        reject(new Error(`Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_BIN env var to the full path.`));
        return;
      }
    }
    const cwd = step.cwd ?? process.env.WORKSPACE_DIR ?? process.cwd();

    const child = spawn(claudeBin, args, {
      cwd,
      env: {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: [USE_STDIN ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Timeout: kill process if it runs too long
    const effectiveTimeout = timeoutMs ?? CLAUDE_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGTERM failed: ${e}\n`); }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGKILL failed: ${e}\n`); } }, 3000);
        if (executionId) { activeProcesses.get(executionId)?.delete(child); }
        reject(new Error(`claude timed out after ${effectiveTimeout / 1000}s for step "${step.id}"`));
      }
    }, effectiveTimeout);

    // Heartbeat: detect silently dead processes (check every 30s)
    const heartbeat = setInterval(() => {
      if (settled) { clearInterval(heartbeat); return; }
      try {
        // kill(0) checks if process exists without actually killing it
        process.kill(child.pid!, 0);
      } catch {
        // Process is dead but 'close' event never fired
        clearInterval(heartbeat);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          if (executionId) { activeProcesses.get(executionId)?.delete(child); }
          const durationMs = Date.now() - startTime;
          if (fullText.trim()) {
            resolve({ stdout: fullText.trim(), durationMs, inputTokens, outputTokens });
          } else {
            reject(new Error(`claude process died silently (pid ${child.pid}) for step "${step.id}" after ${(durationMs / 1000).toFixed(0)}s`));
          }
        }
      }
    }, 30000);

    // Register for cancellation (supports multiple parallel processes per execution)
    if (executionId) {
      if (!activeProcesses.has(executionId)) activeProcesses.set(executionId, new Set());
      activeProcesses.get(executionId)!.add(child);
    }

    if (USE_STDIN) {
      child.stdin!.write(prompt, "utf-8");
      child.stdin!.end();
    }

    let lineBuffer = "";
    let fullText = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text: string = event.delta.text ?? "";
            if (text) {
              if (fullText.length < MAX_OUTPUT) { fullText += text; }
              onChunk(text);
            }
          } else if (event.type === "assistant" && event.message?.content) {
            // Tool-using steps emit "assistant" events with text blocks
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const text = block.text as string;
                  if (fullText.length < MAX_OUTPUT) { fullText += text; }
                  onChunk(text);
                }
              }
            }
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = (event.message.usage.output_tokens ?? 0) + (outputTokens ?? 0);
            }
          } else if (event.type === "result") {
            if (event.usage) {
              inputTokens = event.usage.input_tokens;
              outputTokens = event.usage.output_tokens;
            }
            // Use result as authoritative final text
            if (event.result) {
              const resultText = event.result as string;
              if (resultText.length > fullText.length) {
                const diff = resultText.slice(fullText.length);
                if (diff) onChunk(diff);
                fullText = resultText;
              }
            }
          } else if (event.type === "message_delta" && event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens;
          } else if (event.type === "message" && event.message?.content) {
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const text = block.text as string;
                  if (fullText.length < MAX_OUTPUT) { fullText += text; }
                  onChunk(text);
                }
              }
            }
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = event.message.usage.output_tokens;
            }
          }
        } catch {
          // Non-JSON line — treat as raw text (fallback for old CLI versions)
          if (line.trim() && !fullText && fullText.length < MAX_OUTPUT) {
            fullText += line + "\n";
            onChunk(line + "\n");
          }
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      if (executionId) { activeProcesses.get(executionId)?.delete(child); }
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      if (executionId) { activeProcesses.get(executionId)?.delete(child); }

      // Handle remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === "result") {
            if (event.usage) {
              inputTokens = event.usage.input_tokens;
              outputTokens = event.usage.output_tokens;
            }
            if (event.result) {
              const resultText = event.result as string;
              if (resultText.length > fullText.length) {
                fullText = resultText;
              }
            }
          }
        } catch { /* ignore */ }
      }

      const durationMs = Date.now() - startTime;
      if (code === 0 || (code !== null && fullText)) {
        resolve({ stdout: fullText.trim(), durationMs, inputTokens, outputTokens });
      } else {
        reject(
          new Error(
            `claude exited with code ${code}${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""}`
          )
        );
      }
    });
  });
}

// ─── Condition evaluator ──────────────────────────────────────────────────────

function evaluateCondition(expr: string): boolean {
  // Supported: 'a == "b"', 'a != "b"', 'a contains "b"', 'a != ""', boolean-like
  const trimmed = expr.trim();

  // equality: left == "right"
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*"([^"]*)"$/);
  if (eqMatch) return eqMatch[1].trim() === eqMatch[2];

  // inequality: left != "right"
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*"([^"]*)"$/);
  if (neqMatch) return neqMatch[1].trim() !== neqMatch[2];

  // contains: left contains "right"
  const containsMatch = trimmed.match(/^(.+?)\s+contains\s+"([^"]*)"$/);
  if (containsMatch) return containsMatch[1].trim().includes(containsMatch[2]);

  // numeric: left > N, left < N
  const gtMatch = trimmed.match(/^(.+?)\s*>\s*(\d+)$/);
  if (gtMatch) return Number(gtMatch[1].trim()) > Number(gtMatch[2]);

  const ltMatch = trimmed.match(/^(.+?)\s*<\s*(\d+)$/);
  if (ltMatch) return Number(ltMatch[1].trim()) < Number(ltMatch[2]);

  // truthy: non-empty string = true
  return trimmed !== "" && trimmed !== "false" && trimmed !== "0";
}

// ─── Retry with exponential backoff + model fallback ─────────────────────────

async function runStepWithRetry(
  step: ChainStep,
  resolvedPrompt: string,
  onChunk: (chunk: string) => void,
  executionId: string,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): Promise<ClaudeResult> {
  const maxAttempts = step.retry?.max ?? 1;
  const delayMs = step.retry?.delay_ms ?? 2000;
  const backoff = step.retry?.backoff ?? 2;
  const models = step.fallback_models ?? (step.model ? [step.model] : []);

  let lastError: Error | null = null;

  for (const model of models.length > 0 ? models : [undefined]) {
    const stepWithModel = model ? { ...step, model } : step;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1 || (model && model !== (step.model ?? models[0]))) {
          onLog(`Attempt ${attempt}${model ? ` with ${model}` : ''}`, "warn");
        }
        return await runClaude(resolvedPrompt, stepWithModel, onChunk, executionId, step.timeout_ms);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        onLog(`Attempt ${attempt}${model ? ` (${model})` : ''} failed: ${lastError.message}`, "error");

        if (attempt < maxAttempts) {
          const waitMs = delayMs * Math.pow(backoff, attempt - 1) * (0.5 + Math.random() * 0.5);
          onLog(`Retrying in ${Math.round(waitMs)}ms...`, "info");
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }
  }

  throw lastError ?? new Error("All retry attempts exhausted");
}

// ─── Gate approval mechanism ─────────────────────────────────────────────────

const pendingApprovals = new Map<string, { resolve: (value: string) => void }>();

export function getPendingApprovals(): Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> {
  const results: Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> = [];
  for (const key of pendingApprovals.keys()) {
    const [executionId, stepId] = key.split(":");
    const execution = executions.get(executionId);
    if (execution) {
      const step = execution.steps[stepId];
      results.push({
        executionId,
        stepId,
        chainName: execution.chainName,
        prompt: step?.output ?? "",
        startedAt: step?.startedAt ?? execution.startedAt,
      });
    }
  }
  return results;
}

export function approveGate(executionId: string, stepId: string, approved: boolean): boolean {
  const key = `${executionId}:${stepId}`;
  const pending = pendingApprovals.get(key);
  if (!pending) return false;
  pending.resolve(approved ? "approved" : "rejected");
  pendingApprovals.delete(key);
  return true;
}

function waitForApproval(
  executionId: string,
  stepId: string,
  timeoutHours: number,
  onTimeout: "skip" | "error" | "approve"
): Promise<string> {
  return new Promise((resolve) => {
    const key = `${executionId}:${stepId}`;
    pendingApprovals.set(key, { resolve });

    // Timeout
    setTimeout(() => {
      if (pendingApprovals.has(key)) {
        pendingApprovals.delete(key);
        if (onTimeout === "approve") resolve("approved");
        else if (onTimeout === "skip") resolve("skipped");
        else resolve("rejected");
      }
    }, timeoutHours * 60 * 60 * 1000);
  });
}

// ─── Context compression ─────────────────────────────────────────────────────

async function applyContextStrategy(
  vars: Record<string, string>,
  strategy: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): Promise<Record<string, string>> {
  const result = { ...vars };

  for (const [varName, action] of Object.entries(strategy)) {
    const value = vars[varName];
    if (!value) continue;

    if (action === "full") {
      // No change
      continue;
    }

    if (action === "summarize") {
      // Use Haiku to summarize
      try {
        const summaryPrompt = `Summarize the following content concisely, preserving all key technical details, decisions, and important information:\n\n${value}`;
        const { stdout } = await runClaude(
          summaryPrompt,
          { id: "_summarize", output_var: "_", tools: [], model: "claude-haiku-4-5", prompt: "" } as ChainStep,
          () => {}
        );
        result[varName] = stdout;
        onLog(`Context compressed ${varName}: ${value.length} → ${stdout.length} chars (summarize)`, "info");
      } catch (err) {
        onLog(`Failed to summarize ${varName}: ${err instanceof Error ? err.message : String(err)}`, "warn");
        // Keep original on failure
      }
      continue;
    }

    // truncate:N
    const truncateMatch = action.match(/^truncate:(\d+)$/);
    if (truncateMatch) {
      const limit = parseInt(truncateMatch[1], 10);
      if (value.length > limit) {
        result[varName] = value.slice(0, limit) + "\n[truncated from " + value.length + " chars]";
        onLog(`Context compressed ${varName}: ${value.length} → ${limit} chars (truncate)`, "info");
      }
      continue;
    }
  }

  return result;
}

// ─── Chain executor ───────────────────────────────────────────────────────────

type EventEmitter = (event: ExecutionEvent) => void;

// ─── Shared step dispatch (used by both executeChain and resumeExecution) ────

async function executeStep(
  step: ChainStep,
  chain: ChainDefinition,
  vars: Record<string, string>,
  execution: ChainExecution,
  executionId: string,
  emit: EventEmitter
): Promise<void> {
  const stepId = step.id;
  const stepResult = execution.steps[stepId];

  const onLog = (message: string, level: "info" | "warn" | "error") => {
    emit({ type: "step_log", executionId, stepId, message, level });
  };

  // Early exit check
  if (step.early_exit_if) {
    const resolved = resolveVariables(step.early_exit_if, vars);
    if (evaluateCondition(resolved)) {
      onLog("Early exit triggered", "info");
      stepResult.status = "skipped";
      stepResult.finishedAt = new Date().toISOString();
      vars[step.output_var] = vars[chain.output] ?? "";
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });

      // Signal early exit by setting a special var
      vars["__early_exit"] = "true";
      persistExecutions();
      return;
    }
  }

  // Check condition
  if (step.condition) {
    const resolved = resolveVariables(step.condition, vars);
    if (!evaluateCondition(resolved)) {
      stepResult.status = "skipped";
      stepResult.finishedAt = new Date().toISOString();
      vars[step.output_var] = "";
      emit({ type: "step_log", executionId, stepId, message: `Condition not met: ${step.condition}`, level: "info" });
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      persistExecutions();
      return;
    }
  }

  // Check step-level cache before any execution
  if (step.cache?.enabled) {
    const resolvedForCache = resolveVariables(step.prompt, vars);
    const cacheKey = createCacheKey(step.id, resolvedForCache, step.model);
    const cached = loadCache(chain.name, cacheKey, step.cache.ttl_minutes ?? 60);
    if (cached) {
      stepResult.status = "done";
      stepResult.output = cached.result;
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = 0;
      stepResult.inputTokens = cached.inputTokens;
      stepResult.outputTokens = cached.outputTokens;
      vars[step.output_var] = cached.result;
      emit({ type: "step_cache_hit", executionId, stepId: step.id });
      emit({ type: "step_done", executionId, stepId: step.id, durationMs: 0 });
      persistExecutions();
      return;
    }
  }

  // Dispatch by step type
  const stepType = step.type ?? "agent";

  if (stepType === "router") {
    // Router: use Claude to classify, then mark non-selected branches as skipped
    const resolvedPrompt = resolveVariables(step.prompt, vars);
    const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
      { ...step, model: step.model ?? "claude-haiku-4-5" }, // cheap model for routing
      resolvedPrompt,
      (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
      executionId,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );

    // Find matching route
    // Try exact match first, then check if output contains any route key
    let routeKey = stdout.trim().toLowerCase();
    const routes = step.routes ?? {};
    const routeKeys = Object.keys(routes);

    // Handle empty LLM output
    if (!routeKey) {
      emit({ type: "step_log", executionId, stepId, message: "Router returned empty output", level: "warn" });
      if (step.default_route && routes[step.default_route]) {
        routeKey = step.default_route;
        emit({ type: "step_log", executionId, stepId, message: `Using default route: ${routeKey}`, level: "info" });
      }
    }

    // If no exact match, search for a route key within the output
    if (!routes[routeKey]) {
      const found = routeKeys.find(k => routeKey.includes(k.toLowerCase()));
      if (found) {
        emit({ type: "step_log", executionId, stepId, message: `Router: no exact match for "${routeKey}", found key "${found}" in output`, level: "info" });
        routeKey = found;
      } else if (step.default_route && routes[step.default_route]) {
        emit({ type: "step_log", executionId, stepId, message: `Router: no match for "${routeKey}", falling back to default route "${step.default_route}"`, level: "warn" });
        routeKey = step.default_route;
      } else {
        emit({ type: "step_log", executionId, stepId, message: `Router: no match for "${routeKey}" and no default route`, level: "warn" });
      }
    }
    const selectedSteps = routes[routeKey] ?? [];

    // Mark all steps NOT in the selected route as skipped
    const allRouteSteps = new Set(Object.values(routes).flat());
    for (const routeStepId of allRouteSteps) {
      if (!selectedSteps.includes(routeStepId)) {
        const rs = execution.steps[routeStepId];
        if (rs && rs.status === "pending") {
          rs.status = "skipped";
          emit({ type: "step_log", executionId, stepId: routeStepId, message: `Skipped by router (route: ${routeKey})`, level: "info" });
        }
      }
    }

    stepResult.status = "done";
    stepResult.output = routeKey;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = durationMs;
    stepResult.inputTokens = inputTokens;
    stepResult.outputTokens = outputTokens;
    vars[step.output_var] = routeKey;

    // Save router result to cache if enabled
    if (step.cache?.enabled) {
      const cacheKey = createCacheKey(step.id, resolvedPrompt, step.model);
      saveCache(chain.name, {
        key: cacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: routeKey,
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens,
        outputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
    emit({ type: "step_log", executionId, stepId, message: `Routed to: ${routeKey} → [${selectedSteps.join(", ")}]`, level: "info" });
    persistExecutions();
    return;
  }

  if (stepType === "transform") {
    // Transform: no LLM call, pure data transformation
    const transformInputVar = step.input_var ?? "";
    if (transformInputVar && !(transformInputVar in vars)) {
      emit({ type: "step_log", executionId, stepId, message: `Warning: input_var "${transformInputVar}" not found in variables`, level: "warn" });
    }
    const inputVal = vars[transformInputVar] ?? resolveVariables(step.prompt, vars);
    let result = "";

    switch (step.operation) {
      case "json_extract": {
        try {
          const parsed = JSON.parse(inputVal);
          // Simple dot-path extraction (e.g., "results.0.name")
          const path = step.json_path ?? "";
          const parts = path.replace(/^\$\.?/, "").split(".");
          let current: unknown = parsed;
          for (const part of parts) {
            if (current == null) break;
            if (part === "*" && Array.isArray(current)) {
              // Apply remaining path parts to each array element
              const remainingParts = parts.slice(parts.indexOf(part) + 1);
              if (remainingParts.length === 0) break;
              current = current.map(item => {
                let val: unknown = item;
                for (const rp of remainingParts) {
                  if (val == null) break;
                  val = (val as Record<string, unknown>)[rp];
                }
                return val;
              });
              break; // remaining parts already applied
            }
            current = (current as Record<string, unknown>)[part];
          }
          result = typeof current === "string" ? current : JSON.stringify(current, null, 2);
        } catch (e) {
          result = `[JSON parse error: ${e instanceof Error ? e.message : 'invalid JSON'}]`;
          emit({ type: "step_log", executionId, stepId, message: `json_extract failed: input is not valid JSON`, level: "warn" });
        }
        break;
      }
      case "regex_match": {
        const regex = new RegExp(step.regex ?? "", "g");
        const matches = inputVal.match(regex);
        result = matches ? matches.join("\n") : "";
        break;
      }
      case "template": {
        result = resolveVariables(step.template_str ?? "", vars);
        break;
      }
      case "split": {
        // Split into JSON array (by newlines)
        result = JSON.stringify(inputVal.split("\n").filter(Boolean));
        break;
      }
      case "merge": {
        // Merge multiple variables
        const mergeInputs = step.inputs ?? [];
        const parts = mergeInputs.map(v => vars[v] ?? "").filter(Boolean);
        result = parts.join("\n\n---\n\n");
        break;
      }
      case "truncate": {
        const limit = step.truncate_limit ?? parseInt(step.template_str ?? step.json_path ?? "5000", 10);
        result = inputVal.length > limit ? inputVal.slice(0, limit) + `\n[truncated from ${inputVal.length} chars]` : inputVal;
        break;
      }
      case "replace": {
        // Replace using regex or string
        const pattern = step.regex ?? "";
        const replacement = step.template_str ?? "";
        if (pattern) {
          result = inputVal.replace(new RegExp(pattern, "g"), replacement);
        } else {
          result = inputVal;
        }
        break;
      }
      case "filter": {
        // Filter lines matching regex
        const regex = new RegExp(step.regex ?? ".*");
        result = inputVal.split("\n").filter(line => regex.test(line)).join("\n");
        break;
      }
      case "map": {
        // Apply template to each line
        const template = step.template_str ?? "{item}";
        result = inputVal.split("\n").filter(Boolean).map((line, i) => {
          return template.replace(/\{item\}/g, line).replace(/\{index\}/g, String(i));
        }).join("\n");
        break;
      }
      case "join": {
        // Join array items with separator
        const separator = step.template_str ?? "\n";
        try {
          const arr = JSON.parse(inputVal);
          result = Array.isArray(arr) ? arr.join(separator) : inputVal;
        } catch {
          result = inputVal;
        }
        break;
      }
      case "to_json": {
        // Parse lines into JSON array
        result = JSON.stringify(inputVal.split("\n").filter(Boolean));
        break;
      }
      case "from_json": {
        // Convert JSON to readable text
        try {
          const parsed = JSON.parse(inputVal);
          if (Array.isArray(parsed)) {
            result = parsed.map(String).join("\n");
          } else if (typeof parsed === "object") {
            result = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join("\n");
          } else {
            result = String(parsed);
          }
        } catch {
          result = inputVal;
        }
        break;
      }
      default:
        result = inputVal;
    }

    stepResult.status = "done";
    stepResult.output = result;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = 0;
    vars[step.output_var] = result;

    emit({ type: "step_output", executionId, stepId, chunk: result });
    emit({ type: "step_done", executionId, stepId, durationMs: 0 });
    emit({ type: "step_log", executionId, stepId, message: `Transform ${step.operation}: ${result.length} chars`, level: "info" });
    persistExecutions();
    return;
  }

  if (stepType === "evaluator") {
    // Evaluator: check input against criteria, optionally retry target step
    let passed = false;
    let evalOutput = "";
    let evalDuration = 0;
    let evalInputTokens: number | undefined;
    let evalOutputTokens: number | undefined;
    const maxRetries = step.max_retries ?? 2;
    const retryKey = `__retry_count_${step.retry_target ?? step.id}`;

    for (let evalAttempt = 0; evalAttempt <= maxRetries; evalAttempt++) {
      // Run evaluation
      const inputVal = vars[step.input_var ?? ""] ?? "";
      const criteriaPrompt = step.eval_scoring
        ? `Rate this output 1-10 based on the criteria. Reply with ONLY a number (1-10) on the first line, then a brief explanation.\n\nCriteria:\n${step.criteria ?? ""}\n\nOutput:\n${inputVal}`
        : `Evaluate this output against the following criteria. Reply ONLY with "PASS" or "FAIL" followed by a brief explanation.\n\nCriteria:\n${step.criteria ?? ""}\n\nOutput to evaluate:\n${inputVal}`;

      const evalResult = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5", tools: [] },
        criteriaPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );

      evalOutput = evalResult.stdout;
      evalDuration += evalResult.durationMs;
      evalInputTokens = evalResult.inputTokens;
      evalOutputTokens = evalResult.outputTokens;

      if (step.eval_scoring) {
        const scoreMatch = evalOutput.match(/^(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
        passed = score >= (step.eval_threshold ?? 7);
        onLog(`Evaluation score: ${score}/10 (threshold: ${step.eval_threshold ?? 7})`, passed ? "info" : "warn");
      } else {
        passed = evalOutput.trim().toUpperCase().startsWith("PASS");
      }

      if (passed || step.on_fail !== "retry" || !step.retry_target || evalAttempt >= maxRetries) {
        break;
      }

      // Re-run target step with feedback
      const targetStep = chain.steps.find(s => s.id === step.retry_target);
      if (!targetStep) break;

      const retryCount = parseInt(vars[retryKey] ?? "0", 10);
      vars[retryKey] = String(retryCount + 1);
      emit({ type: "step_log", executionId, stepId, message: `Evaluation FAILED (attempt ${evalAttempt + 1}/${maxRetries}). Re-running ${step.retry_target}...`, level: "warn" });

      // Re-run the target step
      const targetResult = execution.steps[step.retry_target!];
      targetResult.status = "running";
      targetResult.startedAt = new Date().toISOString();
      emit({ type: "step_started", executionId, stepId: step.retry_target!, label: targetStep.label ?? targetStep.id });

      const retryPrompt = resolveVariables(targetStep.prompt + `\n\n[Previous attempt failed evaluation: ${evalOutput}]\nPlease fix the issues and try again.`, vars);
      const retryResult = await runStepWithRetry(
        targetStep, retryPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId: step.retry_target!, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId: step.retry_target!, message, level }); }
      );

      targetResult.status = "done";
      targetResult.output = retryResult.stdout;
      targetResult.finishedAt = new Date().toISOString();
      targetResult.durationMs = retryResult.durationMs;
      vars[targetStep.output_var] = retryResult.stdout;
      emit({ type: "step_done", executionId, stepId: step.retry_target!, durationMs: retryResult.durationMs });

      emit({ type: "step_log", executionId, stepId, message: `Re-evaluating after retry ${evalAttempt + 1}...`, level: "info" });
    }

    stepResult.status = "done";
    stepResult.output = evalOutput;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = evalDuration;
    stepResult.inputTokens = evalInputTokens;
    stepResult.outputTokens = evalOutputTokens;
    vars[step.output_var] = passed ? "PASS" : "FAIL";

    // Output validation (guardrails) for evaluator
    const evalValidationErrors = validateOutput(evalOutput, step, (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    });
    if (evalValidationErrors.length > 0) {
      for (const err of evalValidationErrors) {
        emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
      }
    }

    // Save evaluator result to cache if enabled
    if (step.cache?.enabled) {
      const evalCacheKey = createCacheKey(step.id, vars[step.input_var ?? ""] ?? "", step.model);
      saveCache(chain.name, {
        key: evalCacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: passed ? "PASS" : "FAIL",
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens: evalInputTokens,
        outputTokens: evalOutputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs: evalDuration, inputTokens: evalInputTokens, outputTokens: evalOutputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "gate") {
    // Check auto-approve condition
    if (step.gate_auto_approve_if) {
      const resolvedCondition = resolveVariables(step.gate_auto_approve_if, vars);
      if (evaluateCondition(resolvedCondition)) {
        onLog("Auto-approved: condition met", "info");
        stepResult.status = "done";
        stepResult.output = "auto-approved";
        stepResult.finishedAt = new Date().toISOString();
        stepResult.durationMs = 0;
        vars[step.output_var] = "approved";
        emit({ type: "step_done", executionId, stepId, durationMs: 0 });
        persistExecutions();
        return;
      }
    }

    // Gate: pause for human approval
    const resolvedPrompt = resolveVariables(step.prompt, vars);
    emit({ type: "step_waiting_approval", executionId, stepId, prompt: resolvedPrompt });
    emit({ type: "step_log", executionId, stepId, message: "Waiting for human approval...", level: "info" });

    // Wait for approval via a promise stored in a map
    const gateStartTime = Date.now();
    const approved = await waitForApproval(executionId, stepId, step.timeout_hours ?? 24, step.on_timeout ?? "error");
    // Safety: always clean up pendingApprovals after resolution (approval or timeout)
    pendingApprovals.delete(`${executionId}:${stepId}`);
    const gateDuration = Date.now() - gateStartTime;

    if (approved === "approved") {
      stepResult.status = "done";
      stepResult.output = "approved";
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = gateDuration;
      vars[step.output_var] = "approved";
      emit({ type: "step_done", executionId, stepId, durationMs: gateDuration });
    } else if (approved === "skipped") {
      stepResult.status = "skipped";
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = gateDuration;
      vars[step.output_var] = "";
      emit({ type: "step_done", executionId, stepId, durationMs: gateDuration });
    } else {
      throw new Error("Gate rejected by user");
    }
    persistExecutions();
    return;
  }

  if (stepType === "merge") {
    // Merge: combine multiple inputs
    const mergeStartTime = Date.now();
    const mergeInputs = step.inputs ?? [];
    const strategy = step.strategy ?? "concatenate";
    let result = "";

    if (strategy === "concatenate") {
      result = mergeInputs.map(v => vars[v] ?? "").filter(Boolean).join("\n\n---\n\n");
    } else if (strategy === "json_array") {
      result = JSON.stringify(mergeInputs.map(v => vars[v] ?? ""));
    } else if (strategy === "llm_summarize") {
      const content = mergeInputs.map(v => `## ${v}\n${vars[v] ?? ""}`).join("\n\n");
      const summaryPrompt = `Synthesize and summarize the following sections into a coherent document:\n\n${content}`;
      const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5" },
        summaryPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );
      result = stdout;
      stepResult.durationMs = d;
      stepResult.inputTokens = it;
      stepResult.outputTokens = ot;
    } else if (strategy === "pick_best") {
      const content = mergeInputs.map(v => `## Option: ${v}\n${vars[v] ?? ""}`).join("\n\n");
      const pickPrompt = `You are given multiple outputs. Pick the BEST one based on quality, completeness, and accuracy. Return ONLY the content of the best option, with no additional commentary.\n\n${content}`;
      const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5" },
        pickPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );
      result = stdout;
      stepResult.durationMs = d;
      stepResult.inputTokens = it;
      stepResult.outputTokens = ot;
    }

    const mergeDuration = Date.now() - mergeStartTime;

    stepResult.status = "done";
    stepResult.output = result;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = stepResult.durationMs ?? mergeDuration; // keep LLM duration if set
    vars[step.output_var] = result;

    // Output validation (guardrails) for merge (especially llm_summarize)
    if (strategy === "llm_summarize") {
      const mergeValidationErrors = validateOutput(result, step, (message, level) => {
        emit({ type: "step_log", executionId, stepId, message, level });
      });
      if (mergeValidationErrors.length > 0) {
        for (const err of mergeValidationErrors) {
          emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
        }
      }
    }

    emit({ type: "step_output", executionId, stepId, chunk: result });
    emit({ type: "step_done", executionId, stepId, durationMs: stepResult.durationMs, inputTokens: stepResult.inputTokens, outputTokens: stepResult.outputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "browser") {
    // Browser v2: Playwright-powered, fully parameterizable
    const browserUrl = step.browser_url ? resolveVariables(step.browser_url, vars) : "";
    const browserTask = step.browser_task ? resolveVariables(step.browser_task, vars) : resolveVariables(step.prompt, vars);
    const maxSteps = step.browser_max_steps ?? 20;
    const browserToolsPath = process.env.BROWSER_TOOLS_PATH ?? new URL("../browser-tools.cjs", import.meta.url).pathname;

    // Build CLI options from step config
    const pageName = step.browser_page_name ?? step.id;
    const cliOpts: string[] = [`--page=${pageName}`];
    if (step.browser_port) cliOpts.push(`--port=${step.browser_port}`);
    if (step.browser_headless) cliOpts.push("--headless");
    if (step.browser_wait_ms) cliOpts.push(`--timeout=${step.browser_wait_ms}`);

    const bt = `node "${browserToolsPath}" ${cliOpts.join(" ")}`;

    // Build output format instruction
    const outputInstructions: string[] = [];
    const fmt = step.browser_output_format ?? "text";
    if (fmt === "json") outputInstructions.push("Return your findings as a JSON object with structured data.");
    else if (fmt === "markdown") outputInstructions.push("Return your findings formatted as clean Markdown.");
    else if (fmt === "screenshot") outputInstructions.push("Take a final screenshot and return only the file path.");

    // Build scroll instruction
    const scrollInstructions: string[] = [];
    const scroll = step.browser_scroll_strategy ?? "auto";
    if (scroll === "full") scrollInstructions.push("Before doing anything, scroll through the entire page to load all content: `scroll bottom` then `scroll top`.");
    else if (scroll === "none") scrollInstructions.push("Do NOT scroll the page.");

    // Build cookies instruction
    const cookieInstructions: string[] = [];
    if (step.browser_cookies_domain) {
      cookieInstructions.push(`If you need authentication cookies, run: \`${bt} cookies ${step.browser_cookies_domain}\``);
    }

    const browserPrompt = [
      `You have a Playwright-powered browser. Use these commands via Bash:`,
      "",
      "## Navigation & Reading",
      `  ${bt} goto <url>         — Navigate to URL`,
      `  ${bt} snapshot           — ⭐ AI-optimized page snapshot (accessibility tree — PREFER THIS)`,
      `  ${bt} screenshot [path]  — Take PNG screenshot`,
      `  ${bt} read               — Extract all page text`,
      `  ${bt} title              — Get page title + URL`,
      `  ${bt} cookies [domain]   — Get cookies`,
      "",
      "## Interaction",
      `  ${bt} click <selector>   — Click element (CSS selector)`,
      `  ${bt} click <x>,<y>      — Click coordinates`,
      `  ${bt} fill <selector> <text>  — Fill input field`,
      `  ${bt} type <text>        — Type on keyboard`,
      `  ${bt} press <key>        — Press key (Enter, Tab, Escape...)`,
      `  ${bt} hover <selector>   — Hover element`,
      `  ${bt} select <sel> <val> — Select dropdown`,
      `  ${bt} check <selector>   — Toggle checkbox`,
      `  ${bt} scroll <dir> [px]  — Scroll (up/down/top/bottom)`,
      "",
      "## Advanced",
      `  ${bt} eval <js>          — Execute JavaScript in page`,
      `  ${bt} script <file.js>   — Run a Playwright script file`,
      `  ${bt} tabs               — List open tabs`,
      `  ${bt} pdf [path]         — Save page as PDF`,
      `  ${bt} read-html [sel]    — Get HTML of element`,
      "",
      "## Workflow",
      "1. Use `snapshot` first to understand the page (returns CSS selectors)",
      "2. Act using selectors from the snapshot (click, fill, select...)",
      "3. Use `snapshot` again to verify the result",
      "4. Only use `screenshot` + Read when you need visual layout",
      "",
      `Page "${pageName}" is PERSISTENT — keeps state between commands.`,
      `Maximum ${maxSteps} actions. Be efficient.`,
      ...scrollInstructions,
      ...cookieInstructions,
      ...outputInstructions,
      "",
      browserUrl ? `First, navigate to: ${browserUrl}` : "",
      "",
      `Task: ${browserTask}`,
    ].filter(Boolean).join("\n");

    const browserStep: ChainStep = {
      ...step,
      tools: [`Bash(node "${browserToolsPath}"*)`, "Read"],
      prompt: browserPrompt,
    };

    const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
      browserStep,
      browserPrompt,
      (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
      executionId,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );

    stepResult.status = "done";
    stepResult.output = stdout;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = durationMs;
    stepResult.inputTokens = inputTokens;
    stepResult.outputTokens = outputTokens;
    vars[step.output_var] = stdout;

    // Output validation (guardrails) for browser
    const browserValidationErrors = validateOutput(stdout, step, (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    });
    if (browserValidationErrors.length > 0) {
      for (const err of browserValidationErrors) {
        emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
      }
    }

    // Save browser result to cache if enabled
    if (step.cache?.enabled) {
      const browserCacheKey = createCacheKey(step.id, browserPrompt, step.model);
      saveCache(chain.name, {
        key: browserCacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: stdout,
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens,
        outputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "loop") {
    // Loop: iterate over items, run step_template for each
    const itemsRaw = vars[step.items_var ?? ""] ?? "[]";
    let items: string[];
    try {
      const parsed = JSON.parse(itemsRaw);
      if (Array.isArray(parsed)) {
        items = parsed.map(String);
      } else if (typeof parsed === 'object' && parsed !== null) {
        items = Object.values(parsed).map(String);
      } else {
        items = [String(parsed)];
      }
    } catch {
      items = itemsRaw.split("\n").filter(Boolean);
    }

    if (items.length === 0) {
      emit({ type: "step_log", executionId, stepId, message: "Loop: no items to iterate", level: "warn" });
      stepResult.status = "done";
      stepResult.output = "[]";
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = 0;
      vars[step.output_var] = "[]";
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      persistExecutions();
      return;
    }

    const maxParallel = step.max_parallel ?? items.length;
    const template = step.step_template;
    const results: string[] = [];
    let totalDuration = 0;
    let totalInput = 0;
    let totalOutput = 0;

    emit({ type: "step_log", executionId, stepId, message: `Loop: ${items.length} items, max parallel ${maxParallel}`, level: "info" });

    // Process in batches of maxParallel
    for (let i = 0; i < items.length; i += maxParallel) {
      const batch = items.slice(i, i + maxParallel);
      const batchResults = await Promise.all(
        batch.map(async (item, batchIdx) => {
          const itemIdx = i + batchIdx;
          try {
            const iterVars = { ...vars, item, item_index: String(itemIdx), loop_total: String(items.length) };
            const iterPrompt = resolveVariables(template?.prompt ?? step.prompt, iterVars);

            emit({ type: "step_log", executionId, stepId, message: `Loop item ${itemIdx + 1}/${items.length}: ${item.slice(0, 50)}...`, level: "info" });

            const iterStep: ChainStep = {
              id: `${step.id}_iter_${itemIdx}`,
              output_var: `${step.output_var}_iter_${itemIdx}`,
              model: template?.model ?? step.model,
              prompt: iterPrompt,
              tools: template?.tools ?? step.tools ?? [],
              pre_tools: template?.pre_tools,
              retry: template?.retry ?? step.retry,
            };

            // Execute pre-tools for this iteration
            if (iterStep.pre_tools && iterStep.pre_tools.length > 0) {
              const preResults = await executePreTools(iterStep.pre_tools, iterVars, (message, level) => {
                emit({ type: "step_log", executionId, stepId, message: `[iter ${itemIdx}] ${message}`, level });
              });
              Object.assign(iterVars, preResults);
            }

            const finalPrompt = resolveVariables(iterStep.prompt, iterVars);
            const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
              iterStep, finalPrompt,
              (chunk) => { emit({ type: "step_output", executionId, stepId, chunk: `[${itemIdx + 1}] ${chunk}` }); },
              executionId,
              (message, level) => { emit({ type: "step_log", executionId, stepId, message: `[iter ${itemIdx}] ${message}`, level }); }
            );

            totalDuration += d;
            totalInput += it ?? 0;
            totalOutput += ot ?? 0;
            return stdout;
          } catch (err) {
            if (step.loop_on_error === "continue") {
              const errMsg = err instanceof Error ? err.message : String(err);
              onLog(`Loop item ${itemIdx} failed (continuing): ${errMsg}`, "warn");
              return `[ERROR: ${errMsg}]`;
            }
            throw err; // default: abort
          }
        })
      );
      results.push(...batchResults);

      // Check loop break condition
      if (step.loop_until) {
        const resolvedUntil = resolveVariables(step.loop_until, { ...vars, loop_result: JSON.stringify(results) });
        if (evaluateCondition(resolvedUntil)) {
          onLog(`Loop break condition met after ${results.length} items`, "info");
          break;
        }
      }
    }

    const loopResult = JSON.stringify(results);
    stepResult.status = "done";
    stepResult.output = loopResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = totalDuration;
    stepResult.inputTokens = totalInput;
    stepResult.outputTokens = totalOutput;
    vars[step.output_var] = loopResult;

    emit({ type: "step_log", executionId, stepId, message: `Loop complete: ${results.length} results`, level: "info" });
    emit({ type: "step_done", executionId, stepId, durationMs: totalDuration, inputTokens: totalInput, outputTokens: totalOutput });
    persistExecutions();
    return;
  }

  // ── Subchain: execute another chain as a node ────────────────────────────
  if (stepType === "subchain") {
    const subchainName = step.subchain;
    if (!subchainName) throw new Error(`Step "${step.id}" missing "subchain" field`);

    const { loadChain } = await import("./loader.js");
    const subchain = loadChain(subchainName);

    // Map vars to subchain inputs
    const subInput: Record<string, string> = {};
    if (step.subchain_input_map) {
      for (const [subKey, varExpr] of Object.entries(step.subchain_input_map)) {
        subInput[subKey] = resolveVariables(varExpr, vars);
      }
    } else {
      // Pass all current vars by default
      Object.assign(subInput, vars);
    }

    onLog(`Subchain "${subchainName}" starting with ${Object.keys(subInput).length} inputs`, "info");
    const subStart = Date.now();

    const subResult = await executeChain(subchain, subInput, (ev) => {
      if (ev.type === "step_output") {
        emit({ type: "step_output", executionId, stepId, chunk: (ev as { chunk: string }).chunk });
      } else if (ev.type === "step_started") {
        onLog(`[sub:${subchainName}] Started: ${(ev as { label?: string; stepId: string }).label ?? (ev as { stepId: string }).stepId}`, "info");
      } else if (ev.type === "step_done") {
        onLog(`[sub:${subchainName}] Done: ${(ev as { stepId: string }).stepId} (${((ev as { durationMs: number }).durationMs / 1000).toFixed(1)}s)`, "info");
      } else if (ev.type === "step_error") {
        onLog(`[sub:${subchainName}] Error: ${(ev as { error: string }).error}`, "error");
      }
    });

    const subDuration = Date.now() - subStart;
    stepResult.status = "done";
    stepResult.output = subResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = subDuration;
    vars[step.output_var] = subResult;

    emit({ type: "step_done", executionId, stepId, durationMs: subDuration });
    onLog(`Subchain "${subchainName}" complete (${(subDuration / 1000).toFixed(1)}s, ${subResult.length} chars)`, "info");
    persistExecutions();
    return;
  }

  // ── Debate: multi-agent deliberation ───────────────────────────────────
  if (stepType === "debate") {
    const agents = step.debate_agents ?? [];
    if (agents.length === 0) throw new Error(`Debate step "${step.id}" has no agents defined`);

    const rounds = step.debate_rounds ?? 1;
    const decision = step.debate_decision ?? "voting";
    let totDur = 0, totIn = 0, totOut = 0;
    let agentOutputs: string[] = [];

    onLog(`Debate: ${agents.length} agents, ${rounds} round(s), decision: ${decision}`, "info");

    for (let rd = 0; rd < rounds; rd++) {
      onLog(`── Round ${rd + 1}/${rounds} ──`, "info");

      const roundResults = await Promise.all(
        agents.map(async (ag, idx) => {
          let agentPrompt = resolveVariables(ag.prompt, vars);

          // Inject other agents' perspectives after round 1
          if (rd > 0 && agentOutputs.length > 0) {
            const others = agentOutputs
              .filter((_, j) => j !== idx)
              .map((o, j) => `### Agent ${j + 1}\n${o}`)
              .join("\n\n");
            agentPrompt += `\n\n---\nOther agents' perspectives from the previous round:\n${others}\n\nConsidering these perspectives, refine your analysis:`;
          }

          const agentStep: ChainStep = {
            id: `${step.id}_agent${idx}_r${rd}`,
            output_var: `_debate_${idx}`,
            model: ag.model ?? step.model ?? "claude-sonnet-4-6",
            prompt: agentPrompt,
            tools: [],
            retry: step.retry,
          };

          const r = await runStepWithRetry(
            agentStep, agentPrompt,
            (chunk) => { emit({ type: "step_output", executionId, stepId, chunk: `[Agent${idx + 1}] ${chunk}` }); },
            executionId,
            (msg, lvl) => { onLog(`[Agent${idx + 1}] ${msg}`, lvl); }
          );

          totDur += r.durationMs;
          totIn += r.inputTokens ?? 0;
          totOut += r.outputTokens ?? 0;
          return r.stdout;
        })
      );
      agentOutputs = roundResults;
    }

    // Decision phase
    let finalResult: string;
    if (decision === "last_round") {
      finalResult = agentOutputs.map((o, i) => `## Agent ${i + 1}\n${o}`).join("\n\n");
    } else {
      const label = decision === "voting" ? "majority position" : "consensus";
      const synthPrompt = `Multiple experts have analyzed this topic${rounds > 1 ? ` over ${rounds} rounds of debate` : ""}. Synthesize their final positions into a single coherent answer reflecting the ${label}.\n\n${agentOutputs.map((o, i) => `## Expert ${i + 1}\n${o}`).join("\n\n")}\n\nFinal synthesized answer:`;

      const synthStep: ChainStep = {
        id: `${step.id}_synthesis`,
        output_var: "_synthesis",
        model: step.model ?? "claude-sonnet-4-6",
        prompt: synthPrompt,
        tools: [],
      };

      const sr = await runStepWithRetry(
        synthStep, synthPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (msg, lvl) => { onLog(`[Synthesis] ${msg}`, lvl); }
      );

      totDur += sr.durationMs;
      totIn += sr.inputTokens ?? 0;
      totOut += sr.outputTokens ?? 0;
      finalResult = sr.stdout;
    }

    stepResult.status = "done";
    stepResult.output = finalResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = totDur;
    stepResult.inputTokens = totIn;
    stepResult.outputTokens = totOut;
    vars[step.output_var] = finalResult;

    // Validate output
    const debateValidationErrors = validateOutput(finalResult, step, onLog);
    if (debateValidationErrors.length > 0) {
      for (const err of debateValidationErrors) {
        onLog(`Guardrail warning: ${err}`, "warn");
      }
    }

    // Cache if enabled
    if (step.cache?.enabled) {
      const cacheKey = createCacheKey(step.id, agents.map(a => a.prompt).join("|"), step.model);
      saveCache(chain.name, {
        key: cacheKey, stepId: step.id, chainName: chain.name,
        result: finalResult, createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens: totIn, outputTokens: totOut,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs: totDur, inputTokens: totIn, outputTokens: totOut });
    onLog(`Debate complete: ${agents.length} agents, ${rounds} rounds, ${finalResult.length} chars`, "info");
    persistExecutions();
    return;
  }

  // Webhook: HTTP callback (not yet fully implemented — treat as agent with warning)
  if (stepType === "webhook") {
    onLog("Webhook step type is not yet fully implemented — executing as agent step", "warn");
  }

  // Default: "agent" type (and webhook fallback)

  // Execute pre-tools
  if (step.pre_tools && step.pre_tools.length > 0) {
    const preResults = await executePreTools(
      step.pre_tools,
      vars,
      (message, level) => {
        emit({ type: "step_log", executionId, stepId, message, level });
      }
    );
    Object.assign(vars, preResults);
  }

  // Apply context compression if specified
  let resolveVars = vars;
  if (step.context_strategy) {
    resolveVars = await applyContextStrategy(
      vars,
      step.context_strategy as Record<string, string>,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );
  }

  const resolvedPrompt = resolveVariables(step.prompt, resolveVars);
  const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
    step,
    resolvedPrompt,
    (chunk) => {
      emit({ type: "step_output", executionId, stepId, chunk });
    },
    executionId,
    (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    }
  );

  stepResult.status = "done";
  stepResult.output = stdout;
  stepResult.finishedAt = new Date().toISOString();
  stepResult.durationMs = durationMs;
  stepResult.inputTokens = inputTokens;
  stepResult.outputTokens = outputTokens;

  vars[step.output_var] = stdout;

  // Output validation (guardrails)
  const validationErrors = validateOutput(stdout, step, (message, level) => {
    emit({ type: "step_log", executionId, stepId, message, level });
  });
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
    }
  }

  // Save to cache if enabled
  if (step.cache?.enabled) {
    const cacheKey = createCacheKey(step.id, resolvedPrompt, step.model);
    saveCache(chain.name, {
      key: cacheKey,
      stepId: step.id,
      chainName: chain.name,
      result: stdout,
      createdAt: new Date().toISOString(),
      ttlMinutes: step.cache.ttl_minutes ?? 60,
      inputTokens,
      outputTokens,
    });
  }

  emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
  persistExecutions();
}

export async function executeChain(
  chain: ChainDefinition,
  input: Record<string, string>,
  emit: EventEmitter
): Promise<string> {
  const executionId = crypto.randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Validate required inputs
  for (const inputDef of chain.inputs ?? []) {
    if (!inputDef.optional && input[inputDef.name] === undefined) {
      throw new Error(`Missing required input: "${inputDef.name}"`);
    }
  }

  const execution: ChainExecution = {
    id: executionId,
    chainName: chain.name,
    status: "running",
    input,
    steps: {},
    startedAt,
  };
  executions.set(executionId, execution);
  trimExecutions();
  persistExecutions();

  for (const step of chain.steps) {
    execution.steps[step.id] = {
      stepId: step.id,
      status: "pending",
    };
  }

  emit({ type: "execution_started", executionId, chainName: chain.name });

  runningExecutionCount++;

  const graph = buildDependencyGraph(chain);

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    vars[`input.${k}`] = v;
    vars[k] = v;
  }

  try {
    for (const wave of graph.waves) {
      await Promise.all(
        wave.map(async (stepId) => {
          const step = chain.steps.find((s) => s.id === stepId)!;
          const stepResult = execution.steps[stepId];
          stepResult.status = "running";
          stepResult.startedAt = new Date().toISOString();

          emit({
            type: "step_started",
            executionId,
            stepId,
            label: step.label ?? step.id,
          });

          try {
            await executeStep(step, chain, vars, execution, executionId, emit);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            stepResult.status = "error";
            stepResult.error = error;
            stepResult.finishedAt = new Date().toISOString();

            emit({ type: "step_error", executionId, stepId, error });
            persistExecutions();
            throw err;
          }
        })
      );

      if (vars["__early_exit"] === "true") {
        emit({ type: "step_log", executionId, stepId: "chain", message: "Early exit — skipping remaining waves", level: "info" });
        break;
      }
    }

    const result = vars[chain.output] ?? "";
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
    persistExecutions();

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    execution.status = "error";
    execution.error = error;
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(startedAt).getTime();

    for (const stepResult of Object.values(execution.steps)) {
      if (stepResult.status === "pending") {
        stepResult.status = "skipped";
      }
    }

    emit({ type: "execution_error", executionId, error });
    persistExecutions();
    throw err;
  } finally {
    runningExecutionCount--;
  }
}

// ─── Checkpoint resume ───────────────────────────────────────────────────────

export async function resumeExecution(
  executionId: string,
  chain: ChainDefinition,
  emit: EventEmitter
): Promise<string> {
  const existing = executions.get(executionId);
  if (!existing) throw new Error(`Execution ${executionId} not found`);
  if (existing.status !== "error") throw new Error(`Execution ${executionId} is not in error state (current: ${existing.status})`);

  // Restore vars from completed steps
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing.input)) {
    vars[`input.${k}`] = v;
    vars[k] = v;
  }
  for (const step of chain.steps) {
    const stepResult = existing.steps[step.id];
    if (stepResult?.status === "done" && stepResult.output) {
      vars[step.output_var] = stepResult.output;
    }
  }

  // Reset error/pending steps
  existing.status = "running";
  existing.error = undefined;
  existing.finishedAt = undefined;
  for (const stepResult of Object.values(existing.steps)) {
    if (stepResult.status === "error" || stepResult.status === "skipped") {
      stepResult.status = "pending";
      stepResult.error = undefined;
      stepResult.output = undefined;
    }
  }
  persistExecutions();

  emit({ type: "execution_started", executionId, chainName: chain.name });

  const graph = buildDependencyGraph(chain);

  try {
    for (const wave of graph.waves) {
      await Promise.all(
        wave.map(async (stepId) => {
          const step = chain.steps.find((s) => s.id === stepId)!;
          const stepResult = existing.steps[stepId];

          // Skip already completed steps
          if (stepResult.status === "done") {
            emit({ type: "step_log", executionId, stepId, message: "Restored from checkpoint", level: "info" });
            return;
          }

          stepResult.status = "running";
          stepResult.startedAt = new Date().toISOString();
          emit({ type: "step_started", executionId, stepId, label: step.label ?? step.id });

          try {
            await executeStep(step, chain, vars, existing, executionId, emit);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            stepResult.status = "error";
            stepResult.error = error;
            stepResult.finishedAt = new Date().toISOString();
            emit({ type: "step_error", executionId, stepId, error });
            persistExecutions();
            throw err;
          }
        })
      );

      if (vars["__early_exit"] === "true") {
        emit({ type: "step_log", executionId, stepId: "chain", message: "Early exit — skipping remaining waves", level: "info" });
        break;
      }
    }

    const result = vars[chain.output] ?? "";
    existing.status = "done";
    existing.result = result;
    existing.finishedAt = new Date().toISOString();
    existing.durationMs = Date.now() - new Date(existing.startedAt).getTime();
    emit({ type: "execution_done", executionId, result, durationMs: existing.durationMs });
    persistExecutions();
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    existing.status = "error";
    existing.error = error;
    existing.finishedAt = new Date().toISOString();
    existing.durationMs = Date.now() - new Date(existing.startedAt).getTime();
    for (const stepResult of Object.values(existing.steps)) {
      if (stepResult.status === "pending") stepResult.status = "skipped";
    }
    emit({ type: "execution_error", executionId, error });
    persistExecutions();
    throw err;
  }
}
