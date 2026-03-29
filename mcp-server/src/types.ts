// ─── Chain definition (YAML schema) ───────────────────────────────────────────

export interface ChainInput {
  name: string;
  description?: string;
  optional?: boolean;
}

export type PreToolType = "current_datetime" | "http_fetch" | "web_search" | "read_file" | "write_file" | "bash" | "env_var";

export interface PreTool {
  type: PreToolType;
  inject_as: string;      // variable name available as {inject_as} in prompt
  label?: string;         // display name
  // type-specific params:
  url?: string;           // http_fetch
  query?: string;         // web_search (supports {variables})
  path?: string;          // read_file, write_file
  content?: string;       // write_file (supports {variables} — content to write)
  command?: string;       // bash (supports {variables})
  var_name?: string;      // env_var
}

export type StepType = "agent" | "router" | "gate" | "evaluator" | "transform" | "loop" | "merge" | "browser" | "subchain" | "debate" | "webhook";

export interface RetryConfig {
  max: number;           // max retry attempts (default 1 = no retry)
  delay_ms?: number;     // initial delay (default 2000)
  backoff?: number;      // backoff multiplier (default 2)
}

export type ContextStrategy = Record<string, "full" | "summarize" | `truncate:${number}`>;

export interface ChainStep {
  id: string;
  type?: StepType;                    // defaults to "agent"
  label?: string;
  model?: string;
  prompt: string;
  tools?: string[];
  depends_on?: string[];
  output_var: string;
  cwd?: string;
  pre_tools?: PreTool[];
  // Retry & fallback
  retry?: RetryConfig;
  fallback_models?: string[];         // e.g. ["claude-opus-4-6", "claude-sonnet-4-6"]
  // Conditional execution
  condition?: string;                 // expression like '{var} == "value"'
  // Router-specific
  routes?: Record<string, string[]>;  // route_key -> [stepIds]
  default_route?: string;
  // Gate-specific
  timeout_hours?: number;
  on_timeout?: "skip" | "error" | "approve";
  // Evaluator-specific
  input_var?: string;
  criteria?: string;
  on_fail?: "retry" | "skip" | "error";
  max_retries?: number;
  retry_target?: string;             // step id to re-run
  // Transform-specific
  operation?: "json_extract" | "regex_match" | "template" | "split" | "merge" | "truncate" | "replace" | "filter" | "map" | "join" | "to_json" | "from_json";
  json_path?: string;
  regex?: string;
  template_str?: string;
  // Loop-specific
  items_var?: string;
  max_parallel?: number;
  step_template?: Omit<ChainStep, "id" | "output_var">;
  // Merge-specific
  inputs?: string[];                 // variable names to merge
  strategy?: "concatenate" | "json_array" | "llm_summarize" | "pick_best";
  // Browser-specific
  browser_url?: string;              // Starting URL (supports {variables})
  browser_task?: string;             // Task description for Claude
  browser_max_steps?: number;        // Max browser actions (default 20)
  browser_headless?: boolean;        // Launch headless Chromium if no Chrome found
  browser_port?: number;             // Chrome debug port (default: auto-discover 9222-9229)
  browser_viewport?: { width: number; height: number }; // Viewport size (default: 1280x720)
  browser_wait_ms?: number;          // Wait after navigation (default: 3000)
  browser_output_format?: "text" | "markdown" | "json" | "screenshot"; // Output format
  browser_page_name?: string;        // Persistent page name (survives between steps)
  browser_scroll_strategy?: "auto" | "full" | "none"; // Scroll strategy
  browser_cookies_domain?: string;   // Filter cookies by domain
  // Context compression
  context_strategy?: ContextStrategy;
  // Caching
  cache?: {
    enabled: boolean;
    ttl_minutes?: number;  // default 60
  };
  // Output validation
  output_schema?: "json" | "markdown" | "text";
  output_must_contain?: string[];
  output_must_not_contain?: string[];
  output_max_length?: number;
  // Per-step timeout
  timeout_ms?: number;
  // Subchain
  subchain?: string;  // chain name to execute
  subchain_input_map?: Record<string, string>;  // map vars to subchain inputs
  // Debate
  debate_agents?: Array<{ prompt: string; model?: string }>;
  debate_rounds?: number;
  debate_decision?: "voting" | "consensus" | "last_round";
  // Early exit
  early_exit_if?: string;  // condition expression
  // Transform extras
  truncate_limit?: number;  // dedicated field instead of json_path hack
  // Loop improvements
  loop_until?: string;  // break condition
  loop_on_error?: "continue" | "abort";  // per-item error handling
  // Gate improvements
  gate_actions?: string[];  // custom actions like ["approve", "reject", "escalate"]
  gate_rejection_reason?: boolean;  // whether to collect reason
  gate_auto_approve_if?: string;  // condition for auto-approve
  // Evaluator improvements
  eval_scoring?: boolean;  // numeric 1-10 instead of PASS/FAIL
  eval_threshold?: number;  // minimum score to pass
  guardrails?: Array<{
    type: "max_length" | "min_length" | "must_contain" | "must_not_contain" | "regex_match" | "json_valid";
    value?: string | number;
  }>;
}

