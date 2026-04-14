// ─── Canvas types for the visual chain editor ───────────────────────────────

import type { StepType, PreTool, RetryConfig, ContextStrategy } from "./chain";

/** Advanced step configuration — maps directly to ChainStep fields */
export interface StepAdvancedConfig {
  // Resilience
  retry?: RetryConfig;
  fallback_models?: string[];
  timeout_ms?: number;
  // Environment
  cwd?: string;
  // Caching
  cache?: { enabled: boolean; ttl_minutes?: number };
  // Output validation
  output_schema?: "json" | "markdown" | "text";
  output_must_contain?: string[];
  output_must_not_contain?: string[];
  output_max_length?: number;
  // Context compression
  context_strategy?: ContextStrategy;
  // Control flow
  early_exit_if?: string;
  condition?: string;
  // Gate
  timeout_hours?: number;
  on_timeout?: "skip" | "error" | "approve";
  gate_actions?: string[];
  gate_auto_approve_if?: string;
  gate_rejection_reason?: boolean;
  // Router
  routes?: Record<string, string[]>;
  default_route?: string;
  // Evaluator
  input_var?: string;
  criteria?: string;
  on_fail?: "retry" | "skip" | "error";
  max_retries?: number;
  retry_target?: string;
  eval_scoring?: boolean;
  eval_threshold?: number;
  // Transform
  operation?: string;
  json_path?: string;
  regex?: string;
  template_str?: string;
  truncate_limit?: number;
  // Loop
  items_var?: string;
  max_parallel?: number;
  loop_until?: string;
  loop_on_error?: "continue" | "abort";
  // Merge
  inputs?: string[];
  strategy?: "concatenate" | "json_array" | "llm_summarize" | "pick_best";
  // Browser
  browser_url?: string;
  browser_task?: string;
  browser_max_steps?: number;
  browser_headless?: boolean;
  browser_viewport?: { width: number; height: number };
  browser_wait_ms?: number;
  browser_output_format?: "text" | "markdown" | "json" | "screenshot";
  // Subchain
  subchain?: string;
  subchain_input_map?: Record<string, string>;
  // Debate
  debate_agents?: Array<{ prompt: string; model?: string }>;
  debate_rounds?: number;
  debate_decision?: "voting" | "consensus" | "last_round";
  // Webhook
  webhook_url?: string;
  webhook_method?: "POST" | "PUT" | "PATCH" | "GET" | "DELETE";
  webhook_headers?: Record<string, string>;
  webhook_body?: string;
  webhook_timeout_ms?: number;
  webhook_retry?: number;
  // Guardrails
  guardrails?: Array<{ type: string; value?: string | number }>;
}

/** Discriminator for canvas item kinds */
export type CanvasItemKind = "step" | "sticky" | "text" | "portal" | "file" | "link" | "terminal";

export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: StepType;
  label: string;
  model?: string;
  preTools: PreTool[];
  tools: string[];
  outputVar: string;
  stepId: string;
  prompt: string;
  /** Advanced configuration — resilience, caching, type-specific fields */
  advanced?: StepAdvancedConfig;
  /** Item kind — "step" for workflow nodes (default), or rich canvas items */
  kind?: CanvasItemKind;
  // ─── Sticky note fields ─────────────────────────────────────────
  stickyColor?: string;
  stickyText?: string;
  fontSize?: number;
  // ─── Text block fields ──────────────────────────────────────────
  markdown?: string;
  // ─── Portal (embedded browser / link preview) fields ────────────
  portalUrl?: string;
  portalScreenshot?: string;
  portalTitle?: string;
  portalDescription?: string;
  portalFavicon?: string;
  portalStatus?: "loading" | "loaded" | "error";
  // ─── File viewer fields ─────────────────────────────────────────
  filePath?: string;
  fileContent?: string;
  // ─── Link bookmark fields ───────────────────────────────────────
  linkUrl?: string;
  linkTitle?: string;
  linkFavicon?: string;
  // ─── Terminal/Agent node fields ─────────────────────────────────
  terminalProvider?: string;      // provider ID (e.g. "openrouter", "ollama")
  terminalModel?: string;         // model ID
  terminalSystemPrompt?: string;  // role instructions
  terminalMessages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  terminalName?: string;          // display name (e.g. "Claude Code", "GPT-4o")
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  /** Optional bezier control point offsets for manual reshaping */
  cp1?: { dx: number; dy: number };
  cp2?: { dx: number; dy: number };
}

/** Pastel colors for sticky notes */
export const STICKY_COLORS = [
  "#FFF9C4", // yellow
  "#F8BBD0", // pink
  "#C8E6C9", // green
  "#BBDEFB", // blue
  "#E1BEE7", // purple
  "#FFE0B2", // orange
] as const;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type ActiveTool = "select" | "pan" | "connect";

/** Which corner/edge is being resized */
export type ResizeHandle = "se" | "sw" | "ne" | "nw" | "e" | "w" | "n" | "s";

export interface DragState {
  type: "none" | "node" | "pan" | "box" | "connect" | "controlPoint" | "resize";
  /** Offsets for dragging multiple selected nodes */
  offsets?: Map<string, { dx: number; dy: number }>;
  /** For connect: source node ID */
  fromId?: string;
  /** Start/current screen coords */
  sx?: number;
  sy?: number;
  mx?: number;
  my?: number;
  lastX?: number;
  lastY?: number;
  /** For controlPoint drag: which edge and which handle */
  edgeId?: string;
  cpHandle?: "cp1" | "cp2";
  /** Canvas-space origin when control point drag started */
  cpOriginX?: number;
  cpOriginY?: number;
  /** For resize: target node and handle */
  resizeNodeId?: string;
  resizeHandle?: ResizeHandle;
  /** Original bounds when resize started */
  resizeOrigin?: { x: number; y: number; w: number; h: number };
}

export interface NodeExecState {
  status: "pending" | "running" | "done" | "error";
  output: string[];
  startTime?: number;
  finishedAt?: number;
}
