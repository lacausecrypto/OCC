/**
 * claude-runner.ts — Claude CLI process management
 *
 * Extracted from executor.ts. Handles spawning `claude -p` processes,
 * retry/backoff logic, concurrent execution tracking, and context compression.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execSync, execFileSync } from "node:child_process";
import { z } from "zod";
import type { ChainStep } from "./types.js";
import { resolveVariables } from "./utils.js";
import { resolveProvider, runLLMHTTP } from "./providers.js";

// ─── Claude CLI version check ──────────────────────────────────────────────

let claudeVersion = "";

// SECURITY: Validate CLAUDE_CLI/CLAUDE_BIN to prevent arbitrary binary execution
function sanitizeClaudeBinPath(binPath: string): string {
  // Only allow "claude" (default) or absolute paths to real binaries
  if (binPath === "claude") return binPath;
  // Allow absolute paths only (no relative paths that could be manipulated)
  if (!binPath.startsWith("/") && !binPath.match(/^[A-Z]:\\/)) {
    process.stderr.write(`[occ] WARNING: CLAUDE_CLI must be "claude" or an absolute path. Got: "${binPath}" — using "claude"\n`);
    return "claude";
  }
  // Block paths containing suspicious patterns
  if (/[;&|`$(){}]/.test(binPath) || binPath.includes("..")) {
    process.stderr.write(`[occ] WARNING: CLAUDE_CLI contains suspicious characters — using "claude"\n`);
    return "claude";
  }
  return binPath;
}

function checkClaudeVersion(): void {
  if (claudeVersion) return;
  try {
    const rawBin = process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? "claude";
    const claudeBin = sanitizeClaudeBinPath(rawBin);
    claudeVersion = execFileSync(claudeBin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    process.stderr.write(`[occ] Claude CLI version: ${claudeVersion}\n`);
  } catch {
    process.stderr.write(`[occ] WARNING: Could not determine Claude CLI version\n`);
  }
}

// ─── Zod schemas for Claude stream-json events ─────────────────────────────

const UsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
}).passthrough();

const ContentBlockDeltaSchema = z.object({
  type: z.literal("content_block_delta"),
  delta: z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
});

const ContentBlock = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const AssistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(ContentBlock).optional(),
    usage: UsageSchema.optional(),
  }).passthrough(),
});

const ResultSchema = z.object({
  type: z.literal("result"),
  result: z.string().optional(),
  usage: UsageSchema.optional(),
}).passthrough();

const MessageDeltaSchema = z.object({
  type: z.literal("message_delta"),
  usage: UsageSchema.optional(),
}).passthrough();

const MessageSchema = z.object({
  type: z.literal("message"),
  message: z.object({
    content: z.array(ContentBlock).optional(),
    usage: UsageSchema.optional(),
  }).passthrough(),
});

/** Patterns that indicate a stderr/error line, not actual content. */
const ERROR_LINE_PATTERNS = [
  /^error:/i,
  /^warning:/i,
  /^fatal:/i,
  /^SIGTERM/,
  /^SIGKILL/,
  /^Traceback/,
  /^\s*at\s+/,    // stack trace line
  /^node:/,       // node internal error
];

// ─── ClaudeResult interface ──────────────────────────────────────────────────

export interface ClaudeResult {
  stdout: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min default
const MAX_OUTPUT = 5_000_000; // 5MB max output size to prevent unbounded memory growth
export const MAX_CONCURRENT_EXECUTIONS = Number(process.env.MAX_CONCURRENT_EXECUTIONS) || 5;

// ─── Claude binary validation (once at startup, not per step) ────────────────

let claudeBinValidated = false;
let claudeBinPath = "";

/**
 * Validates that the Claude CLI binary is available in the system PATH.
 * Should be called once at startup. Sets internal state so subsequent
 * `runClaude()` calls can skip re-validation.
 */
export function validateClaudeBinary(): void {
  const claudeBin = sanitizeClaudeBinPath(process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? "claude");
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    // Use execFileSync to avoid shell injection via CLAUDE_CLI env var
    execFileSync(whichCmd, [claudeBin], { encoding: "utf-8", timeout: 5000 });
    claudeBinPath = claudeBin;
    claudeBinValidated = true;
    process.stderr.write(`[occ] Claude binary verified: ${claudeBin}\n`);
    checkClaudeVersion();
  } catch {
    process.stderr.write(`[occ] WARNING: Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_CLI env var.\n`);
    claudeBinPath = claudeBin; // still set so error is clear if used
  }
}

