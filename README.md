# OCC — Claude Chain Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/lacausecrypto/OCC/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/OCC/actions)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-28%20tools-purple)](https://modelcontextprotocol.io)
[![Pre--tools](https://img.shields.io/badge/Pre--tools-29%20types-orange)](#pre-tools)
[![REST](https://img.shields.io/badge/REST%20API-95%20endpoints-green)](#rest-api)
[![Tests](https://img.shields.io/badge/Tests-1777%20passed-brightgreen)](#tests)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#)
[![SQLite](https://img.shields.io/badge/Storage-SQLite%20WAL-003B57?logo=sqlite&logoColor=white)](#)
[![Claude](https://img.shields.io/badge/Powered%20by-Claude-cc785c?logo=anthropic&logoColor=white)](https://claude.ai)

Multi-step workflow orchestrator for Claude. Define chains in YAML, run them with parallel execution and dependency resolution, build visually in the React canvas editor, access via MCP, REST API, or CLI.

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

OCC is a **Claude-focused** workflow engine. It takes a YAML file describing a multi-step task, figures out which steps can run in parallel based on dependencies, runs LLM calls (via `claude --print` or HTTP providers), and streams results back via SSE.

It also supports **non-Claude providers** (OpenRouter, OpenAI, Groq, Mistral, Together AI, any OpenAI-compatible API) via the built-in provider system, making it usable with 200+ models while keeping Claude as the primary engine.

**What it does:**
- Declarative YAML chains — no Python, no code to write
- Automatic parallel execution from dependency graph
- 11 step types (agent, router, evaluator, gate, transform, loop, merge, browser, subchain, debate, webhook)
- 29 pre-tool types inject data before LLM calls (HTTP, MCP, SQL, files, git diff, OCR, vector search, knowledge graph...)
- Per-step model selection, caching, retry with fallback, output validation, guardrails
- SQLite persistence with per-step checkpointing and crash recovery
- Priority job queue with configurable worker pool
- 17-command CLI with dry-run (cost estimate, 0 tokens) and chain linting
- MCP bidirectional: exposes 28 tools AND consumes external MCP servers
- React frontend (Chimera) with canvas chain editor, live execution monitor, BLOB sessions
- Workflow Chat: conversational chain builder with multi-session management per chain
- Chain/pipeline versioning with diff, restore, and history tracking
- Knowledge graph with concept extraction and cross-session memory
- Scheduled execution via cron expressions
- Multi-chain pipelines with inter-chain dependency resolution
- Gate/approval system for human-in-the-loop workflows
- Multi-provider LLM support (Claude, OpenRouter, OpenAI, custom endpoints)
- Configurable keyboard shortcuts
- Design Space: extract website styles via headless browser (Playwright) for theme blending
- Context management: auto-budget compression, pipeline summarization, BLOB enrichment

**What it doesn't do:**
- No distributed execution across multiple machines (single-process, single-node)
- No built-in user management or multi-tenant isolation
- No OpenAPI/Swagger auto-generated docs
- No built-in TLS (use a reverse proxy for HTTPS)

## Quick Start (Local)

### Prerequisites
- **Node.js 20+** (22 recommended)
- **Claude CLI** installed and authenticated (`claude --version`)
- npm 9+

### Install & Run

```bash
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server
npm install && npm run build
npm run rest
# Server on http://127.0.0.1:4242
```

The server binds to **127.0.0.1 by default** (localhost only). This is safe for local use without authentication.

### Run the Frontend

```bash
cd frontend-react
npm install
npm run dev
# Vite dev server on http://localhost:5173
```

### Docker

```bash
cp .env.example .env
# Edit .env — set OCC_API_KEY for authentication
docker compose up
```

> The Docker container runs as non-root with `cap_drop: ALL`, `no-new-privileges`, and read-only filesystem.

### MCP Setup (Claude Code / Claude Desktop)

```bash
cp .mcp.json.example .mcp.json  # edit paths
cd mcp-server && npm start
```

### First Execution

```bash
# Via CLI
occ run deep-researcher --input topic="quantum computing"

# Via REST API
curl -X POST http://localhost:4242/execute/deep-researcher \
  -H "Content-Type: application/json" \
  -d '{"input": {"topic": "quantum computing"}}'
```

## Deployment on a VPS

> OCC is designed for local or single-user deployment. It is **not** a multi-tenant SaaS.

### Minimum Requirements
- 1 vCPU, 1 GB RAM (2 GB recommended for concurrent executions)
- Node.js 20+, Claude CLI authenticated
- Reverse proxy (nginx/Caddy) for TLS

### Step-by-Step

```bash
# 1. Clone and build
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server
npm ci && npm run build

# 2. Configure
cp ../.env.example ../.env
```

Edit `.env` with **mandatory production settings**:

```env
# REQUIRED in production (server refuses to start without these)
NODE_ENV=production
OCC_API_KEY=your-secret-api-key-here

# REQUIRED for API key encryption
OCC_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Network — 0.0.0.0 ONLY behind a reverse proxy
REST_HOST=0.0.0.0
REST_PORT=4242
CORS_ORIGIN=https://yourdomain.com
```

```bash
# 3. Reverse proxy (nginx example)
# /etc/nginx/sites-available/occ
server {
    listen 443 ssl;
    server_name occ.yourdomain.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4242;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        # SSE support
        proxy_buffering off;
        proxy_cache off;
    }
}

# 4. Start
NODE_ENV=production node dist/rest.js

# Or with systemd, PM2, Docker, etc.
```

### Production Security Checklist

- [ ] `OCC_API_KEY` is set (server exits without it in production)
- [ ] `OCC_ENCRYPTION_KEY` is set (unique per installation, for LLM provider API key encryption)
- [ ] `REST_HOST=0.0.0.0` only behind a reverse proxy with TLS
- [ ] `CORS_ORIGIN` set to your exact domain (not `*`)
- [ ] Reverse proxy handles TLS (OCC has no built-in HTTPS)
- [ ] Firewall blocks port 4242 from public access (only proxy connects)
- [ ] `LOG_LEVEL=info` (not `debug` in production)
- [ ] Review chain YAML files for `bash` and `db_query` pre-tools — they execute commands

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
| **gate** | Pause for human approval via API (configurable timeout, auto-approve conditions) |
| **transform** | Data manipulation without LLM (json_extract, regex, truncate, template, split, merge, etc.) |
| **loop** | Iterate over items with parallel execution and exit conditions |
| **merge** | Combine parallel outputs (concatenate, json_array, llm_summarize, pick_best) |
| **browser** | Web automation via Playwright (navigate, click, extract, screenshot) |
| **subchain** | Execute another chain as a step with input mapping |
| **debate** | Multi-agent discussion with voting, consensus, or last-round decision |
| **webhook** | HTTP callback with configurable method, headers, body, retry, status codes |

### Pre-Tools

29 pre-tool types inject data before LLM calls. All support `{variable}` interpolation, `on_error` (inject/skip/fail), `timeout_ms`, `retry`, `cache_ttl_minutes`, and `parallel` execution.

**Data fetching:**
```yaml
pre_tools:
  - type: http_fetch           # Full HTTP client (GET/POST/PUT/DELETE, headers, auth, json_path extraction)
  - type: web_search           # Claude web search
  - type: mcp_call             # External MCP server (GitHub, Slack, PostgreSQL...)
  - type: db_query             # SQL queries (SQLite via parameterized queries, PostgreSQL, MySQL)
  - type: parallel_fetch       # Batch URLs with rate limiting
```

**Files & code:**
```yaml
  - type: read_file            # Read file (symlink-safe, path traversal protected)
  - type: write_file           # Write file (append mode, encoding, path validated)
  - type: bash                 # Shell command (variable sanitization, stderr capture, timeout)
  - type: diff_inject          # Git diff — structured, LLM-optimized
  - type: ast_parse            # Code structure extraction (functions, classes, imports)
  - type: ocr                  # Image to text (Tesseract)
  - type: screenshot           # URL to screenshot (Playwright)
  - type: pdf_generate         # HTML to PDF (wkhtmltopdf/Chrome)
```

**State & memory:**
```yaml
  - type: state_load           # Load persistent state from previous runs
  - type: state_save           # Save state for future runs
  - type: vector_query         # Semantic search (SQLite FTS5 with real embeddings)
  - type: vector_index         # Index text into vector store
  - type: semantic_cache       # Cache by semantic similarity, not exact match
  - type: graph_query          # Knowledge graph (triples: subject, predicate, object)
```

**Data processing:**
```yaml
  - type: json_parse           # Extract JSON path from LLM output
  - type: template_render      # Handlebars-style templates (each, if/else, helpers)
  - type: embed_compare        # Compare two texts — cosine similarity + drift detection
  - type: cost_gate            # Check token budget, skip/warn/downgrade if over
  - type: current_datetime     # Timestamp (configurable timezone + format)
```

**Notifications & human-in-the-loop:**
```yaml
  - type: notify               # Slack, Discord, Telegram, or generic webhook
  - type: email                # SMTP, SendGrid, or Resend
  - type: approval_request     # Generate approval gate for human review
```

**System:**
```yaml
  - type: env_var              # Environment variable (with allowlist — sensitive vars blocked)
  - type: sandbox_exec         # Docker container execution (isolated, mount optional)
```

### Advanced Step Configuration

```yaml
# Retry with exponential backoff and model fallback
retry: { max: 3, delay_ms: 2000, backoff: 2 }
fallback_models: ["claude-opus-4-6", "claude-haiku-4-5"]

# Per-step timeout
timeout_ms: 60000

# Output validation
output_schema: json
output_must_contain: ["conclusion", "sources"]
output_must_not_contain: ["I don't know"]
output_max_length: 5000

# Guardrails
guardrails:
  - type: min_length
    value: 500
  - type: json_valid

# Caching (skip LLM if same prompt seen recently)
cache: { enabled: true, ttl_minutes: 60 }

# Conditional execution
condition: '{type} == "frontend"'

# Early exit — stop chain if condition met
early_exit_if: '{done} == "true"'

# Working directory for file operations
cwd: /path/to/project
```

## Frontend (Chimera)

OCC includes a React frontend with:

- **Dashboard** — chain/pipeline list, execution history, token usage charts
- **Canvas Editor** — visual DAG editor for chains (drag, connect, double-click to edit)
  - Step configuration: model, tools, pre-tools, prompt, type-specific fields
  - Advanced config: retry, fallback models, timeout, caching, output validation, guardrails
  - Type-specific panels for gate, router, evaluator, transform, loop, merge, browser, subchain, debate, webhook
  - Run readiness validation with glass tooltip (checks: server online, prompts filled, steps wired)
  - Apple-style mini terminal SSE per node: live streaming output, traffic light dots, auto-fade
  - Save chain to backend with Ctrl+S shortcut
- **Workflow Chat** — conversational chain builder with glass popover UI
  - Multi-session management per chain/pipeline (create, rename, delete, switch)
  - Sessions fully isolated: chain A's chats never leak into chain B
  - Persisted to localStorage — survives page refresh
  - Configurable chat and planner LLM models + system prompts
  - Animated message flow: slide-in animations, progress bar, Unicode thinking loader (15 phases)
  - Two-stage AI: fast chat (Haiku) → smart planner (Sonnet) creates canvas nodes
- **Live Monitor** — SSE-powered execution tracking with step timeline, log viewer
  - Gate approval panel — approve/reject pending gates directly from the UI
  - Auto-purge stale executions (5min timeout for ghost "running" entries)
  - Historical execution loading from backend on connect
  - Error messages displayed inline on execution cards
- **BLOB Sessions** — autonomous multi-model planning canvas with knowledge graph (see below)
- **Settings** — LLM providers, MCP servers, schedules, queue stats, server config, cache management
  - InfoTips with explanations throughout settings panels
  - Responsive TOC (horizontal pill bar on mobile)
- **Blueprints** — save and reuse step groups across chains
- **Version History** — chain/pipeline versioning with diff view and restore
- **Design Space** — extract website CSS/colors via headless browser (Playwright) for theme blending
- **Keyboard Shortcuts** — configurable keybindings for common actions

## Pipeline Format

Pipelines orchestrate multiple chains with their own dependency graph:

```yaml
name: full-security-review
description: "Multi-chain security audit pipeline"
version: "1.0"

inputs:
  - name: repo_path
    description: "Path to the repository to audit"

chains:
  - id: static-analysis
    chain: security-audit
    inputs:
      path: "{input.repo_path}"

  - id: dependency-check
    chain: dependency-scanner
    inputs:
      path: "{input.repo_path}"

  - id: final-report
    chain: report-generator
    depends_on: [static-analysis, dependency-check]
    inputs:
      audit_result: "{static-analysis}"
      deps_result: "{dependency-check}"

output: final-report
```

Chains without shared `depends_on` run in parallel. Each chain is an independent execution with its own steps, pre-tools, and error handling.

```bash
# Run a pipeline
occ run-pipeline full-security-review --input repo_path=/my/project

# Or via REST
curl -X POST http://localhost:4242/pipelines/full-security-review/execute \
  -H "Content-Type: application/json" \
  -d '{"input": {"repo_path": "/my/project"}}'
```

## BLOB Sessions

BLOB (Branch-Linked Organic Builder) is an autonomous canvas for exploratory AI workflows. Unlike chains (which are predefined), BLOB sessions grow organically from conversations.

**How it works:**
1. You chat with the BLOB — describe what you want to explore
2. The **planner** (Sonnet) analyzes your request and generates a graph plan: new branches, steps, knowledge updates
3. Each step is **executed** (Sonnet) with streaming output
4. **Knowledge extraction** automatically captures concepts, facts, and relationships into a persistent knowledge graph
5. The knowledge graph feeds back into future planning — the BLOB learns across sessions

**Architecture (3 models, 3 stages):**

| Stage | Model | Purpose |
|-------|-------|---------|
| Chat | Haiku (fast) | Understand user intent, ask clarifications, respond conversationally |
| Plan | Sonnet (smart) | Generate graph structure: branches, steps, knowledge updates, reuse decisions |
| Execute | Sonnet | Run each step with tools, produce output, extract knowledge |

**Key features:**
- **Branching** — topics spawn branches with multiple steps (research, analysis, synthesis)
- **Reuse** — the planner detects when a new request relates to an existing branch and forks it instead of creating a duplicate
- **Knowledge graph** — concepts and facts are extracted from every step output, linked together, and injected into future prompts
- **Autonomous mode** — the BLOB can self-trigger planning and execution on a configurable interval (budget-guarded)
- **Custom prompts** — both the chat and planner system prompts are fully editable per session

**REST API:**
```bash
# Create a session
curl -X POST http://localhost:4242/blobs -H "Content-Type: application/json" \
  -d '{"name": "My Research"}'

# Chat
curl -X POST http://localhost:4242/blobs/{id}/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Research quantum computing advances in 2026"}'

# Plan (generates graph nodes)
curl -X POST http://localhost:4242/blobs/{id}/plan \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "...", "userMessage": "...", "existingBranches": [], "knownConcepts": []}'

# Execute a step (SSE stream)
curl -X POST http://localhost:4242/blobs/{id}/execute-step \
  -H "Content-Type: application/json" \
  -d '{"stepType": "agent", "prompt": "...", "tools": ["WebSearch"]}'
```

**Configuration:**
| Variable | Default | Description |
|----------|---------|-------------|
| `BLOB_PLANNING_MODEL` | `claude-sonnet-4-6` | Model for graph planning |
| `BLOB_CHAT_MODEL` | `claude-haiku-4-5` | Model for conversational chat |
| `BLOB_STEP_MODEL` | `claude-sonnet-4-6` | Model for step execution |
| `BLOB_AUTO_CHECK_SEC` | `60` | Autonomous mode check interval |

## Scheduled Execution

Chains and pipelines can be scheduled with cron expressions:

```bash
# Via REST API
curl -X POST http://localhost:4242/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "chainName": "daily-monitor",
    "cron": "0 9 * * *",
    "label": "Morning check",
    "enabled": true,
    "input": {"topic": "market trends"}
  }'
```

**Cron format:** `minute hour day month weekday` (standard 5-field cron)

| Example | Schedule |
|---------|----------|
| `0 9 * * *` | Daily at 9:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 9,18 * * *` | Daily at 9:00 AM and 6:00 PM |
| `0 0 1 * *` | First of every month |

The frontend Settings page includes a visual schedule builder with presets.

**REST endpoints:** `GET /schedules`, `POST /schedules`, `PUT /schedules/:id`, `PATCH /schedules/:id/toggle`, `POST /schedules/:id/run` (trigger now), `DELETE /schedules/:id`

## Knowledge Graph

OCC maintains a persistent knowledge graph that stores concepts, facts, and relationships extracted from chain and BLOB executions.

```bash
# Search knowledge
curl http://localhost:4242/knowledge?q=quantum

# Add a concept
curl -X POST http://localhost:4242/knowledge \
  -H "Content-Type: application/json" \
  -d '{"concept": "Quantum Computing", "facts": ["Uses qubits", "Exponential speedup for specific problems"]}'

# Link two concepts
curl -X POST http://localhost:4242/knowledge/link \
  -H "Content-Type: application/json" \
  -d '{"fromId": "abc", "toId": "def", "relation": "related_to"}'

# Auto-extract concepts from text
curl -X POST http://localhost:4242/knowledge/extract \
  -H "Content-Type: application/json" \
  -d '{"text": "Quantum computing uses qubits to...", "sessionId": "..."}'
```

Knowledge entries are automatically injected into BLOB planning prompts via keyword matching and graph traversal (BFS, depth 2, top 10 entries by relevance score).

## CLI

17 commands, offline and online:

```bash
# Offline (no server needed)
occ validate ./chains                    # Lint all chains
occ dry-run deep-researcher -i topic=AI  # Execution plan + cost estimate (0 tokens)

# Execution
occ run deep-researcher -i topic=AI      # Run + stream logs
occ run deep-researcher -i topic=AI -p 10  # With priority
occ run-pipeline research-to-content -i topic=AI
occ generate "Monitor BTC, alert if >5% change"  # NL to chain YAML

# Monitoring
occ list | status | logs | timeline | stats | queue

# Control
occ cancel | approve | reject

# All commands support --json for scripting
```

## REST API (95 endpoints)

<details>
<summary>Full endpoint list</summary>

**Chains:** `GET /chains`, `GET /chains/:name`, `GET /chains/:name/stats`, `POST /chains/:name`, `DELETE /chains/:name`, `GET /chains/:name/versions`, `GET /chains/:name/versions/:v`, `DELETE /chains/:name/versions/:v`, `POST /chains/:name/versions/:v/restore`

**Execution:** `POST /execute/:name`, `GET /executions`, `GET /executions/:id`, `GET /executions/:id/stream` (SSE), `GET /executions/:id/timeline`, `GET /executions/token-usage`, `DELETE /executions`, `DELETE /executions/:id`, `POST /executions/:id/resume`

**Queue:** `GET /queue`, `GET /queue/jobs`, `GET /queue/jobs/:id`, `DELETE /queue`, `DELETE /queue/jobs/:id`, `DELETE /queue/purge`

**Gates:** `GET /approvals`, `POST /executions/:id/approve/:stepId`

**Scheduling:** `GET /schedules`, `GET /schedules/:id`, `POST /schedules`, `PUT /schedules/:id`, `PATCH /schedules/:id/toggle`, `POST /schedules/:id/run`, `DELETE /schedules/:id`

**Pipelines:** `GET /pipelines`, `GET /pipelines/:name`, `GET /pipelines/:name/json`, `POST /pipelines/:name`, `DELETE /pipelines/:name`, `POST /pipelines/:name/execute`, `GET /pipeline-executions`, `GET /pipeline-executions/:id`, `GET /pipelines/:name/versions`, `GET /pipelines/:name/versions/:v`, `DELETE /pipelines/:name/versions/:v`, `POST /pipelines/:name/versions/:v/restore`

**LLM Providers:** `GET /providers`, `GET /providers/models`, `GET /providers/:id`, `POST /providers`, `PUT /providers/:id`, `DELETE /providers/:id`, `POST /providers/:id/test`

**MCP Servers:** `GET /mcp-servers`, `PUT /mcp-servers`

**BLOB Sessions:** `GET /blobs`, `POST /blobs`, `GET /blobs/:id`, `PUT /blobs/:id`, `DELETE /blobs/:id`, `PATCH /blobs/:id/autonomous`, `GET /blobs/:id/graph`, `PUT /blobs/:id/graph`, `POST /blobs/:id/message`, `GET /blobs/:id/stats`, `POST /blobs/:id/execute-branch`, `GET /blobs/:id/knowledge`, `POST /blobs/:id/plan`, `POST /blobs/:id/chat`, `POST /blobs/:id/execute-step`, `GET /blobs/:id/auto-plan`, `POST /blobs/:id/test-plan`

**Knowledge Graph:** `GET /knowledge`, `POST /knowledge`, `PUT /knowledge/:id`, `DELETE /knowledge`, `DELETE /knowledge/:id`, `POST /knowledge/link`, `POST /knowledge/extract`

**Workflow Chat:** `POST /workflow-chat`

**Generation:** `POST /generate-chain`, `POST /generate-chain/stream`, `GET /generate-chain/stream/:sessionId`

**Configuration:** `GET /config`, `PUT /config`, `GET /health`

**Utilities:** `GET /events` (global SSE), `GET /proxy`, `GET /yaml-to-json`, `GET /extract-style`, `GET /download`

</details>

### Rate Limiting

| Endpoint | Limit | Key |
|----------|-------|-----|
| `POST /execute/*` | 20/min | API key or IP |
| `POST /generate-chain` | 5/min | API key or IP |
| `GET/PUT /config` | 30/min | API key or IP |
| `*/providers/*` | 30/min | API key or IP |

Rate limits are configurable via `RATE_LIMIT_EXEC` and `RATE_LIMIT_GEN` environment variables.

### Authentication

All endpoints (except `GET /health` and static files) require a Bearer token when `OCC_API_KEY` is set:

```bash
curl -H "Authorization: Bearer your-api-key" http://localhost:4242/chains
```

In production (`NODE_ENV=production`), the server **refuses to start** without `OCC_API_KEY`.

## Architecture

```
Claude Code ──MCP──> MCP Server (28 tools) ──> Executor ──> claude --print / HTTP providers
Browser     ──HTTP──> REST+SSE (:4242)      ──> Queue    ──> SQLite (checkpoints, state, vectors)
React UI    ──HTTP──> 95 endpoints          ──> Scheduler ──> Cron jobs
                                            ──> BLOB     ──> Knowledge Graph
                                            ──> Providers ──> OpenRouter / OpenAI / Custom
```

20 TypeScript modules: executor, executor-steps, executor-utils, claude-runner, pretool-executor, pretool-extras, gate-manager, rest, loader, pipeline-loader, queue, storage, scheduler, linter, utils, mcp-client, providers, blob, logger, types.

## How OCC Compares

| | OCC | LangChain / CrewAI / AutoGen |
|---|---|---|
| **Scope** | Claude-focused workflow orchestrator | General-purpose agent frameworks |
| **Models** | Claude primary + OpenRouter/OpenAI via providers | Any LLM provider |
| **Language** | YAML (no code) | Python (code required) |
| **Frontend** | Built-in React canvas editor + monitor | Separate tools needed |
| **Ecosystem** | MCP native (28 tools + external servers) | Hundreds of integrations |
| **State** | SQLite WAL + knowledge graph + vector store | Varies by tool |
| **Community** | New project | Large established communities |
| **Best for** | Claude users wanting declarative multi-step workflows | Teams needing model-agnostic frameworks |

### Token Efficiency & Benchmarks

OCC saves tokens and time through 4 principles:

1. **Parallel execution** — independent steps run simultaneously. 5 parallel haiku agents complete in ~8s, not ~40s.
2. **Step isolation** — each step receives ONLY its dependencies, not the full conversation history. Token input scales with DAG depth, not total step count.
3. **Pre-tool data injection (0 tokens)** — `bash`, `http_fetch`, `ast_parse` collect data BEFORE the LLM call. The LLM sees only the result, never plans or executes tool calls.
4. **Model routing** — haiku for simple tasks ($0.80/M input), sonnet for synthesis ($3/M), opus for depth ($15/M). 5 haiku calls cost less than 1 sonnet call.

**Dry-run benchmarks** (`occ dry-run` — 0 tokens consumed, shows planned execution):

```
$ occ dry-run quick-summarizer -i url="https://example.com"
  Wave 1 (3 parallel)
    factual    [claude-haiku-4-5]
    critical   [claude-haiku-4-5]
    actionable [claude-haiku-4-5]
  Wave 2
    synthesize [claude-sonnet-4-6] ← factual, critical, actionable
  Steps: 4 (2 waves)
  Total: ~$0.026-$0.075
```

**Comparison: OCC vs single Claude CLI prompt**

| Chain | OCC (parallel) | Claude CLI (sequential) | Savings |
|-------|---------------|------------------------|---------|
| quick-summarizer (3 perspectives) | $0.03, ~12s, 2 waves | $0.15-0.30, ~40s | 4x cheaper, 3x faster |
| repo-health-check (5 scans) | $0.03, ~15s, 2 waves | $0.30-0.80, ~90s | 8x cheaper, 5x faster |
| multi-lang-translator (5 langs) | $0.03, ~8s, 2 waves | $0.10-0.20, ~40s | 3x cheaper, 4x faster |
| api-doc-generator (AST + 4 docs) | $0.05, ~20s, 3 waves | $0.50-1.50, ~200s | 10x cheaper, 10x faster |

Why the difference: Claude CLI accumulates all context in one conversation (each tool call adds to the history). OCC isolates each step — step 5 doesn't pay for step 1's context. Pre-tools extract data with zero LLM tokens (bash scripts, HTTP fetches, AST parsing happen before the LLM call).

See [BENCHMARKS.md](BENCHMARKS.md) for real execution results with actual token counts, wall times, and methodology.

## Example Chains (15 included)

| Chain | Steps | Parallel | Features Used |
|-------|-------|----------|---------------|
| `deep-researcher` | 6 | 3-way | web_search, evaluator, merge |
| `content-engine` | 6 | partial | web_search, transform, guardrails |
| `competitive-intel` | 4 | loop(3) | web_search, loop, merge |
| `code-review` | 8 | 5-way | router, bash/read/grep tools, evaluator |
| `security-audit` | 12 | 6-way | router, bash pre-tools, debate, webhook |
| `incident-response` | 9 | parallel | bash pre-tools, debate, evaluator, webhook |
| `startup-pitch` | 9 | 3-way | subchain, loop, debate, evaluator |
| `full-stack-scaffold` | 5 | seq | bash/write/read tools, retry, cache |
| `market-monitor` | 4 | partial | web_search, evaluator, conditional |
| `seo-analyzer` | 9 | 3-way | browser, http_fetch, transform, webhook |
| `data-pipeline-builder` | 12 | 3+2 | debate, subchain, transform |
| `quick-summarizer` | 4 | 3-way | http_fetch, merge — benchmark chain |
| `repo-health-check` | 6 | 5-way | bash pre-tools (0 tok) — benchmark chain |
| `multi-lang-translator` | 6 | 5-way | isolation prevents cross-contamination |
| `api-doc-generator` | 6 | 4-way | ast_parse (80% token reduction) |

## Example Pipelines (5 included)

| Pipeline | Chains | Pattern |
|----------|--------|---------|
| `research-to-content` | deep-researcher → content-engine | Sequential |
| `product-intelligence` | competitive-intel → market-monitor | Sequential |
| `full-security-review` | security-audit + code-review | Parallel |
| `startup-launch` | deep-researcher → startup-pitch → content-engine | 3-stage |
| `repo-full-audit` | repo-health-check + security-audit + api-doc-generator | 3-way parallel |

## Tests

1777 tests across 49 files:

```bash
cd mcp-server && npm test
```

Coverage: REST security (auth, CORS, rate limiting, error sanitization), pre-tool execution (SSRF protection, SQL injection prevention, path traversal, shell escaping), executor (parallel execution, retry, fallback models), gate manager (timeout, approval), queue (priority, concurrency), storage (SQLite CRUD, checkpoints, crash recovery), loader (YAML validation, Zod schemas, dependency graph), linter (15 chains validated), CLI (17 commands), types, providers, blob, scheduler, MCP client, pipeline loader/executor.

## Limitations (honest assessment)

- **Claude primary** — uses `claude --print` subprocess for Claude models. Non-Claude models work via HTTP providers but don't get MCP tool access.
- **Single machine** — no distributed execution. Queue is SQLite, not Redis. Fine for personal/small team use.
- **No multi-tenant** — single API key, no per-user isolation. Not designed for SaaS deployment.
- **No built-in TLS** — use nginx/Caddy as reverse proxy for HTTPS.
- **Memory** — in-memory execution store + SQLite. Large outputs (>5MB per step) can increase memory usage. Execution history auto-purges after `EXECUTION_MAX_AGE_DAYS`.
- **Frontend is alpha** — the React canvas editor works but is not feature-complete. Some operations still require YAML editing.
- **No undo for executions** — once a chain runs, its side effects (file writes, webhooks, emails) cannot be reversed.
- **Bash pre-tool is powerful** — chains with `bash` pre-tools can execute arbitrary shell commands. Review chain YAML before running untrusted chains.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OCC_API_KEY` | — | **Required in production.** API key for Bearer auth. |
| `OCC_ENCRYPTION_KEY` | — | **Required in production.** Encryption key for stored LLM provider API keys. |
| `NODE_ENV` | — | Set to `production` to enforce auth and encryption key requirements. |
| `REST_PORT` | `4242` | HTTP server port. |
| `REST_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind a reverse proxy. |
| `CORS_ORIGIN` | localhost devs | Allowed CORS origin. Set to your domain in production. |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error. |
| `LOG_FORMAT` | `text` | Log format: text (colored) or json (structured). |
| `CHAINS_DIR` | `../chains` | Chain YAML files directory. |
| `PIPELINES_DIR` | `../pipelines` | Pipeline YAML files directory. |
| `CLAUDE_CLI` | `claude` | Claude CLI binary path (absolute path or `claude`). |
| `CLAUDE_TIMEOUT_MS` | `1800000` | Per-step timeout (30 min default). |
| `MAX_CONCURRENT_EXECUTIONS` | `5` | Worker pool size for parallel step execution. |
| `EXECUTION_MAX_AGE_DAYS` | `7` | Auto-purge old executions from SQLite. |
| `RATE_LIMIT_EXEC` | `20` | Max execution requests per minute. |
| `RATE_LIMIT_GEN` | `5` | Max chain generation requests per minute. |
| `OCC_DB` | `<auto>` | SQLite path for executions + checkpoints. |
| `OCC_QUEUE_DB` | `<auto>` | SQLite path for job queue. |
| `MCP_SERVERS_CONFIG` | `<auto>` | External MCP server config file. |
| `BLOB_PLANNING_MODEL` | `claude-sonnet-4-6` | Model for BLOB planning stage. |
| `BLOB_CHAT_MODEL` | `claude-haiku-4-5` | Model for BLOB chat stage. |
| `BLOB_STEP_MODEL` | `claude-sonnet-4-6` | Model for BLOB step execution. |

## Contributing

Contributions welcome. Open an issue first to discuss.

1. Fork, branch, `cd mcp-server && npm test`, PR.
2. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style and guidelines.

## License

MIT — see [LICENSE](LICENSE)
