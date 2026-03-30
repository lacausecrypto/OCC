# OCC — Claude Chain Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org)
[![Tests](https://github.com/lacausecrypto/OCC/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/OCC/actions)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)

Workflow orchestrator for Claude. Define multi-step chains in YAML, run them with parallel execution and dependency resolution, access via MCP or REST API.

```
$ occ run deep-researcher --input topic="quantum computing"
[START] Chain: deep-researcher
  [STEP] Mainstream research ...
  [STEP] Contrarian research ...
  [STEP] Academic research ...
  [DONE] search_mainstream (12.3s, 450+1800 tokens)
  [DONE] search_contrarian (14.1s)
  [DONE] search_academic (11.8s)
  [DONE] evaluate_sources (5.2s)
  [DONE] merge_perspectives (8.7s)
  [DONE] synthesize (15.4s)
Done in 47s — 6 steps, 3 parallel
```

## What is OCC?

OCC is a **Claude-specific** workflow engine. It takes a YAML file describing a multi-step task, figures out which steps can run in parallel based on dependencies, spawns `claude --print` processes for each step, and streams results back via SSE.

It is **not** a general-purpose agent framework like LangChain or CrewAI. It doesn't support OpenAI, Gemini, or local models. It's built specifically for people already using Claude who want to orchestrate complex multi-step workflows.

**What it does well:**
- Declarative YAML chains — no Python, no code to write
- Automatic parallel execution from dependency graph
- 11 step types (router, evaluator, gate, transform, loop, merge, browser, subchain, debate, webhook)
- 27 pre-tool types inject data before LLM calls (HTTP, MCP, SQL, files, git diff, OCR, notifications, state, vectors...)
- Per-step model selection, caching, retry with fallback, output validation
- SQLite persistence with per-step checkpointing and crash recovery
- Persistent job queue with priority
- 17-command CLI with dry-run (cost estimate, 0 tokens) and chain linting
- MCP bidirectional: exposes 28 tools AND consumes external MCP servers

**What it doesn't do (yet):**
- No web UI / visual canvas for chain editing
- No multi-model support (Claude only — by design, not a bug)
- No distributed execution across multiple machines (single-process, single-machine)
- No built-in RAG / vector store / knowledge base
- No authentication on the REST API (designed for local use, add a reverse proxy for production)
- No OpenAPI/Swagger auto-generated docs

## Quick Start

```bash
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server
npm install && npm run build
npm run rest
# Server on http://localhost:4242
```

Or with Docker:
```bash
docker compose up
```

Or for Claude Code / Claude Desktop (MCP):
```bash
cp .mcp.json.example .mcp.json  # edit paths
cd mcp-server && npm start
```

Execute a chain:
```bash
curl -X POST http://localhost:4242/execute/deep-researcher \
  -H "Content-Type: application/json" \
  -d '{"input": {"topic": "quantum computing"}}'
```

## Chain Format

```yaml
name: my-chain
description: "What this chain does"
version: "1.0"

inputs:
  - name: topic
    description: "The topic to research"
  - name: depth
    optional: true

steps:
  - id: research
    model: claude-sonnet-4-6
    pre_tools:
      - type: web_search
        query: "{input.topic} latest news"
        inject_as: search_results
    prompt: |
      Research: {input.topic}
      Web results: {search_results}
    output_var: research

  - id: summarize
    depends_on: [research]
    prompt: "Summarize: {research}"
    output_var: summary

output: summary
```

Variables: `{input.topic}` (chain input), `{research}` (step output), `{search_results}` (pre-tool data).

Steps without shared `depends_on` run in parallel automatically.

### Step Types

| Type | Description |
|------|-------------|
| **agent** | LLM call (default) |
| **router** | Branch to different steps based on LLM classification |
| **evaluator** | Score output (1-10 or PASS/FAIL), trigger retries |
| **gate** | Pause for human approval via API (non-blocking, frees worker) |
| **transform** | Data manipulation without LLM (json_extract, regex, truncate, etc.) |
| **loop** | Iterate over items with parallel execution |
| **merge** | Combine parallel outputs (concatenate, summarize, pick_best) |
| **browser** | Web automation via Playwright |
| **subchain** | Execute another chain as a step |
| **debate** | Multi-agent discussion with voting/consensus |
| **webhook** | HTTP callback with configurable method, headers, body, retry, status codes |

### Pre-Tools

27 pre-tool types inject data before LLM calls. All support `{variable}` interpolation, `on_error` (inject/skip/fail), `timeout_ms`, `retry`, `cache_ttl_minutes`, and `parallel` execution.

**Data fetching:**
```yaml
pre_tools:
  - type: http_fetch           # Full HTTP client (GET/POST/PUT, headers, auth, json_path)
  - type: web_search           # Claude web search
  - type: mcp_call             # External MCP server (GitHub, Slack, PostgreSQL...)
  - type: db_query             # SQL queries (PostgreSQL, MySQL, SQLite)
  - type: parallel_fetch       # Batch URLs with rate limiting
```

**Files & code:**
```yaml
  - type: read_file            # Read file (configurable encoding)
  - type: write_file           # Write file (append mode, encoding)
  - type: bash                 # Shell command (stderr capture, timeout)
  - type: diff_inject          # Git diff — structured, LLM-optimized
  - type: ast_parse            # Code structure extraction (functions, classes, imports)
  - type: ocr                  # Image → text (Tesseract)
  - type: screenshot           # URL → screenshot (Playwright)
  - type: pdf_generate         # HTML → PDF (wkhtmltopdf/Chrome)
```

**State & memory:**
```yaml
  - type: state_load           # Load persistent state from previous runs
  - type: state_save           # Save state for future runs
  - type: vector_query         # Semantic search (SQLite FTS5)
  - type: vector_index         # Index text into vector store
  - type: semantic_cache       # Cache by semantic similarity, not exact match
  - type: graph_query          # Knowledge graph (triples: subject→predicate→object)
```

**Data processing:**
```yaml
  - type: json_parse           # Extract JSON path from LLM output
  - type: template_render      # Handlebars-style templates (each, if/else)
  - type: embed_compare        # Compare two texts — similarity + drift detection
  - type: cost_gate            # Check token budget, skip/warn if over
```

**Notifications:**
```yaml
  - type: notify               # Slack, Discord, Telegram, or generic webhook
  - type: email                # SMTP or SendGrid
  - type: approval_request     # Generate approval URL for human-in-the-loop
```

**System:**
```yaml
  - type: env_var              # Environment variable (with default_value)
  - type: current_datetime     # Timestamp (configurable timezone + format)
  - type: sandbox_exec         # Docker container execution (isolated)
```

### Advanced

```yaml
# Retry with model fallback
retry: { max: 3, delay_ms: 2000, backoff: 2 }
fallback_models: ["claude-opus-4-6"]

# Output validation
guardrails:
  - type: min_length
    value: 500
  - type: must_not_contain
    value: "I don't know"

# Caching (skip LLM if same prompt)
cache: { enabled: true, ttl_minutes: 60 }

# Conditional execution
condition: '{type} == "frontend"'

# Early exit
early_exit_if: '{done} == "true"'
```

## CLI

17 commands, offline and online:

```bash
# Offline (no server)
occ validate ./chains                    # Lint chains
occ dry-run deep-researcher -i topic=AI  # Execution plan + cost estimate (0 tokens)

# Execution
occ run deep-researcher -i topic=AI      # Run + stream logs
occ run deep-researcher -i topic=AI -p 10  # With priority
occ run-pipeline research-to-content -i topic=AI
occ generate "Monitor BTC, alert if >5% change"  # NL → chain YAML

# Monitoring
occ list | status | logs | timeline | stats | queue

# Control
occ cancel | approve | reject

# All commands support --json for scripting
```

## REST API (40+ endpoints)

<details>
<summary>Full endpoint list</summary>

**Chains:** `GET /chains`, `GET /chains/:name`, `GET /chains/:name/stats`, `POST /chains/:name`, `DELETE /chains/:name`

**Execution:** `POST /execute/:name`, `GET /executions/:id`, `GET /executions/:id/stream` (SSE), `GET /executions/:id/timeline`, `GET /executions`, `DELETE /executions/:id`, `POST /executions/:id/resume`

**Queue:** `GET /queue`, `GET /queue/jobs`, `GET /queue/jobs/:id`, `DELETE /queue/jobs/:id`, `DELETE /queue/purge`

**Gates:** `GET /approvals`, `POST /executions/:id/approve/:stepId`

**Scheduling:** `GET /schedules`, `GET /schedules/:id`, `POST /schedules`, `PUT /schedules/:id`, `PATCH /schedules/:id/toggle`, `POST /schedules/:id/run`, `DELETE /schedules/:id`

**Pipelines:** `GET /pipelines`, `GET /pipelines/:name`, `GET /pipelines/:name/json`, `POST /pipelines/:name`, `DELETE /pipelines/:name`, `POST /pipelines/:name/execute`, `GET /pipeline-executions`, `GET /pipeline-executions/:id`

**Generation:** `POST /generate-chain`, `POST /generate-chain/stream`, `GET /generate-chain/stream/:sessionId`

**Utilities:** `GET /health`, `GET /mcp-servers`, `GET /download?path=...`

</details>

## Architecture

```
Claude Code ──MCP──▶ MCP Server (28 tools) ──▶ Executor ──▶ claude --print
curl/browser ──HTTP──▶ REST+SSE (:4242)   ──▶ Queue ──▶ SQLite (checkpoints)
```

15 TypeScript modules: executor, rest, loader, queue, storage, scheduler, linter, utils, mcp-client, pretool-extras, pipeline-executor, pipeline-loader, types, index (MCP), CLI.

## How OCC Compares

OCC is **not** a direct competitor to LangChain, CrewAI, or AutoGen. Those are general-purpose multi-model agent frameworks with large ecosystems. OCC is a focused workflow orchestrator for Claude.

| | OCC | LangChain / CrewAI / AutoGen |
|---|---|---|
| **Scope** | Claude workflow orchestrator | General-purpose agent frameworks |
| **Models** | Claude only | Any LLM provider |
| **Language** | YAML (no code) | Python (code required) |
| **Ecosystem** | MCP native | Hundreds of integrations |
| **Community** | New project | Large established communities |
| **Best for** | Claude power users who want declarative multi-step workflows | Teams needing model-agnostic agent frameworks |

**Where OCC makes sense:** you're already using Claude, you want to define repeatable workflows in YAML (not Python), and you value dependency-aware parallel execution, per-step caching, and MCP integration.

**Where it doesn't:** you need multi-model support, a visual editor, distributed execution, or a large ecosystem of pre-built integrations.

### Token Efficiency

OCC's architecture reduces token usage compared to single-prompt or conversation-based approaches:

- **Step isolation** — each step gets only its dependencies, not the full conversation history
- **Transform steps** — `json_extract`, `truncate`, `regex` between steps cost 0 tokens
- **Per-step model** — `claude-haiku-4-5` for classification, `claude-opus-4-6` for synthesis
- **Caching** — identical prompts skip the LLM entirely
- **Conditional execution** — skip irrelevant steps
- **Early exit** — stop when the answer is found

A 6-step research chain typically uses ~15K tokens vs ~40K+ in a single-prompt approach.

## Tests

553 tests across 18 files:

| File | Tests | Coverage |
|------|-------|----------|
| `loader.test.ts` | 97 | YAML parsing, Zod validation, dependency graph |
| `rest.test.ts` | 78 | REST endpoints, input validation, SSE |
| `chains.test.ts` | 48 | All 6 demo chains YAML validation |
| `types.test.ts` | 47 | Zod schema edge cases |
| `cli.test.ts` | 44 | CLI end-to-end (17 commands) |
| `utils.test.ts` | 37 | evaluateCondition, resolveVariables |
| `linter.test.ts` | 32 | Variable detection, dependency checks, dry-run |
| `storage.test.ts` | 27 | SQLite CRUD, checkpointing, crash recovery, stats |
| `pretool-tier1.test.ts` | 20 | State, vector, JSON parse, diff, notify |
| `pretool-tier3.test.ts` | 19 | Embed compare, graph, parallel fetch, template, approval |
| `pretools-new.test.ts` | 17 | MCP call, db_query, email, pdf, ocr pre-tools |
| `queue.test.ts` | 16 | Enqueue, priority, cancellation, retry |
| `webhook.test.ts` | 15 | Webhook step execution, retry, status codes |
| `pretool-tier2.test.ts` | 13 | Semantic cache, screenshot, sandbox, cost gate, AST |
| `concurrency.test.ts` | 12 | Parallel SQLite writes, queue contention, isolation |
| `pretools.test.ts` | 12 | Core pre-tool execution |
| `mcp-client.test.ts` | 11 | Config loading, registration, error handling |
| `scheduler.test.ts` | 8 | Cron scheduling |

Run: `cd mcp-server && npm test`

## Limitations

- **Claude only** — uses `claude --print` subprocess. No OpenAI, no local models.
- **Single machine** — no distributed execution. Queue is SQLite, not Redis.
- **No web UI** — chains are YAML files. No drag-and-drop editor.
- **No authentication** — REST API has no auth layer. Use behind a reverse proxy in production.
- **No RAG** — no built-in vector store or knowledge base. Use pre-tools for data injection.
- **Memory** — in-memory execution store + SQLite. Large outputs (>5MB per step) can increase memory usage.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REST_PORT` | `4242` | HTTP server port |
| `REST_HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | Allowed CORS origin (`https://yourdomain.com` for prod) |
| `CHAINS_DIR` | `../chains` | Chain YAML files directory |
| `PIPELINES_DIR` | `../pipelines` | Pipeline YAML files directory |
| `CLAUDE_CLI` | `claude` | Claude CLI binary path |
| `CLAUDE_TIMEOUT_MS` | `1800000` | Per-step timeout (30 min) |
| `MAX_CONCURRENT_EXECUTIONS` | `5` | Worker pool size |
| `EXECUTION_MAX_AGE_DAYS` | `7` | Auto-purge old executions |
| `OCC_DB` | `<auto>` | SQLite path (executions + checkpoints) |
| `OCC_QUEUE_DB` | `<auto>` | SQLite path (job queue) |
| `MCP_SERVERS_CONFIG` | `<auto>` | External MCP server config |
| `NO_COLOR` | — | Disable ANSI colors |

## Contributing

Contributions welcome. Open an issue first to discuss.

1. Fork → branch → `cd mcp-server && npm test` → PR

## License

MIT — see [LICENSE](LICENSE)
