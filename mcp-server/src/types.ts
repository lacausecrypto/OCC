// ─── Chain definition (YAML schema) ───────────────────────────────────────────

export type ChainInputType = "string" | "number" | "boolean" | "enum" | "file" | "image" | "json" | "url" | "text";

export interface ChainInput {
  name: string;
  description?: string;
  optional?: boolean;
  // Type system
  type?: ChainInputType;       // default: "string"
  default?: string;            // default value (used if input not provided)
  placeholder?: string;        // hint text in UI
  // Enum/select
  enum?: string[];             // valid values for enum type
  enum_labels?: Record<string, string>; // display labels for enum values
  // Validation
  pattern?: string;            // regex pattern for validation
  min_length?: number;         // minimum string length
  max_length?: number;         // maximum string length
  min?: number;                // minimum number value
  max?: number;                // maximum number value
  // File/image constraints
  accepts?: string[];          // MIME types or extensions: [".pdf", ".csv", "image/*"]
  max_file_size?: number;      // max file size in bytes (default: 10MB)
  // UX
  examples?: string[];         // example values shown below input
}

export type PreToolType =
  | "current_datetime" | "http_fetch" | "web_search" | "read_file" | "write_file"
  | "bash" | "env_var" | "mcp_call" | "db_query" | "email" | "pdf_generate" | "ocr"
  // Tier 1: Game changers
  | "state_load" | "state_save" | "vector_query" | "vector_index" | "json_parse"
  | "diff_inject" | "notify"
  // Tier 2: Strong differentiation
  | "semantic_cache" | "screenshot" | "sandbox_exec" | "cost_gate" | "ast_parse"
  // Tier 3: Forward-looking
  | "embed_compare" | "graph_query" | "parallel_fetch" | "template_render" | "approval_request"
  | "image_generate";

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
  // mcp_call
  server?: string;        // MCP server name (from occ-mcp-servers.json)
  tool?: string;          // Tool name on the MCP server
  args?: Record<string, unknown>; // Arguments to pass to the tool
  // http_fetch advanced
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";  // default: GET
  headers?: Record<string, string>;  // custom headers (supports {variables})
  body?: string;          // request body (supports {variables})
  json_path?: string;     // extract JSON path from response (e.g. "data.items[0]")
  // current_datetime
  timezone?: string;          // IANA timezone (default: UTC) e.g. "Europe/Paris", "America/New_York"
  format?: string;            // "iso" (default) | "locale" | "unix"
  // read_file / write_file
  encoding?: string;          // default: "utf-8". Supports any Node.js encoding
  append?: boolean;           // write_file: append instead of overwrite (default: false)
  // bash
  stderr?: boolean;           // capture stderr too (default: false — stdout only)
  // env_var
  default_value?: string;     // fallback if env var not set (default: "")
  // db_query
  connection?: string;        // connection string (supports {variables})
  sql?: string;               // SQL query (supports {variables})
  // email
  to?: string;                // recipient email (supports {variables})
  subject?: string;           // email subject (supports {variables})
  from?: string;              // sender email
  provider?: string;          // "smtp" | "sendgrid" | "resend" (default: smtp)
  smtp_host?: string;         // SMTP server host
  smtp_port?: number;         // SMTP server port
  // pdf_generate
  html?: string;              // HTML content to convert (supports {variables})
  output_path?: string;       // where to save PDF (supports {variables})
  // ocr
  image_path?: string;        // path to image file (supports {variables})
  language?: string;          // OCR language (default: "eng")
  // state_load / state_save
  key?: string;               // state key name (supports {variables})
  value?: string;             // state_save: value to persist (supports {variables})
  scope?: string;             // scope: chain name or "global" (default: current chain)
  default?: string;           // state_load: default if key not found
  // vector_query / vector_index
  collection?: string;        // vector collection name
  top_k?: number;             // vector_query: number of results (default: 5)
  source?: string;            // vector_index: text to index (supports {variables})
  chunk_size?: number;        // vector_index: chunk size in chars (default: 512)
  // json_parse
  input?: string;             // json_parse: variable to parse (supports {variables})
  // diff_inject
  repo?: string;              // diff_inject: repo path (supports {variables})
  base?: string;              // diff_inject: base ref (default: "main")
  head?: string;              // diff_inject: head ref (default: "HEAD")
  max_tokens?: number;        // diff_inject: max output size (default: 4000)
  // notify
  channel?: string;           // notify: "slack" | "discord" | "telegram" | "webhook"
  webhook_url?: string;       // notify: webhook URL (supports {variables})
  message?: string;           // notify: message text (supports {variables})
  // semantic_cache
  similarity_threshold?: number; // semantic_cache: 0-1 threshold (default: 0.85)
  // screenshot
  viewport?: { width: number; height: number }; // screenshot: viewport size
  wait_ms?: number;           // screenshot: wait after load (default: 3000)
  // sandbox_exec
  image?: string;             // sandbox_exec: Docker image
  mount?: string;             // sandbox_exec: volume mount (host:container)
  // cost_gate
  budget_usd?: number;        // cost_gate: max spend in USD
  action?: string;            // cost_gate: "warn" | "skip" | "downgrade" (default: "warn")
  // ast_parse
  extract?: string[];         // ast_parse: what to extract (functions, classes, imports, exports, types)
  // embed_compare
  text_a?: string;            // embed_compare: first text (supports {variables})
  text_b?: string;            // embed_compare: second text (supports {variables})
  // graph_query
  triples?: Array<{ subject: string; predicate: string; object: string }>; // graph write
  graph_query_subject?: string;  // graph read: query by subject
  graph_query_predicate?: string; // graph read: filter by predicate
  // parallel_fetch
  urls?: string[];            // parallel_fetch: array of URLs
  rate_limit_ms?: number;     // parallel_fetch: delay between requests (default: 100)
  // template_render
  template?: string;          // template_render: Handlebars-style template
  data?: Record<string, unknown>; // template_render: data context
  // approval_request
  title?: string;             // approval_request: approval title
  description?: string;       // approval_request: description
  expires_hours?: number;     // approval_request: expiry (default: 24)
  // image_generate
  image_provider?: "openai" | "huggingface" | "stability"; // image gen provider
  image_model?: string;         // model ID (e.g. "dall-e-3", "gpt-image-1", "black-forest-labs/FLUX.1-schnell")
  image_size?: string;          // e.g. "1024x1024", "512x512"
  image_quality?: string;       // "low" | "medium" | "high" | "standard" | "hd"
  image_style?: string;         // "vivid" | "natural" (OpenAI only)
  negative_prompt?: string;     // what to avoid (HuggingFace/Stability)
  image_format?: "png" | "jpeg" | "webp"; // output format (default: png)
  // Error handling
  on_error?: "inject" | "skip" | "fail"; // What to do when pre-tool fails (default: inject)
  // Timeout & retry (per pre-tool)
  timeout_ms?: number;    // request timeout (default: 30000)
  retry?: number;         // retry count on failure (default: 0)
  // Caching (per pre-tool)
  cache_ttl_minutes?: number; // cache result for N minutes (0 = no cache, default)
  // Execution mode
  parallel?: boolean;     // run in parallel with other parallel:true pre-tools (default: false)
}

