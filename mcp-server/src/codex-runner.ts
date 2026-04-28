/**
 * codex-runner.ts — OpenAI Codex CLI process management
 *
 * Mirrors `claude-runner.ts`. Spawns the `codex` CLI binary with the user
 * prompt, streams output, captures token usage when reported by the CLI.
 *
 * Codex CLI: https://github.com/openai/codex
 * Default invocation pattern: `codex exec --json -m <model> -- <prompt>`
 *   - `exec`: run a one-shot prompt and exit (non-interactive)
 *   - `--json`: emit JSON-line events on stdout for streaming integrations
 *   - `-m, --model`: override the model
 *   - `--`: separator before raw prompt (when not using --stdin)
 *
 * Auth: Codex CLI handles its own authentication via `codex login` (OAuth
 * with ChatGPT account) or environment variables it reads itself. We don't
 * inject anything into the spawn env — we just inherit the parent process env
 * so the user's local Codex login is used as-is.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execSync, execFileSync } from "node:child_process";
import { z } from "zod";
import type { ChainStep } from "./types.js";
import type { ClaudeResult, ProcessTracker } from "./claude-runner.js";

// ─── Codex CLI version check ────────────────────────────────────────────────

let codexVersion = "";

function sanitizeCodexBinPath(binPath: string): string {
  if (binPath === "codex") return binPath;
  if (!binPath.startsWith("/") && !binPath.match(/^[A-Z]:\\/)) {
    process.stderr.write(`[occ] WARNING: CODEX_CLI must be "codex" or an absolute path. Got: "${binPath}" — using "codex"\n`);
    return "codex";
  }
  if (/[;&|`$(){}]/.test(binPath) || binPath.includes("..")) {
    process.stderr.write(`[occ] WARNING: CODEX_CLI contains suspicious characters — using "codex"\n`);
    return "codex";
  }
  return binPath;
}

function checkCodexVersion(): void {
  if (codexVersion) return;
  try {
    const rawBin = process.env.CODEX_CLI ?? process.env.CODEX_BIN ?? "codex";
    const codexBin = sanitizeCodexBinPath(rawBin);
    codexVersion = execFileSync(codexBin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    process.stderr.write(`[occ] Codex CLI version: ${codexVersion}\n`);
  } catch {
    process.stderr.write(`[occ] WARNING: Could not determine Codex CLI version\n`);
  }
}

// ─── Zod schemas for Codex stream-json events ──────────────────────────────
//
// Codex CLI's `--json` mode emits newline-delimited JSON. The exact event
// shape evolves with releases; we accept a permissive set of patterns:
//   { type: "delta", text: "..." }                — streaming text chunk
//   { type: "message", content: [...] }            — full message after stream
//   { type: "result", text: "..." | result: "..." } — terminal aggregate
//   { type: "usage", input_tokens, output_tokens } — token accounting
//   { type: "error", message: "..." }              — error event
// Anything else is ignored gracefully.

const UsageEventSchema = z.object({
  type: z.string().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
}).passthrough();

const DeltaEventSchema = z.object({
  type: z.union([z.literal("delta"), z.literal("text"), z.literal("chunk"), z.literal("content")]),
  text: z.string().optional(),
  delta: z.union([z.string(), z.object({ text: z.string().optional() }).passthrough()]).optional(),
}).passthrough();

const MessageEventSchema = z.object({
  type: z.union([z.literal("message"), z.literal("assistant")]),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  ]).optional(),
  message: z.object({
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    ]).optional(),
  }).passthrough().optional(),
}).passthrough();

const ResultEventSchema = z.object({
  type: z.literal("result"),
  text: z.string().optional(),
  result: z.string().optional(),
}).passthrough();

const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

// codex CLI 0.122+ shape:
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":..,"cached_input_tokens":..,"output_tokens":..}}
const ItemCompletedSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()),
    ]).optional(),
  }).passthrough(),
}).passthrough();

const TurnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

// ─── Constants ──────────────────────────────────────────────────────────────

const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS) || 30 * 60 * 1000;
const MAX_OUTPUT = 5_000_000;

// ─── Defensive text extraction ──────────────────────────────────────────────
//
// codex CLI is moving fast — new event types (agent_message, reasoning,
// task_started, final_response, …) appear between releases. Rather than
// silently dropping output every time the schema drifts, scan the JSON event
// for plausible text fields and emit them as chunks. Bounded depth so cyclic
// refs or huge nested objects can't explode.
function extractAnyText(obj: unknown, maxDepth: number): string | null {
  if (maxDepth <= 0 || obj == null) return null;
  if (typeof obj === "string") return obj.length > 0 ? obj : null;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (const item of obj) {
      const got = extractAnyText(item, maxDepth - 1);
      if (got) parts.push(got);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    // 1) Prefer canonical text-bearing fields at this level.
    for (const key of ["text", "content", "message", "delta", "output", "value", "result", "response"]) {
      if (key in o) {
        const got = extractAnyText(o[key], maxDepth - 1);
        if (got) return got;
      }
    }
    // 2) Otherwise descend into any nested object/array values (skip
    //    metadata-ish primitive fields like ids, types, timestamps).
    for (const [k, v] of Object.entries(o)) {
      if (k === "type" || k === "id" || k === "thread_id" || k === "usage") continue;
      if (v != null && typeof v === "object") {
        const got = extractAnyText(v, maxDepth - 1);
        if (got) return got;
      }
    }
  }
  return null;
}

// ─── Binary validation ──────────────────────────────────────────────────────

let codexBinValidated = false;
let codexBinPath = "";

export function validateCodexBinary(): void {
  const codexBin = sanitizeCodexBinPath(process.env.CODEX_CLI ?? process.env.CODEX_BIN ?? "codex");
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(whichCmd, [codexBin], { encoding: "utf-8", timeout: 5000 });
    codexBinPath = codexBin;
    codexBinValidated = true;
    process.stderr.write(`[occ] Codex binary verified: ${codexBin}\n`);
    checkCodexVersion();
  } catch {
    process.stderr.write(`[occ] INFO: Codex binary "${codexBin}" not found in PATH. Install via "npm install -g @openai/codex" or set CODEX_CLI env var. Codex provider disabled.\n`);
    codexBinPath = codexBin;
  }
}

export function isCodexAvailable(): boolean {
  return codexBinValidated;
}

// ─── runCodex ───────────────────────────────────────────────────────────────

/**
 * Spawns `codex exec` with the given prompt and step config. Streams output
 * via `onChunk` and resolves with the full result + token counts.
 *
 * Authentication is handled by the Codex CLI itself (codex login / OAuth /
 * env vars). The spawn inherits the parent process env so the user's local
 * Codex authentication is used as-is.
 */
