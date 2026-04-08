// ─── Chain definition types (mirrored from backend types.ts) ─────────────────

export type StepType =
  | "agent"
  | "router"
  | "gate"
  | "evaluator"
  | "transform"
  | "loop"
  | "merge"
  | "browser"
  | "subchain"
  | "debate"
  | "webhook"
  | "image_gen";

export type PreToolType =
  | "current_datetime"
  | "http_fetch"
  | "web_search"
  | "read_file"
  | "write_file"
  | "bash"
  | "env_var"
  | "mcp_call"
  | "db_query"
  | "email"
  | "pdf_generate"
  | "ocr"
  // Tier 1
  | "state_load"
  | "state_save"
  | "vector_query"
  | "vector_index"
  | "json_parse"
  | "diff_inject"
  | "notify"
  // Tier 2
  | "semantic_cache"
  | "screenshot"
  | "sandbox_exec"
  | "cost_gate"
  | "ast_parse"
  // Tier 3
  | "embed_compare"
  | "graph_query"
  | "parallel_fetch"
  | "template_render"
  | "approval_request"
  | "image_generate";

export interface ChainInput {
  name: string;
  description?: string;
  optional?: boolean;
}

export interface PreTool {
  type: PreToolType;
  inject_as: string;
  label?: string;
  // type-specific params
  url?: string;
  query?: string;
  path?: string;
  content?: string;
  command?: string;
  var_name?: string;
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  json_path?: string;
  timezone?: string;
  format?: string;
  encoding?: string;
  append?: boolean;
  stderr?: boolean;
  default_value?: string;
  connection?: string;
  sql?: string;
  to?: string;
  subject?: string;
  from?: string;
  provider?: string;
  smtp_host?: string;
  smtp_port?: number;
  html?: string;
  output_path?: string;
  image_path?: string;
  language?: string;
  key?: string;
  value?: string;
  scope?: string;
  default?: string;
  collection?: string;
  top_k?: number;
  source?: string;
  chunk_size?: number;
  input?: string;
  repo?: string;
  base?: string;
  head?: string;
  max_tokens?: number;
  channel?: string;
  webhook_url?: string;
  message?: string;
  similarity_threshold?: number;
  viewport?: { width: number; height: number };
  wait_ms?: number;
  image?: string;
  mount?: string;
  budget_usd?: number;
  action?: string;
  extract?: string[];
  text_a?: string;
  text_b?: string;
  triples?: Array<{ subject: string; predicate: string; object: string }>;
  graph_query_subject?: string;
  graph_query_predicate?: string;
  urls?: string[];
  rate_limit_ms?: number;
  template?: string;
  data?: Record<string, unknown>;
  title?: string;
  description?: string;
  expires_hours?: number;
  on_error?: "inject" | "skip" | "fail";
  timeout_ms?: number;
  retry?: number;
  cache_ttl_minutes?: number;
  parallel?: boolean;
}

export interface RetryConfig {
  max: number;
  delay_ms?: number;
  backoff?: number;
}

export type ContextStrategy = Record<string, "full" | "summarize" | `truncate:${number}`>;

export interface ChainStep {
  id: string;
  type?: StepType;
  label?: string;
  model?: string;
  prompt: string;
  tools?: string[];
  depends_on?: string[];
  output_var: string;
  cwd?: string;
  pre_tools?: PreTool[];
  retry?: RetryConfig;
  fallback_models?: string[];
  condition?: string;
  // Router
  routes?: Record<string, string[]>;
  default_route?: string;
  // Gate
  timeout_hours?: number;
  on_timeout?: "skip" | "error" | "approve";
  // Evaluator
  input_var?: string;
  criteria?: string;
  on_fail?: "retry" | "skip" | "error";
  max_retries?: number;
  retry_target?: string;
  // Transform
  operation?:
    | "json_extract"
    | "regex_match"
    | "template"
    | "split"
    | "merge"
    | "truncate"
    | "replace"
    | "filter"
    | "map"
    | "join"
    | "to_json"
    | "from_json";
  json_path?: string;
  regex?: string;
  template_str?: string;
  // Loop
  items_var?: string;
  max_parallel?: number;
  step_template?: Omit<ChainStep, "id" | "output_var">;
  // Merge
  inputs?: string[];
  strategy?: "concatenate" | "json_array" | "llm_summarize" | "pick_best";
  // Browser
  browser_url?: string;
  browser_task?: string;
  browser_max_steps?: number;
  browser_headless?: boolean;
  browser_port?: number;
  browser_viewport?: { width: number; height: number };
  browser_wait_ms?: number;
  browser_output_format?: "text" | "markdown" | "json" | "screenshot";
  browser_page_name?: string;
  browser_scroll_strategy?: "auto" | "full" | "none";
  browser_cookies_domain?: string;
  // Context compression
  context_strategy?: ContextStrategy;
  // Caching
  cache?: { enabled: boolean; ttl_minutes?: number };
  // Output validation
  output_schema?: "json" | "markdown" | "text";
  output_must_contain?: string[];
  output_must_not_contain?: string[];
  output_max_length?: number;
  // Per-step timeout
  timeout_ms?: number;
  // Subchain
  subchain?: string;
  subchain_input_map?: Record<string, string>;
  chain?: string;
  // Debate
  debate_agents?: Array<{ prompt: string; model?: string }>;
  debate_rounds?: number;
  debate_decision?: "voting" | "consensus" | "last_round";
  // Webhook
  url?: string;
  webhook_url?: string;
  webhook_method?: "POST" | "PUT" | "PATCH" | "GET" | "DELETE";
  webhook_headers?: Record<string, string>;
  webhook_body?: string;
  webhook_timeout_ms?: number;
  webhook_retry?: number;
  webhook_success_status?: number[];
  // Early exit
  early_exit_if?: string;
  // Transform extras
  truncate_limit?: number;
  // Loop improvements
  loop_until?: string;
  loop_on_error?: "continue" | "abort";
  // Gate improvements
  gate_actions?: string[];
  gate_rejection_reason?: boolean;
  gate_auto_approve_if?: string;
  // Evaluator improvements
  eval_scoring?: boolean;
  eval_threshold?: number;
  guardrails?: Array<{
    type:
      | "max_length"
      | "min_length"
      | "must_contain"
      | "must_not_contain"
      | "regex_match"
      | "json_valid";
    value?: string | number;
  }>;
}

export interface ChainDefinition {
  name: string;
  description?: string;
  version?: string;
  inputs?: ChainInput[];
  steps: ChainStep[];
  output: string;
}

// ─── Pipeline (multi-chain) definition ───────────────────────────────────────

export interface PipelineChainRef {
  id: string;
  chain: string;
  label?: string;
  depends_on?: string[];
  condition?: string;
  inputs: Record<string, string>;
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  version?: string;
  inputs?: ChainInput[];
  chains: PipelineChainRef[];
  output: string;
}
