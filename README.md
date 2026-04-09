# OCC — Orchestrator Chain Chimera

[![npm version](https://img.shields.io/npm/v/occ-orchestrator?color=cb3837&logo=npm)](https://www.npmjs.com/package/occ-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/occ-orchestrator?color=cb3837&logo=npm)](https://www.npmjs.com/package/occ-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/lacausecrypto/OCC/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/OCC/actions)
[![Tests](https://img.shields.io/badge/Tests-3243%20passed-brightgreen)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-29%20tools-purple)](https://modelcontextprotocol.io)
[![REST](https://img.shields.io/badge/REST%20API-106%20endpoints-green)](#rest-api)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#)

**Define chains, not code.** Multi-model LLM workflows in YAML with automatic parallel execution, 30 pre-tools at zero token cost, and 6 LLM providers.

<p align="center">
  <img src="demo.gif" alt="OCC Demo" width="720">
</p>

```bash
npm install -g occ-orchestrator
occ run my-chain.yaml -i topic="AI safety"
```

---

| Problem | How OCC solves it |
|---------|-------------------|
| LLM workflows require Python boilerplate | **YAML chains** — declarative, git-friendly, reviewable by non-devs |
| Data collection wastes LLM tokens | **30 pre-tools** — fetch URLs, run bash, query DBs at 0 token cost |
| One model for everything is expensive | **Model routing** — Haiku for subtasks, Sonnet for synthesis = [80% cheaper](BENCHMARKS.md) |
| Sequential execution is slow | **Auto-parallelism** — DAG resolution runs independent steps simultaneously |
| Long workflows crash and lose progress | **SQLite checkpoints** — crash recovery resumes from last completed step |
| No TypeScript alternative to LangChain | **TS native** — single `npm install`, no Python |

> [Getting Started](GETTING_STARTED.md) — first chain running in 5 minutes | [Architecture](ARCHITECTURE.md) | [FAQ](FAQ.md) | [Benchmarks](BENCHMARKS.md)

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Chain Format](#chain-format) — YAML reference, providers, step types, pre-tools, typed inputs
3. [Frontend](#frontend-chimera) — canvas editor, workflow chat, monitor, settings
4. [Pipelines](#pipelines) · [BLOB Sessions](#blob-sessions) · [CLI](#cli)
5. [REST API](#rest-api) — 106 endpoints, Swagger UI, auth
6. [Benchmarks](#benchmarks) — real data, economy of scale
7. [Examples](#examples) — 20 chains, 5 pipelines
8. [Tests](#tests) · [Deployment](#deployment) · [Configuration](#configuration) · [Limitations](#limitations)

---

## Quick Start

**Prerequisites:** Node.js 20+ · Claude CLI (`npm install -g @anthropic-ai/claude-code && claude`)

```bash
npm install -g occ-orchestrator
occ init my-project && cd my-project
occ doctor                                         # check prerequisites
occ start                                          # start server → http://127.0.0.1:4242
occ run hello-world -i topic="quantum computing"   # run your first chain
```

**From source:** `git clone https://github.com/lacausecrypto/OCC.git && cd OCC/mcp-server && npm install && npm run build:all && npm run rest`

**Docker:** `cp .env.example .env && docker compose up`

The dashboard is served automatically at http://localhost:4242 (single server, no separate frontend process needed).

> On first launch, a **Setup Check modal** verifies all prerequisites and helps fix missing dependencies.

---

## Chain Format

```yaml
name: my-chain
inputs:
  - name: topic
    type: string

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

Steps without shared `depends_on` run **in parallel automatically**.

**Variables:** `{input.topic}` (chain input) · `{research}` (step output) · `{search_results}` (pre-tool injection)

### LLM Providers (6)

| Provider | Access | Best For |
|----------|--------|----------|
| **Claude** (CLI) | Subprocess | Default engine, full MCP tool access |
| **OpenRouter** | HTTP API | 200+ models (Llama, Gemini, Mistral...) |
| **OpenAI** | HTTP API | GPT-4o, o3-mini, o4-mini |
| **Ollama** | Local | Privacy, offline, zero cost |
| **HuggingFace** | HTTP API | Open-source models, free tier |
| **Custom** | OpenAI-compat | Groq, Together, any compatible endpoint |

Mix models per step: Haiku for classification, Sonnet for synthesis, Ollama for private data. All non-Claude providers support tool use via OpenAI function calling agent loop.

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

Inject data **before** the LLM call — 0 tokens for data collection.

<details>
<summary>Full list (6 categories)</summary>

**Data:** `http_fetch` · `web_search` · `mcp_call` · `db_query` · `parallel_fetch`

**Files:** `read_file` · `write_file` · `bash` · `diff_inject` · `ast_parse` · `ocr` · `screenshot` · `pdf_generate`

**State:** `state_load` · `state_save` · `vector_query` · `vector_index` · `semantic_cache` · `graph_query`

**Processing:** `json_parse` · `template_render` · `embed_compare` · `cost_gate` · `current_datetime`

**Notifications:** `notify` (Slack/Discord/Telegram) · `email` (SMTP/SendGrid/Resend) · `approval_request`

**System:** `env_var` · `sandbox_exec` (Docker) · `image_generate` (DALL-E 3 / FLUX / SD3)

</details>

All support `{variable}` interpolation, `on_error` (inject/skip/fail), `timeout_ms`, `retry`, `cache_ttl_minutes`.

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
  - name: banner
    type: image
    accepts: ["image/png", "image/jpeg"]
    optional: true
```

Types: `string` · `number` · `boolean` · `enum` · `file` · `image` · `json` · `url` · `text` — the frontend renders specialized widgets (dropdowns, toggles, file pickers, range inputs).

### Advanced Step Config

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

**Canvas Editor** — Visual DAG editor with drag-and-connect, live SSE streaming per node, version history with diff + restore, blueprints.

**Workflow Chat** — Conversational chain builder with agentic actions (run, stop, debug, analyze, dry-run, modify steps). Multi-session, configurable model, markdown rendering.

**Monitor** — Real-time execution tracking, step timeline, gate approval panel, historical execution loading.

**Settings** — LLM providers, Ollama marketplace, HuggingFace browser (118+ models), Setup Check, token usage charts, server config.

---

## Pipelines

Orchestrate multiple chains with their own dependency graph:

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
output: final-report
```

## BLOB Sessions

Autonomous exploratory AI canvas. Three-stage pipeline: chat (Haiku) → plan (Sonnet) → execute (Sonnet with tools). Branching, knowledge graph auto-extraction, autonomous mode with budget guard.

## CLI

20 commands:

```bash
occ validate ./chains                    # Lint all chains
occ dry-run deep-researcher -i topic=AI  # Execution plan + cost estimate (0 tokens)
occ run deep-researcher -i topic=AI      # Run + stream logs
occ run-pipeline research-to-content     # Run multi-chain pipeline
occ generate "Monitor BTC price"         # Natural language → chain YAML
occ list | status | logs | timeline | stats | queue | cancel | approve | reject | health
```

---

## REST API

106 endpoints. **[Interactive docs at /api/docs](http://localhost:4242/api/docs/)** (Swagger UI). Spec: [openapi.yaml](openapi.yaml).

<details>
<summary>Endpoint categories</summary>

| Category | Endpoints | Key routes |
|----------|:---------:|-----------|
| **Chains** | 10 | CRUD, stats, versioning |
| **Executions** | 13 | run, stream (SSE), timeline, token usage, resume, approve |
| **Queue** | 6 | stats, jobs, purge |
| **Schedules** | 6 | CRUD, toggle, manual run |
| **Pipelines** | 12 | CRUD, execute, versioning |
| **Providers** | 6 | CRUD, models, test |
| **BLOB** | 17 | sessions, chat, plan, execute, branches, knowledge |
| **Ollama** | 4 | status, models, pull, delete |
| **HuggingFace** | 3 | search, info, test |
| **Knowledge** | 6 | CRUD, link, extract |
| **Cache** | 3 | stats, clear steps, clear pretools |
| **System** | 20 | health, config, prerequisites, events, MCP, generate, workflow-chat, docs |

</details>

**Auth:** `Authorization: Bearer <key>` (required in production). **Rate limits:** `/execute/*` 20/min · `/generate-chain` 5/min · `/config` 30/min.

---

## Benchmarks

Real execution data — full methodology in [BENCHMARKS.md](BENCHMARKS.md).

| Approach | Duration | Cost/run | Monthly (100/day) |
|----------|:--------:|:--------:|:-----------------:|
| Sequential, all Sonnet (naive) | 229s | $0.602 | $1,807 |
| Sequential, Haiku+Sonnet (smart) | 97s | $0.121 | $362 |
| **OCC parallel, Haiku+Sonnet** | **69s** | **$0.179** | **$537** |

**vs naive:** 70% faster, 70% cheaper. **Model routing alone:** 80% cost reduction. **Overhead on simple tasks:** +14% (worth it for 4+ steps).

---

## Examples

<details>
<summary>20 chains included</summary>

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
| `bench-claude` | 4 | 3-way | provider benchmark (Claude) |
| `bench-ollama` | 4 | 3-way | provider benchmark (Ollama) |
| `bench-huggingface` | 4 | 3-way | provider benchmark (HuggingFace) |

</details>

<details>
<summary>5 pipelines included</summary>

| Pipeline | Chains | Pattern |
|----------|--------|---------|
| `research-to-content` | deep-researcher → content-engine | Sequential |
| `product-intelligence` | competitive-intel → market-monitor | Sequential |
| `full-security-review` | security-audit + code-review | Parallel |
| `startup-launch` | researcher → pitch → content | 3-stage |
| `repo-full-audit` | health + security + docs | 3-way parallel |

</details>

---

## Tests

**3243 tests** across 111 files (59 backend + 52 frontend):

```bash
cd mcp-server && npm test       # 2344 backend tests
cd frontend-react && npm test   # 899 frontend tests
```

---

## Deployment

> Single-process, single-user. Not a multi-tenant SaaS.

**Requirements:** 1 vCPU, 1 GB RAM · Node.js 20+ · Claude CLI

```env
NODE_ENV=production
OCC_API_KEY=your-secret-key
OCC_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
REST_HOST=0.0.0.0                        # only behind reverse proxy
CORS_ORIGIN=https://yourdomain.com
```

See [SECURITY.md](SECURITY.md) for the full hardening checklist.

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

## Limitations

- **Single machine** — no distributed execution. SQLite, not Redis.
- **No multi-tenant** — single API key, no per-user isolation.
- **No built-in TLS** — use nginx/Caddy as reverse proxy.
- **Non-Claude models** — tool use via agent loop, not native MCP.
- **Bash pre-tool** — can execute arbitrary commands. Review YAML before running untrusted chains.

---

## Contributing

Contributions welcome. [Open an issue](https://github.com/lacausecrypto/OCC/issues) first. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE)