// ─── Concurrent execution tracking ──────────────────────────────────────────

let runningExecutionCount = 0;

/**
 * Returns the number of currently running chain executions.
 */
export function getRunningExecutionCount(): number {
  return runningExecutionCount;
}

/**
 * Returns true if a new execution can be started without exceeding the
 * MAX_CONCURRENT_EXECUTIONS limit.
 */
export function canStartExecution(): boolean {
  return runningExecutionCount < MAX_CONCURRENT_EXECUTIONS;
}

/**
 * Increments the running execution counter. Call when an execution starts.
 */
export function incrementRunningCount(): void {
  runningExecutionCount++;
}

/**
 * Decrements the running execution counter. Call when an execution finishes.
 */
export function decrementRunningCount(): void {
  runningExecutionCount = Math.max(0, runningExecutionCount - 1);
}

// ─── Process tracker interface ───────────────────────────────────────────────

/**
 * Optional tracker for registering/unregistering child processes,
 * allowing the caller (executor) to manage cancellation of active processes.
 */
export interface ProcessTracker {
  register: (id: string, child: ChildProcess) => void;
  unregister: (id: string, child: ChildProcess) => void;
}

// ─── claude -p invocation ────────────────────────────────────────────────────

/**
 * Spawns `claude -p` with the given prompt and step configuration, streaming
 * output chunks via `onChunk`. Returns the full result including token usage.
 *
 * @param prompt - The prompt text to send to Claude
 * @param step - The chain step configuration (model, tools, cwd, etc.)
 * @param onChunk - Callback invoked with each text chunk as it streams
 * @param executionId - Optional execution ID for process tracking/cancellation
 * @param timeoutMs - Optional per-call timeout override (defaults to CLAUDE_TIMEOUT_MS)
 * @param processTracker - Optional tracker to register/unregister child processes for cancellation
 */