export function runCodex(
  prompt: string,
  step: ChainStep,
  onChunk: (chunk: string) => void,
  executionId?: string,
  timeoutMs?: number,
  processTracker?: ProcessTracker,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const codexBin = codexBinPath || process.env.CODEX_BIN || "codex";

    if (!codexBinValidated) {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      try {
        execSync(`${whichCmd} "${codexBin}"`, { encoding: "utf-8", timeout: 5000 });
        codexBinValidated = true;
        codexBinPath = codexBin;
      } catch {
        reject(new Error(`Codex binary "${codexBin}" not found in PATH. Install via "npm install -g @openai/codex" or set CODEX_CLI env var.`));
        return;
      }
    }

    // Build args. Use --stdin for long prompts and prompts containing tools.
    const USE_STDIN = prompt.length > 65536 || (step.tools && step.tools.length > 0);
    const args: string[] = ["exec", "--json"];
    if (step.model) args.push("--model", step.model);
    // Codex CLI separates prompt from flags with `--`
    if (!USE_STDIN) { args.push("--", prompt); }

    const cwd = step.cwd ?? process.env.WORKSPACE_DIR ?? process.cwd();
    // Inherit the parent env unchanged — Codex CLI uses its own auth
    // (codex login / OAuth / env vars set by the user).
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: "dumb",
      NO_COLOR: "1",
    };

    const child = spawn(codexBin, args, {
      cwd,
      env,
      stdio: [USE_STDIN ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Timeout
    const effectiveTimeout = timeoutMs ?? CODEX_TIMEOUT_MS;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch (e) { process.stderr.write(`[occ] codex timeout SIGTERM failed: ${e}\n`); }
      sigkillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] codex timeout SIGKILL failed: ${e}\n`); } }, 3000);
      if (executionId && processTracker) processTracker.unregister(executionId, child);
      reject(new Error(`codex timed out after ${effectiveTimeout / 1000}s for step "${step.id}"`));
    }, effectiveTimeout);

    // Heartbeat: detect silently dead processes
    const heartbeat = setInterval(() => {
      if (settled) { clearInterval(heartbeat); return; }
      try { process.kill(child.pid!, 0); }
      catch {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
        if (settled) return;
        settled = true;
        if (executionId && processTracker) processTracker.unregister(executionId, child);
        const durationMs = Date.now() - startTime;
        const snapshot = fullTextParts.join("").trim();
        if (snapshot) {
          resolve({ stdout: snapshot, durationMs, inputTokens, outputTokens });
        } else {
          reject(new Error(`codex process died silently (pid ${child.pid}) for step "${step.id}" after ${(durationMs / 1000).toFixed(0)}s`));
        }
      }
    }, 10000);

    if (executionId && processTracker) processTracker.register(executionId, child);

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
    let errorEvent: string | null = null;
    const seenUnknownTypes = new Set<string>();

    const pushChunk = (text: string) => {
      if (!text) return;
      if (fullTextLen < MAX_OUTPUT) {
        fullTextParts.push(text);
        fullTextLen += text.length;
      }
      onChunk(text);
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try to parse as JSON event. If it's not JSON, treat as raw text
        // (some CLI versions emit plain text in --json mode for warnings).
        let raw: unknown;
        try { raw = JSON.parse(trimmed); }
        catch {
          // Fallback: emit as plain text chunk (unless it looks like a status line)
          if (!/^\[(info|warn|debug|error)\]/i.test(trimmed)) pushChunk(line + "\n");
          continue;
        }

        // ── Delta / streaming chunk ──
        const delta = DeltaEventSchema.safeParse(raw);
        if (delta.success) {
          const t = delta.data.text
            ?? (typeof delta.data.delta === "string" ? delta.data.delta : delta.data.delta?.text)
            ?? "";
          if (t) pushChunk(t);
          continue;
        }

        // ── Full message (after stream completes) ──
        const msg = MessageEventSchema.safeParse(raw);
        if (msg.success) {
          const content = msg.data.content ?? msg.data.message?.content;
          if (typeof content === "string") {
            if (content.length > fullTextLen) {
              const diff = content.slice(fullTextLen);
              if (diff) onChunk(diff);
              fullTextParts.length = 0;
              fullTextParts.push(content);
              fullTextLen = content.length;
            }
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) pushChunk(block.text);
            }
          }
          continue;
        }

        // ── Result (terminal aggregate) ──
        const res = ResultEventSchema.safeParse(raw);
        if (res.success) {
          const text = res.data.text ?? res.data.result;
          if (text && text.length > fullTextLen) {
            const diff = text.slice(fullTextLen);
            if (diff) onChunk(diff);
            fullTextParts.length = 0;
            fullTextParts.push(text);
            fullTextLen = text.length;
          }
          continue;
        }

        // ── Token usage ──
        const usage = UsageEventSchema.safeParse(raw);
        if (usage.success && (usage.data.type === "usage" || usage.data.input_tokens !== undefined || usage.data.prompt_tokens !== undefined)) {
          inputTokens = usage.data.input_tokens ?? usage.data.prompt_tokens ?? inputTokens;
          outputTokens = usage.data.output_tokens ?? usage.data.completion_tokens ?? outputTokens;
          continue;
        }

        // ── codex 0.122+ item.completed ──
        const item = ItemCompletedSchema.safeParse(raw);
        if (item.success) {
          const itemType = item.data.item.type;
          // We only emit user-facing assistant text. Skip reasoning, tool
          // calls, file edits etc — those are diagnostic events that would
          // pollute the chat history if streamed.
          if (itemType === "agent_message" || itemType === "message" || itemType === "assistant") {
            const t = item.data.item.text;
            const content = item.data.item.content;
            if (typeof t === "string" && t.length > 0) {
              pushChunk(t);
            } else if (typeof content === "string" && content.length > 0) {
              pushChunk(content);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.text) pushChunk(block.text);
              }
            }
          }
          continue;
        }

        // ── codex 0.122+ turn.completed (carries usage) ──
        const turn = TurnCompletedSchema.safeParse(raw);
        if (turn.success) {
          if (turn.data.usage) {
            inputTokens = turn.data.usage.input_tokens ?? inputTokens;
            outputTokens = turn.data.usage.output_tokens ?? outputTokens;
          }
          continue;
        }

        // ── Error event ──
        const err = ErrorEventSchema.safeParse(raw);
        if (err.success) {
          errorEvent = err.data.message ?? err.data.error ?? "codex error";
          continue;
        }

        // ── Known-but-uninteresting events: drop silently ──
        const evType = (raw as { type?: unknown })?.type;
        if (typeof evType === "string" && (evType === "thread.started" || evType === "turn.started" || evType.startsWith("item.started") || evType.startsWith("item.delta"))) {
          continue;
        }

        // ── Best-effort text extraction (fallback for unknown event types) ──
        // codex CLI versions add new event types (agent_message, reasoning,
        // task_started, final_response, …). Rather than going silent on
        // every new shape, scan the JSON object for plausible text fields
        // and emit them as chunks. Bounded depth so cyclic refs can't
        // explode.
        const extracted = extractAnyText(raw, 4);
        if (extracted) {
          pushChunk(extracted);
          continue;
        }

        // Truly unknown event — log once for debug visibility, then ignore.
        if (typeof evType === "string" && !seenUnknownTypes.has(evType)) {
          seenUnknownTypes.add(evType);
          process.stderr.write(`[codex] unhandled event type: ${JSON.stringify(evType)} (line: ${trimmed.slice(0, 200)})\n`);
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      // Truncate huge stderr to bound memory usage
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (executionId && processTracker) processTracker.unregister(executionId, child);
      reject(new Error(`codex spawn failed: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (executionId && processTracker) processTracker.unregister(executionId, child);

      const durationMs = Date.now() - startTime;
      const fullText = fullTextParts.join("").trim();

      if (errorEvent) {
        reject(new Error(`codex error: ${errorEvent}`));
        return;
      }

      if (code !== 0 && !fullText) {
        const stderrSnippet = stderr.trim().slice(-500) || `(exit ${code})`;
        reject(new Error(`codex exited with code ${code}: ${stderrSnippet}`));
        return;
      }

      resolve({ stdout: fullText, durationMs, inputTokens, outputTokens });
    });
  });
}
