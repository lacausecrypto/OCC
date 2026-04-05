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
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type ActiveTool = "select" | "pan" | "connect";

export interface DragState {
  type: "none" | "node" | "pan" | "box" | "connect";
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
}

export interface NodeExecState {
  status: "pending" | "running" | "done" | "error";
  output: string[];
  startTime?: number;
  finishedAt?: number;
}