export function runClaude(
  prompt: string,
  step: ChainStep,
  onChunk: (chunk: string) => void,
  executionId?: string,
  timeoutMs?: number,
  processTracker?: ProcessTracker
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
        reject(new Error(`Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_CLI env var to the full path.`));
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
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGTERM failed: ${e}\n`); }
        sigkillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGKILL failed: ${e}\n`); } }, 3000);
        if (executionId && processTracker) { processTracker.unregister(executionId, child); }
        reject(new Error(`claude timed out after ${effectiveTimeout / 1000}s for step "${step.id}"`));
      }
    }, effectiveTimeout);

    // Heartbeat: detect silently dead processes (check every 30s)
    const heartbeat = setInterval(() => {
      if (settled) { clearInterval(heartbeat); return; }
      try {
        process.kill(child.pid!, 0);
      } catch {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
        if (settled) return;
        settled = true;
        if (executionId && processTracker) { processTracker.unregister(executionId, child); }
        const durationMs = Date.now() - startTime;
        const snapshot = fullTextParts.join("").trim();
        const snapInput = inputTokens;
        const snapOutput = outputTokens;
        if (snapshot) {
          resolve({ stdout: snapshot, durationMs, inputTokens: snapInput, outputTokens: snapOutput });
        } else {
          reject(new Error(`claude process died silently (pid ${child.pid}) for step "${step.id}" after ${(durationMs / 1000).toFixed(0)}s`));
        }
      }
    }, 10000);

    // Register for cancellation (supports multiple parallel processes per execution)
    if (executionId && processTracker) {
      processTracker.register(executionId, child);
    }

    if (USE_STDIN) {
      child.stdin!.write(prompt, "utf-8");
      child.stdin!.end();
    }

    let lineBuffer = "";
    const fullTextParts: string[] = [];
    let fullTextLen = 0;
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
          const raw = JSON.parse(line);

          // ── Validate with Zod and dispatch by type ──
          const cbd = ContentBlockDeltaSchema.safeParse(raw);
          if (cbd.success) {
            const text = cbd.data.delta.text ?? "";
            if (text) {
              if (fullTextLen < MAX_OUTPUT) { fullTextParts.push(text); fullTextLen += text.length; }
              onChunk(text);
            }
            continue;
          }

          const asst = AssistantSchema.safeParse(raw);
          if (asst.success) {
            for (const block of asst.data.message.content ?? []) {
              if (block.type === "text" && block.text) {
                if (fullTextLen < MAX_OUTPUT) { fullTextParts.push(block.text); fullTextLen += block.text.length; }
                onChunk(block.text);
              }
            }
            if (asst.data.message.usage) {
              inputTokens = asst.data.message.usage.input_tokens ?? inputTokens;
              outputTokens = (asst.data.message.usage.output_tokens ?? 0) + (outputTokens ?? 0);
            }
            continue;
          }

          const res = ResultSchema.safeParse(raw);
          if (res.success) {
            if (res.data.usage) {
              inputTokens = res.data.usage.input_tokens ?? inputTokens;
              outputTokens = res.data.usage.output_tokens ?? outputTokens;
            }
            if (res.data.result) {
              const resultText = res.data.result;
              if (resultText.length > fullTextLen) {
                const diff = resultText.slice(fullTextLen);
                if (diff) onChunk(diff);
                fullTextParts.length = 0;
                fullTextParts.push(resultText);
                fullTextLen = resultText.length;
              }
            }
            continue;
          }

          const md = MessageDeltaSchema.safeParse(raw);
          if (md.success) {
            if (md.data.usage?.output_tokens) outputTokens = md.data.usage.output_tokens;
            continue;
          }

          const msg = MessageSchema.safeParse(raw);
          if (msg.success) {
            for (const block of msg.data.message.content ?? []) {
              if (block.type === "text" && block.text) {
                if (fullTextLen < MAX_OUTPUT) { fullTextParts.push(block.text); fullTextLen += block.text.length; }
                onChunk(block.text);
              }
            }
            if (msg.data.message.usage) {
              inputTokens = msg.data.message.usage.input_tokens ?? inputTokens;
              outputTokens = msg.data.message.usage.output_tokens ?? outputTokens;
            }
            continue;
          }

          // Unknown event type — log once for debugging but don't crash
          if (raw.type) {
            process.stderr.write(`[occ] Unknown Claude event type: "${raw.type}"\n`);
          }
        } catch {
          // Non-JSON line — filter out error/warning lines, keep genuine content
          const trimmedLine = line.trim();
          const isErrorLine = ERROR_LINE_PATTERNS.some(p => p.test(trimmedLine));
          if (isErrorLine) {
            stderr += line + "\n";
          } else if (trimmedLine && fullTextLen < MAX_OUTPUT) {
            fullTextParts.push(line + "\n");
            fullTextLen += line.length + 1;
            onChunk(line + "\n");
          }
        }
      }
    });

    const MAX_STDERR = 100_000; // 100KB cap
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) {
        stderr += chunk.toString("utf-8");
        if (stderr.length > MAX_STDERR) {
          stderr = stderr.slice(0, MAX_STDERR);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
      if (settled) return;
      settled = true;
      if (executionId && processTracker) { processTracker.unregister(executionId, child); }
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
      if (settled) return;
      settled = true;
      if (executionId && processTracker) { processTracker.unregister(executionId, child); }

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
              if (resultText.length > fullTextLen) {
                fullTextParts.length = 0;
                fullTextParts.push(resultText);
                fullTextLen = resultText.length;
              }
            }
          }
        } catch { /* ignore */ }
      }

      const durationMs = Date.now() - startTime;
      const fullText = fullTextParts.join("");
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

// ─── Retry with exponential backoff + model fallback ─────────────────────────

/**
 * Runs a chain step with retry logic including exponential backoff and
 * optional model fallback. Delegates to `runClaude()` for each attempt.
 *
 * @param step - The chain step configuration
 * @param resolvedPrompt - The prompt with variables already resolved
 * @param onChunk - Callback for streaming output chunks
 * @param executionId - The execution ID for process tracking
 * @param onLog - Logging callback for retry status messages
 * @param processTracker - Optional tracker for process cancellation
 */
