/** Pre-tool field definitions per type — mirrors the original monolith exactly. */

export interface PretoolFieldDef {
  k: string;
  l: string;
  type?: "select" | "bool" | "num" | "textarea";
  opts?: string[];
}

export const PRETOOL_FIELDS: Record<string, PretoolFieldDef[]> = {
  http_fetch: [
    { k: "url", l: "URL" },
    { k: "method", l: "Method", type: "select", opts: ["GET", "POST", "PUT", "DELETE"] },
    { k: "headers", l: "Headers (JSON)" },
    { k: "body", l: "Body" },
    { k: "json_path", l: "JSON Path" },
  ],
  web_search: [{ k: "query", l: "Query" }],
  bash: [
    { k: "command", l: "Command" },
    { k: "stderr", l: "Capture stderr", type: "bool" },
  ],
  read_file: [{ k: "path", l: "File Path" }],
  write_file: [
    { k: "path", l: "File Path" },
    { k: "content", l: "Content" },
    { k: "append", l: "Append", type: "bool" },
  ],
  env_var: [
    { k: "var_name", l: "Variable Name" },
    { k: "default_value", l: "Default" },
  ],
  mcp_call: [
    { k: "server", l: "MCP Server" },
    { k: "tool", l: "Tool Name" },
    { k: "args", l: "Args (JSON)" },
  ],
  db_query: [
    { k: "connection", l: "Connection URL" },
    { k: "sql", l: "SQL Query" },
  ],
  state_load: [
    { k: "key", l: "Key" },
    { k: "scope", l: "Scope" },
    { k: "default", l: "Default" },
  ],
  state_save: [
    { k: "key", l: "Key" },
    { k: "value", l: "Value" },
    { k: "scope", l: "Scope" },
  ],
  vector_query: [
    { k: "collection", l: "Collection" },
    { k: "query", l: "Query" },
    { k: "top_k", l: "Top K", type: "num" },
  ],
  vector_index: [
    { k: "collection", l: "Collection" },
    { k: "source", l: "Source Text" },
    { k: "chunk_size", l: "Chunk Size", type: "num" },
  ],
  json_parse: [
    { k: "input", l: "Input" },
    { k: "json_path", l: "JSON Path" },
  ],
  diff_inject: [
    { k: "repo", l: "Repo Path" },
    { k: "base", l: "Base Ref" },
    { k: "head", l: "Head Ref" },
  ],
  notify: [
    { k: "channel", l: "Channel", type: "select", opts: ["slack", "discord", "telegram", "webhook"] },
    { k: "webhook_url", l: "Webhook URL" },
    { k: "message", l: "Message" },
  ],
  semantic_cache: [
    { k: "query", l: "Query" },
    { k: "similarity_threshold", l: "Threshold", type: "num" },
  ],
  screenshot: [
    { k: "url", l: "URL" },
    { k: "wait_ms", l: "Wait (ms)", type: "num" },
  ],
  sandbox_exec: [
    { k: "image", l: "Docker Image" },
    { k: "command", l: "Command" },
    { k: "mount", l: "Mount" },
  ],
  cost_gate: [
    { k: "budget_usd", l: "Budget ($)", type: "num" },
    { k: "action", l: "Action", type: "select", opts: ["warn", "skip", "downgrade"] },
  ],
  ast_parse: [
    { k: "path", l: "File Path" },
    { k: "extract", l: "Extract (comma sep)" },
  ],
  email: [
    { k: "to", l: "To" },
    { k: "subject", l: "Subject" },
    { k: "content", l: "Content" },
  ],
  embed_compare: [
    { k: "text_a", l: "Text A" },
    { k: "text_b", l: "Text B" },
  ],
  graph_query: [
    { k: "graph_query_subject", l: "Subject" },
    { k: "graph_query_predicate", l: "Predicate" },
  ],
  parallel_fetch: [{ k: "urls", l: "URLs (one per line)", type: "textarea" }],
  template_render: [{ k: "template", l: "Template", type: "textarea" }],
  approval_request: [
    { k: "title", l: "Title" },
    { k: "description", l: "Description" },
    { k: "expires_hours", l: "Expires (hours)", type: "num" },
  ],
  current_datetime: [
    { k: "timezone", l: "Timezone" },
    { k: "format", l: "Format", type: "select", opts: ["iso", "locale", "unix"] },
  ],
  pdf_generate: [
    { k: "html", l: "HTML Content", type: "textarea" },
    { k: "output_path", l: "Output Path" },
  ],
  ocr: [
    { k: "image_path", l: "Image Path" },
    { k: "language", l: "Language" },
  ],
};

export const PRETOOL_TYPES = Object.keys(PRETOOL_FIELDS);

export const TOOL_LIST = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];

export const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];

export const STEP_TYPES = [
  "agent", "router", "evaluator", "gate", "transform",
  "loop", "merge", "webhook", "subchain", "debate", "browser",
];

function cssVar(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}
export function getTypeColors(): Record<string, string> {
  return {
    agent: cssVar("--icon-blue", "#0a84ff"), router: cssVar("--icon-purple", "#bf5af2"),
    evaluator: cssVar("--icon-red", "#ff375f"), gate: cssVar("--icon-orange", "#ff9f0a"),
    transform: cssVar("--icon-purple", "#5e5ce6"), loop: cssVar("--icon-cyan", "#64d2ff"),
    merge: cssVar("--icon-green", "#30d158"), webhook: cssVar("--c-warning", "#ffd60a"),
    subchain: cssVar("--icon-purple", "#6366f1"), debate: cssVar("--icon-pink", "#ff6482"),
    browser: cssVar("--m-text2", "#a1a1aa"),
  };
}
/** @deprecated Use getTypeColors() for live theme colors */
export const TYPE_COLORS: Record<string, string> = {
  agent: "#0a84ff", router: "#bf5af2", evaluator: "#ff375f", gate: "#ff9f0a",
  transform: "#5e5ce6", loop: "#64d2ff", merge: "#30d158", webhook: "#ffd60a",
  subchain: "#6366f1", debate: "#ff6482", browser: "#a1a1aa",
};
