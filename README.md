# OCC — Orchestrator Chain Chimera

[![npm version](https://img.shields.io/npm/v/occ-orchestrator?color=cb3837&logo=npm)](https://www.npmjs.com/package/occ-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/occ-orchestrator?color=cb3837&logo=npm)](https://www.npmjs.com/package/occ-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/lacausecrypto/OCC/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/OCC/actions)
[![Tests](https://img.shields.io/badge/Tests-3243%20passed-brightgreen)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-28%20tools-purple)](https://modelcontextprotocol.io)
[![REST](https://img.shields.io/badge/REST%20API-102%20endpoints-green)](#rest-api)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#)

**Define chains, not code.** Multi-model LLM workflows in YAML with automatic parallel execution, 30 pre-tools at zero token cost, and 6 LLM providers. [Benchmarked](BENCHMARKS.md): 70% faster and 70% cheaper than naive approaches on complex tasks.

```yaml
steps:
  - id: market
    model: claude-haiku-4-5          # cheap for subtasks
    prompt: "Analyze the market for {input.topic}"
    output_var: market_data
  - id: risks
    model: claude-haiku-4-5
    prompt: "Identify risks for {input.topic}"
    output_var: risk_data
  - id: summary
    model: claude-sonnet-4-6         # smart for synthesis
    depends_on: [market, risks]      # runs after both complete
    prompt: "Executive summary:\n{market_data}\n{risk_data}"
    output_var: report
```

`market` and `risks` run in parallel. `summary` waits for both. No code needed.

<p align="center">
  <img src="demo.gif" alt="OCC Demo" width="720">
</p>

### Why OCC?

| Problem | Solution |
|---------|----------|
| LLM workflows require Python boilerplate | **YAML chains** — declarative, git-friendly, reviewable by non-devs |
| Data collection wastes LLM tokens | **30 pre-tools** — fetch URLs, run bash, query DBs at 0 token cost |
| One model for everything is expensive | **Model routing** — Haiku for subtasks, Sonnet for synthesis = [80% cheaper](BENCHMARKS.md) |
| Sequential execution is slow | **Auto-parallelism** — DAG resolution runs independent steps simultaneously |
| Long workflows crash and lose progress | **SQLite checkpoints** — crash recovery resumes from last completed step |
| No TypeScript alternative to LangChain | **TS native** — `npm install -g occ-orchestrator` |

> **New to OCC?** Read the [Getting Started guide](GETTING_STARTED.md) — first chain running in 5 minutes.

---

## Table of Contents

- [Quick Start](#quick-start) · [Getting Started](GETTING_STARTED.md) · [Architecture](ARCHITECTURE.md) · [FAQ](FAQ.md)
- [Chain Format](#chain-format) — step types, pre-tools, typed inputs
- [Frontend (Chimera)](#frontend-chimera) — canvas, workflow chat, monitor
- [Pipelines](#pipelines) · [BLOB Sessions](#blob-sessions) · [CLI](#cli)
- [REST API](#rest-api) · [Benchmarks](BENCHMARKS.md)
- [Deployment](#deployment) · [Security](SECURITY.md) · [Configuration](#configuration)
- [Examples](#examples) · [Tests](#tests) · [Limitations](#limitations) · [Contributing](#contributing)

---

## Quick Start

### Prerequisites

- **Node.js 20+** · npm 9+
- **Claude CLI** — install and authenticate:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude   # opens browser to authenticate
  ```

> On first launch, a **Setup Check modal** verifies all prerequisites and guides you through fixing any issues.

### Install

```bash
# npm (recommended)
npm install -g occ-orchestrator

# From source
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server && npm install && npm run build
```

### Run

```bash
# Start backend
cd mcp-server && npm run rest        # http://127.0.0.1:4242

# Start frontend (optional)
cd frontend-react && npm install && npm run dev   # http://localhost:5173

# Execute a chain
occ run deep-researcher -i topic="quantum computing"
```

### Docker

```bash
cp .env.example .env   # set OCC_API_KEY
docker compose up      # non-root, cap_drop ALL, read-only FS
```

---

## Chain Format

```yaml
name: my-chain
description: "Research and summarize a topic"

inputs:
  - name: topic
    type: string
    placeholder: "e.g. quantum computing"

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

**Variables:** `{input.topic}` (chain input) · `{research}` (step output) · `{search_results}` (pre-tool injection)

Steps without shared `depends_on` run **in parallel automatically**.

### LLM Providers

| Provider | Access | Best For |
|----------|--------|----------|
| **Claude** (CLI) | Subprocess | Default engine, full MCP tool access |
| **OpenRouter** | HTTP API | 200+ models (Llama, Gemini, Mistral...) |
| **OpenAI** | HTTP API | GPT-4o, o3-mini, o4-mini |
| **Ollama** | Local | Privacy, offline, zero cost |
| **HuggingFace** | HTTP API | Open-source models, free tier |
| **Custom** | OpenAI-compat | Groq, Together, any compatible endpoint |

All providers support tool use (Bash, Read, Write, Glob, Grep, WebSearch, WebFetch) via an OpenAI function calling agent loop.

### Step Types (12)

| Type | Description |
|------|-------------|
| **agent** | LLM call (default) |
| **router** | Branch based on LLM classification |
| **evaluator** | Score output, trigger retries on failure |
| **gate** | Pause for human approval |
| **transform** | Data manipulation without LLM (json_extract, regex, template...) |
| **loop** | Iterate over items with parallel execution |
| **merge** | Combine parallel outputs (concatenate, llm_summarize, pick_best) |
| **browser** | Web automation via Playwright |
| **subchain** | Execute another chain as a step |
| **debate** | Multi-agent discussion with voting/consensus |
| **webhook** | HTTP callback with retry |
| **image_gen** | Generate images via DALL-E 3, FLUX, or Stability AI |

### Pre-Tools (30)

Inject data **before** the LLM call — 0 tokens for data collection. All support `{variable}` interpolation, `on_error`, `timeout_ms`, `retry`, `cache_ttl_minutes`.

<details>
<summary>Full list</summary>

**Data:** `http_fetch` · `web_search` · `mcp_call` · `db_query` · `parallel_fetch`

**Files:** `read_file` · `write_file` · `bash` · `diff_inject` · `ast_parse` · `ocr` · `screenshot` · `pdf_generate`

**State:** `state_load` · `state_save` · `vector_query` · `vector_index` · `semantic_cache` · `graph_query`

**Processing:** `json_parse` · `template_render` · `embed_compare` · `cost_gate` · `current_datetime`

**Notifications:** `notify` (Slack/Discord/Telegram) · `email` (SMTP/SendGrid/Resend) · `approval_request`

**System:** `env_var` · `sandbox_exec` (Docker) · `image_generate` (DALL-E 3 / FLUX / SD3)

</details>

### Typed Inputs (9 types)

```yaml
inputs:
  - name: topic
    type: string
    min_length: 3
    examples: ["AI safety", "climate change"]
  - name: format
    type: enum
    enum: [markdown, openapi, jsdoc]
    default: markdown
  - name: depth
    type: number
    min: 1
    max: 10
  - name: verbose
    type: boolean
    default: "false"
  - name: banner
    type: image
    accepts: ["image/png", "image/jpeg"]
    max_file_size: 5242880
    optional: true
```

Types: `string` · `number` · `boolean` · `enum` · `file` · `image` · `json` · `url` · `text`

The frontend renders specialized widgets: dropdowns, toggles, file pickers with preview, range inputs, textareas with character counter.

### Advanced Config

```yaml
retry: { max: 3, delay_ms: 2000, backoff: 2 }
fallback_models: ["claude-opus-4-6"]
timeout_ms: 60000
cache: { enabled: true, ttl_minutes: 60 }
condition: '{type} == "frontend"'
output_schema: json
guardrails: [{ type: min_length, value: 500 }]
```

---

## Frontend (Chimera)

### Canvas Editor
- Visual DAG editor with drag, connect, and inline step editing
- Live SSE streaming per node with traffic light status dots
- Save chain (Ctrl+S), version history with diff + restore
- Blueprints — save and reuse step groups

### Workflow Chat
- Conversational chain builder — describe what you want, AI creates nodes
- Agentic actions: run, stop, debug, analyze, dry-run, modify steps
- Multi-session per chain, configurable model per stage
- Markdown rendering, token tracking, persisted to localStorage

### Monitor
- Real-time execution tracking with step timeline
- Gate approval panel — approve/reject from the UI
- Error messages inline, historical execution loading

### Settings
- LLM provider management (add/remove/test)
- Ollama model marketplace — pull, delete, use in chains
- HuggingFace model browser — 118+ models, tier filters
- Setup Check — verify all prerequisites at any time
- Token usage charts, queue stats, server config

---

## Pipelines

Orchestrate multiple chains:

```yaml
name: full-security-review
chains:
  - id: static-analysis
    chain: security-audit
    inputs: { path: "{input.repo_path}" }
  - id: dependency-check
    chain: dependency-scanner
    inputs: { path: "{input.repo_path}" }
  - id: final-report
    chain: report-generator
    depends_on: [static-analysis, dependency-check]
    inputs: { audit: "{static-analysis}", deps: "{dependency-check}" }
output: final-report
```

## BLOB Sessions

Autonomous exploratory AI canvas. Unlike chains (predefined), BLOB sessions grow organically from conversations. Three-stage pipeline: chat (Haiku) → plan (Sonnet) → execute (Sonnet with tools). Features: branching, knowledge graph auto-extraction, autonomous mode with budget guard.

## CLI

17 commands:

```bash
occ validate ./chains                    # Lint all chains
occ dry-run deep-researcher -i topic=AI  # Execution plan + cost estimate (0 tokens)
occ run deep-researcher -i topic=AI      # Run + stream logs
occ run-pipeline research-to-content     # Run multi-chain pipeline
occ generate "Monitor BTC price"         # Natural language → chain YAML
occ list | status | logs | timeline | stats | queue | cancel | approve | reject
```

---

## REST API

102 endpoints with Bearer auth, rate limiting, and SSE streaming.

<details>
<summary>Endpoint list</summary>

**Chains:** `GET /chains` · `GET/POST/DELETE /chains/:name` · `GET /chains/:name/stats` · versioning endpoints

**Execution:** `POST /execute/:name` · `GET /executions` · `GET/DELETE /executions/:id` · `GET /executions/:id/stream` (SSE) · `GET /executions/:id/timeline` · `GET /executions/token-usage` · resume/approve endpoints

**Queue:** `GET /queue` · job management · purge

**Scheduling:** CRUD on `/schedules` + toggle + manual run

**Pipelines:** CRUD + execute + versioning

**Providers:** CRUD + `GET /providers/models` + `POST /providers/:id/test`

**BLOB:** 17 endpoints (sessions, chat, plan, execute, branches, knowledge)

**Ollama:** status, models, pull (streaming), delete

**HuggingFace:** model search, info, test

**System:** `/health` · `/config` · `/prerequisites` · `/events` (SSE) · `/mcp-servers` · `/generate-chain` · `/workflow-chat`

</details>

**Auth:** `Authorization: Bearer <key>` — required when `NODE_ENV=production`.

**Rate limiting:** `/execute/*` 20/min · `/generate-chain` 5/min · `/config` 30/min.

---

## Benchmarks

Real execution data from April 2026 — full methodology in [BENCHMARKS.md](BENCHMARKS.md).

### Economy of Scale (10 steps, 4 waves, 3 runs each)

| Approach | Duration | Cost/run | Monthly (100/day) |
|----------|:--------:|:--------:|:-----------------:|
| Sequential, all Sonnet (naive) | 229s | $0.602 | $1,807 |
| Sequential, Haiku+Sonnet (smart) | 97s | $0.121 | $362 |
| **OCC parallel, Haiku+Sonnet** | **69s** | **$0.179** | **$537** |

**vs naive:** 70% faster, 70% cheaper. **Model routing alone:** 80% cost reduction.

### Overhead on Simple Tasks

+14% duration, same tokens, same cost. Worth it for 4+ step workflows.

---

## Deployment

> OCC is single-process, single-user. Not a multi-tenant SaaS.

**Requirements:** 1 vCPU, 1 GB RAM · Node.js 20+ · Claude CLI

**Production env vars:**

```env
NODE_ENV=production
OCC_API_KEY=your-secret-key
OCC_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
REST_HOST=0.0.0.0                        # only behind reverse proxy
CORS_ORIGIN=https://yourdomain.com
```

See [SECURITY.md](SECURITY.md) for the full hardening checklist.

---

## Examples

### Chains (19)

| Chain | Steps | Parallel | Key Features |
|-------|:-----:|----------|-------------|
| `deep-researcher` | 6 | 3-way | web_search, evaluator, merge |
| `content-engine` | 6 | partial | transform, guardrails |
| `competitive-intel` | 4 | loop(3) | loop, merge |
| `code-review` | 8 | 5-way | router, evaluator |
| `security-audit` | 12 | 6-way | router, debate, webhook |
| `incident-response` | 9 | parallel | debate, evaluator, webhook |
| `startup-pitch` | 9 | 3-way | subchain, loop, debate |
| `market-monitor` | 4 | partial | evaluator, conditional |
| `seo-analyzer` | 9 | 3-way | browser, transform |
| `data-pipeline-builder` | 12 | 3+2 | debate, subchain |
| `linkedin-workflow` | 6 | 3-way | state_save, notify, web_search |
| `quick-summarizer` | 4 | 3-way | http_fetch, merge |
| `repo-health-check` | 6 | 5-way | bash pre-tools |
| `multi-lang-translator` | 6 | 5-way | isolation |
| `api-doc-generator` | 6 | 4-way | ast_parse |
| `full-stack-scaffold` | 5 | seq | bash/write, retry, cache |
| `bench-complex` | 10 | 4-wave | Haiku+Sonnet routing benchmark |
| `bench-claude` | 4 | 3-way | provider comparison |
| `bench-ollama` | 4 | 3-way | provider comparison |

### Pipelines (5)

| Pipeline | Chains | Pattern |
|----------|--------|---------|
| `research-to-content` | deep-researcher → content-engine | Sequential |
| `product-intelligence` | competitive-intel → market-monitor | Sequential |
| `full-security-review` | security-audit + code-review | Parallel |
| `startup-launch` | researcher → pitch → content | 3-stage |
| `repo-full-audit` | health + security + docs | 3-way parallel |

---

## Tests

**3243 tests** across 111 files (59 backend + 52 frontend):

```bash
cd mcp-server && npm test       # 2344 backend tests
cd frontend-react && npm test   # 899 frontend tests
```

**Backend:** REST security, pre-tool execution (SSRF, SQL injection, path traversal, shell escaping), executor, gate manager, queue, storage, loader, linter, CLI, providers, blob, scheduler, MCP client, pipeline executor.

**Frontend:** components (RunModal, Settings, ExecResultModal, Sidebar, MonitorSidebar, Timeline, ApprovalPanel, LogViewer), stores (app, blob, shortcuts, workflowChat), utils (canvasToYaml, extractPalette), API client.

---

## Limitations

- **Single machine** — no distributed execution. SQLite, not Redis.
- **No multi-tenant** — single API key, no per-user isolation.
- **No built-in TLS** — use nginx/Caddy as reverse proxy.
- **Non-Claude models** — tool use via agent loop, not native MCP.
- **Bash pre-tool** — can execute arbitrary commands. Review YAML before running untrusted chains.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OCC_API_KEY` | — | Bearer auth key (required in prod) |
| `OCC_ENCRYPTION_KEY` | — | Provider API key encryption (required in prod) |
| `REST_PORT` | `4242` | HTTP port |
| `REST_HOST` | `127.0.0.1` | Bind address |
| `CORS_ORIGIN` | localhost | Allowed origin |
| `CLAUDE_CLI` | `claude` | CLI binary path |
| `CLAUDE_TIMEOUT_MS` | `1800000` | Per-step timeout (30 min) |
| `MAX_CONCURRENT_EXECUTIONS` | `5` | Worker pool size |
| `EXECUTION_MAX_AGE_DAYS` | `7` | Auto-purge threshold |
| `LOG_LEVEL` | `info` | debug / info / warn / error |

---

## Contributing

Contributions welcome. [Open an issue](https://github.com/lacausecrypto/OCC/issues) first.

1. Fork → branch → `cd mcp-server && npm test` → PR
2. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style and guidelines

## License

MIT — see [LICENSE](LICENSE)