export async function runStepWithRetry(
  step: ChainStep,
  resolvedPrompt: string,
  onChunk: (chunk: string) => void,
  executionId: string,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  processTracker?: ProcessTracker
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

        // ─── Multi-provider routing ─────────────────────────────
        // Check if this model should be routed to an HTTP provider
        // instead of the Claude CLI.
        const resolved = resolveProvider(stepWithModel.model ?? "", (stepWithModel as unknown as Record<string, unknown>).provider as string | undefined);
        if (resolved && resolved.provider.type !== "claude" && resolved.provider.apiKey) {
          // Non-Claude provider → use HTTP adapter
          onLog(`Using provider: ${resolved.provider.name} (${resolved.model})`, "info");
          const result = await runLLMHTTP(
            {
              provider: resolved.provider.id,
              model: resolved.model,
              prompt: resolvedPrompt,
              maxTokens: 8192,
              stream: true,
            },
            onChunk,
          );
          return {
            stdout: result.text,
            durationMs: result.durationMs,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          };
        }

        // Default: Claude CLI
        return await runClaude(resolvedPrompt, stepWithModel, onChunk, executionId, step.timeout_ms, processTracker);
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

// ─── Context compression ─────────────────────────────────────────────────────

/**
 * Applies context compression strategies to variables before they are
 * interpolated into a step prompt. Supports "full" (no change), "summarize"
 * (uses Haiku to compress), and "truncate:N" (hard character limit).
 *
 * @param vars - Current variable map
 * @param strategy - Map of variable name to compression action
 * @param onLog - Logging callback
 * @param processTracker - Optional tracker for the summarization subprocess
 */
export async function applyContextStrategy(
  vars: Record<string, string>,
  strategy: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  processTracker?: ProcessTracker
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
          () => {},
          undefined,
          15000, // 15s timeout — fast fail to keep original
          processTracker
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

/**
 * Auto-compress vars in-place when total chars exceed budget.
 * Keeps input.* vars and the N most recent step outputs intact.
 * Summarizes older outputs via Haiku; falls back to truncation.
 */
export async function autoCompressVars(
  vars: Record<string, string>,
  maxChars: number,
  recentKeepCount: number,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  processTracker?: ProcessTracker,
  /** @internal test-only: override the compression function */
  _compressFn?: (text: string) => Promise<string>,
): Promise<number> {
  const totalChars = () => Object.values(vars).reduce((s, v) => s + v.length, 0);
  const current = totalChars();
  if (current <= maxChars) return current;

  // Partition keys into protected, recent, and old
  const allKeys = Object.keys(vars);
  const protectedKeys = new Set(allKeys.filter(k => k.startsWith("input.") || k === "__early_exit"));
  // Also protect the bare input aliases (keys that also exist as input.X)
  for (const k of allKeys) {
    if (protectedKeys.has(`input.${k}`)) protectedKeys.add(k);
  }

  const stepKeys = allKeys.filter(k => !protectedKeys.has(k));
  // Recent = last N step keys (JS preserves insertion order for string keys)
  const recentKeys = new Set(stepKeys.slice(-recentKeepCount));
  // Old = everything else, sorted by size (largest first) for max impact
  const oldKeys = stepKeys
    .filter(k => !recentKeys.has(k))
    .sort((a, b) => (vars[b]?.length ?? 0) - (vars[a]?.length ?? 0));

  for (const key of oldKeys) {
    if (totalChars() <= maxChars) break;
    const value = vars[key];
    if (!value || value.length < 500) continue;

    // Try Haiku summarization (or test override)
    try {
      let compressed: string;
      if (_compressFn) {
        compressed = await _compressFn(value);
      } else {
        const summaryPrompt = `Summarize concisely, preserving key technical details:\n\n${value}`;
        const { stdout } = await runClaude(
          summaryPrompt,
          { id: "_auto_compress", output_var: "_", tools: [], model: "claude-haiku-4-5", prompt: "" } as ChainStep,
          () => {},
          undefined,
          15000, // 15s timeout — fast fail to truncation fallback
          processTracker,
        );
        compressed = stdout;
      }
      const before = value.length;
      vars[key] = compressed;
      onLog(`Auto-compressed "${key}": ${before} → ${compressed.length} chars (summarize)`, "info");
    } catch {
      // Fallback: hard truncate to 1000 chars
      const before = value.length;
      vars[key] = value.slice(0, 1000) + `\n[auto-truncated from ${before} chars]`;
      onLog(`Auto-truncated "${key}": ${before} → 1000 chars (Haiku unavailable)`, "warn");
    }
  }

  const final = totalChars();
  return final;
}