export type StepType = "agent" | "router" | "gate" | "evaluator" | "transform" | "loop" | "merge" | "browser" | "subchain" | "debate" | "webhook" | "image_gen";

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
  // Subchain
  chain?: string;                    // subchain: chain name to execute (alias for subchain)
  // Webhook
  url?: string;                      // webhook: URL (alias for webhook_url)
  webhook_url?: string;              // URL to POST to (supports {variables})
  webhook_method?: "POST" | "PUT" | "PATCH" | "GET" | "DELETE";  // default: POST
  webhook_headers?: Record<string, string>;  // custom headers (supports {variables})
  webhook_body?: string;             // body template (supports {variables}) — default: JSON of all vars
  webhook_timeout_ms?: number;       // request timeout (default: 30000)
  webhook_retry?: number;            // retry count on failure (default: 0)
  webhook_success_status?: number[]; // HTTP status codes considered success (default: [200-299])
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
  max_context_chars?: number; // auto-budget: summarize old vars when exceeded (default 50000, 0 = disabled)
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
  summarize_output?: boolean | number;  // true = Haiku summarize, number = truncate to N chars
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
  | { type: "execution_started"; executionId: string; chainName: string; timestamp?: string }
  | { type: "step_started"; executionId: string; stepId: string; label?: string; timestamp?: string }
  | { type: "step_output"; executionId: string; stepId: string; chunk: string; timestamp?: string }
  | { type: "step_done"; executionId: string; stepId: string; durationMs: number; inputTokens?: number; outputTokens?: number; timestamp?: string }
  | { type: "step_error"; executionId: string; stepId: string; error: string; timestamp?: string }
  | { type: "step_log"; executionId: string; stepId: string; message: string; level: "info" | "warn" | "error"; timestamp?: string }
  | { type: "execution_done"; executionId: string; result: string; durationMs: number; timestamp?: string }
  | { type: "step_waiting_approval"; executionId: string; stepId: string; prompt: string; timestamp?: string }
  | { type: "execution_error"; executionId: string; error: string; timestamp?: string }
  | { type: "step_cache_hit"; executionId: string; stepId: string; timestamp?: string }
  | { type: "gate_action"; executionId: string; stepId: string; action: string; reason?: string; timestamp?: string };

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
