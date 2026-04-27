/**
 * system-prompts.ts — Customizable system prompts for each agent context.
 *
 * Stores prompts in a JSON file (default: ./system-prompts.json) so that
 * users can customize the persona/instructions for each entry point without
 * recompiling. Hot-reloads when the file is replaced.
 *
 * Each prompt key maps to a distinct context:
 *   - blobChat       : conversational BLOB assistant (canvas /blobs/:id/chat)
 *   - blobOrchestrator : BLOB plan/grow JSON planner (blob.ts buildOrchestratorPrompt)
 *   - terminalAgent  : free LLM agent attached to a Terminal node (no BLOB persona)
 *   - workflowChat   : workflow chat architect (chat stage of /workflow-chat)
 *   - workflowPlan   : workflow chain planner (plan stage of /workflow-chat)
 *   - stepDefault    : default system prompt prepended to "agent" steps with no
 *                      explicit prompt (rare safety net, not used by chains
 *                      that author their own prompts)
 *
 * Each value is a single Markdown/text string. Empty string means "use the
 * built-in fallback" (the application code falls back to a sensible default).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

export type SystemPromptKey =
  | "blobChat"
  | "blobOrchestrator"
  | "terminalAgent"
  | "workflowChat"
  | "workflowPlan"
  | "stepDefault";

export type SystemPromptsConfig = Record<SystemPromptKey, string>;

// ─── Built-in defaults ──────────────────────────────────────────────────────

export const DEFAULT_PROMPTS: SystemPromptsConfig = {
  blobChat: `You are the BLOB — an organic AI assistant that lives on an infinite canvas. You help users by growing branches of workflows, research chains, and knowledge graphs. Be concise and helpful. When the user's request requires real work (research, code, analysis), tell them what you'll build. For simple questions, answer directly.`,

  blobOrchestrator: `You are the BLOB Orchestrator — an intelligent system that grows organic workflow graphs from conversations. Decide whether to (a) reuse/extend existing branches, (b) create new branches, or (c) just answer directly. Output STRICT JSON only — no prose, no markdown fences. The schema must contain: branches[], reuseBranches[], memoryUpdates[], directResponse?`,

  terminalAgent: `You are a focused AI assistant attached to a canvas terminal node. The user has selected a model and provider — respect their choice. Be concise, helpful and direct. Do not introduce yourself unless asked. Do not mention the BLOB or any persona; respond as the model the user selected.`,

  workflowChat: `You are a helpful workflow architect AI. Help the user design their chain. Ask clarifying questions when intent is ambiguous, suggest specific step types (agent, evaluator, gate, transform, loop, merge, browser, subchain, debate, webhook, image_gen) when appropriate, and keep responses short.`,

  workflowPlan: `You are a chain planner. Given the user's goal, output a JSON plan describing the steps to add to the canvas. Output ONLY valid JSON matching the schema { steps: [{ id, type, label, model?, prompt, depends_on?, output_var? }] }. No markdown fences, no commentary.`,

  stepDefault: `You are an autonomous step in a workflow chain. Execute the task described by the user's prompt. Reference upstream outputs via {variable} interpolation. Be precise, return only the requested output.`,
};

// ─── Storage ────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.SYSTEM_PROMPTS_CONFIG
  ?? path.join(process.cwd(), "system-prompts.json");

let cache: SystemPromptsConfig = { ...DEFAULT_PROMPTS };
let loaded = false;

export function loadSystemPrompts(): SystemPromptsConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SystemPromptsConfig>;
      cache = {
        ...DEFAULT_PROMPTS,
        ...Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string"),
        ),
      } as SystemPromptsConfig;
      logger.info("system-prompts", `Loaded custom prompts from ${CONFIG_PATH}`);
    } else {
      cache = { ...DEFAULT_PROMPTS };
    }
  } catch (err) {
    logger.warn("system-prompts", `Failed to load ${CONFIG_PATH}, using defaults: ${(err as Error).message}`);
    cache = { ...DEFAULT_PROMPTS };
  }
  loaded = true;
  return cache;
}

export function getSystemPrompts(): SystemPromptsConfig {
  if (!loaded) loadSystemPrompts();
  return { ...cache };
}

export function getSystemPrompt(key: SystemPromptKey): string {
  if (!loaded) loadSystemPrompts();
  // Empty string in config falls back to the built-in default.
  const v = cache[key];
  return (typeof v === "string" && v.length > 0) ? v : DEFAULT_PROMPTS[key];
}

export function saveSystemPrompts(patch: Partial<SystemPromptsConfig>): SystemPromptsConfig {
  if (!loaded) loadSystemPrompts();
  // Merge keeping unknown keys out
  const next: SystemPromptsConfig = { ...cache };
  for (const k of Object.keys(DEFAULT_PROMPTS) as SystemPromptKey[]) {
    if (typeof patch[k] === "string") next[k] = patch[k] as string;
  }
  cache = next;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2), "utf-8");
    logger.info("system-prompts", `Saved to ${CONFIG_PATH}`);
  } catch (err) {
    logger.error("system-prompts", `Failed to write ${CONFIG_PATH}: ${(err as Error).message}`);
    throw err;
  }
  return cache;
}

export function resetSystemPrompts(): SystemPromptsConfig {
  cache = { ...DEFAULT_PROMPTS };
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } catch { /* non-critical */ }
  return cache;
}

// Initialize on module load
loadSystemPrompts();