export interface ChainDefinition {
  name: string;
  description?: string;
  version?: string;
  inputs?: ChainInput[];
  steps: ChainStep[];
  output: string; // output_var to return as chain result
}

// ─── Execution state ──────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ExecutionStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface ChainExecution {
  id: string;
  chainName: string;
  status: ExecutionStatus;
  input: Record<string, string>;
  steps: Record<string, StepResult>;
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

// ─── Pipeline (multi-chain) definition ────────────────────────────────────────

export interface PipelineChainRef {
  id: string;                           // unique ID within the pipeline
  chain: string;                        // chain name to execute
  label?: string;                       // display name
  depends_on?: string[];                // IDs of previous pipeline chains
  condition?: string;                   // skip if falsy
  inputs: Record<string, string>;       // mapping: chain_input_name → "{input.var}" or "{other_chain_id}" or literal
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  version?: string;
  inputs?: ChainInput[];                // pipeline-level inputs
  chains: PipelineChainRef[];           // chains to execute in order
  output: string;                       // chain ref ID whose result is the pipeline output
}

export interface PipelineExecution {
  id: string;
  pipelineName: string;
  status: ExecutionStatus;
  input: Record<string, string>;
  chains: Record<string, {
    chainRefId: string;
    chainName: string;
    status: ExecutionStatus;
    executionId?: string;               // the underlying chain execution ID
    result?: string;
    error?: string;
    durationMs?: number;
  }>;
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

// ─── SSE events ───────────────────────────────────────────────────────────────

export type ExecutionEvent =
  | { type: "execution_started"; executionId: string; chainName: string }
  | { type: "step_started"; executionId: string; stepId: string; label?: string }
  | { type: "step_output"; executionId: string; stepId: string; chunk: string }
  | { type: "step_done"; executionId: string; stepId: string; durationMs: number; inputTokens?: number; outputTokens?: number }
  | { type: "step_error"; executionId: string; stepId: string; error: string }
  | { type: "step_log"; executionId: string; stepId: string; message: string; level: "info" | "warn" | "error" }
  | { type: "execution_done"; executionId: string; result: string; durationMs: number }
  | { type: "step_waiting_approval"; executionId: string; stepId: string; prompt: string }
  | { type: "execution_error"; executionId: string; error: string }
  | { type: "step_cache_hit"; executionId: string; stepId: string }
  | { type: "gate_action"; executionId: string; stepId: string; action: string; reason?: string };

// ─── Cache ────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  key: string;
  stepId: string;
  chainName: string;
  result: string;
  createdAt: string;
  ttlMinutes: number;
  inputTokens?: number;
  outputTokens?: number;
}
