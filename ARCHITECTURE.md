# OCC (Orchestrator Chain Chimera) — Architecture

> How OCC turns a YAML file into parallel LLM executions with crash recovery.

## System Overview

```
                          YAML Chain
                              |
                         ┌────┴────┐
                         │  Loader  │  Zod validation + variable resolution
                         └────┬────┘
                              |
                         ┌────┴────┐
                         │  Linter  │  Security warnings, dry-run, cost estimate
                         └────┬────┘
                              |
                    ┌─────────┴─────────┐
                    │   Queue Manager   │  SQLite priority queue, max 5 workers
                    └─────────┬─────────┘
                              |
                    ┌─────────┴─────────┐
                    │     Executor      │  DAG resolution, wave scheduling
                    └─────────┬─────────┘
                              |
              ┌───────────────┼───────────────┐
              |               |               |
         ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
         │ Wave 1  │    │ Wave 2  │    │ Wave 3  │   Parallel step groups
         │ (4 steps│    │ (3 steps│    │ (1 step) │
         │ parallel)│   │ parallel)│   │         │
         └────┬────┘    └────┬────┘    └────┬────┘
              |               |               |
      ┌───────┴───────┐      |               |
      |       |       |      |               |
   ┌──┴──┐┌──┴──┐┌──┴──┐   |               |
   │Pre- ││Pre- ││Pre- │   |          ┌────┴────┐
   │tools││tools││tools│   |          │  LLM    │
   │(0tok)││(0tok)││(0tok)│  |         │ Provider│
   └──┬──┘└──┬──┘└──┬──┘   |          └────┬────┘
      |       |       |      |               |
   ┌──┴──┐┌──┴──┐┌──┴──┐┌──┴──┐      ┌────┴────┐
   │ LLM ││ LLM ││ LLM ││ LLM │      │ Storage │
   └──┬──┘└──┬──┘└──┬──┘└──┬──┘      │  (SQLite│
      |       |       |      |         │  WAL)   │
      └───────┴───────┴──────┘         └─────────┘
              |
         ┌────┴────┐
         │   SSE   │  Real-time streaming to frontend
         │ Events  │
         └─────────┘
```

## Core Modules

```
mcp-server/src/
├── rest.ts              ← 102 REST endpoints + SSE streaming
├── executor.ts          ← Chain execution engine (DAG, waves, retry)
├── claude-runner.ts     ← Claude CLI subprocess management
├── providers.ts         ← 6 LLM providers (Claude, OpenRouter, OpenAI, Ollama, HuggingFace, Custom)
├── pretool-executor.ts  ← 30 pre-tool types (0 LLM tokens)
├── pretool-extras.ts    ← Advanced pre-tools (vectors, embeddings, semantic cache)
├── loader.ts            ← YAML chain parsing + Zod validation
├── linter.ts            ← Chain validation, dry-run, cost estimates
├── storage.ts           ← SQLite WAL persistence + checkpoints
├── queue.ts             ← Priority job queue (max workers configurable)
├── gate-manager.ts      ← Human-in-the-loop approval gates
├── scheduler.ts         ← Cron scheduling for chains/pipelines
├── pipeline-loader.ts   ← Pipeline YAML parsing
├── pipeline-executor.ts ← Multi-chain pipeline execution
├── mcp-client.ts        ← Consume external MCP servers (10K+ tools)
├── blob.ts              ← BLOB visual canvas engine
├── style-extractor.ts   ← Design space style extraction
├── logger.ts            ← Structured logging
├── utils.ts             ← Variable resolution, condition evaluation
├── types.ts             ← TypeScript interfaces + Zod schemas
└── index.ts             ← MCP server entry point (28 tools)
```

## Execution Flow

### 1. Chain Loading

```
YAML file → js-yaml parse → Zod schema validation → Chain object
```

The loader (`loader.ts`) reads YAML, validates against a strict Zod schema (step types, pre-tool types, input types), resolves the chains directory via `fileURLToPath` (handles paths with spaces), and returns a typed `Chain` object.

### 2. DAG Resolution & Wave Scheduling

```
Steps with no depends_on    → Wave 1 (run in parallel)
Steps depending on Wave 1   → Wave 2 (run after Wave 1 completes)
Steps depending on Wave 2   → Wave 3 (run after Wave 2 completes)
...
```

The executor analyzes `depends_on` arrays to build a dependency graph, then groups steps into waves. Steps within a wave have no dependencies on each other and execute simultaneously via `Promise.all`.

**Example:** A 10-step chain with 4 waves:
```
Wave 1: [research_market, research_tech, research_competition, research_risks]  ← 4 parallel
Wave 2: [swot, tech_roadmap, risk_matrix]                                       ← 3 parallel
Wave 3: [score_opportunity, score_risk]                                         ← 2 parallel
Wave 4: [executive_summary]                                                     ← 1 sequential
```

Wall time = max(Wave 1) + max(Wave 2) + max(Wave 3) + Wave 4, not sum of all 10 steps.

### 3. Pre-Tool Execution (0 LLM Tokens)

Before each LLM call, pre-tools gather data without consuming any tokens:

```
Step starts
  → Execute pre-tools in parallel:
      http_fetch: download URL content
      bash: run shell command
      read_file: read local file
      db_query: SQL query
      web_search: search the web
      mcp_call: call external MCP server
      ...28 more types
  → Inject results as variables into prompt
  → Send enriched prompt to LLM
```

This is OCC's biggest cost advantage. A step that needs web data:
- **Without pre-tools:** LLM plans tool call → executes → reads result → 3 extra LLM interactions
- **With pre-tools:** Data collected in 0 tokens, LLM only analyzes

### 4. LLM Provider Routing

```
Step model field → resolveProvider() → Provider-specific execution
                                           |
                    ┌──────────────────────┼──────────────────────┐
                    |                      |                      |
               Claude CLI            OpenAI-compat          Custom HTTP
               (subprocess)          (streaming)            (configurable)
                    |                      |
            stream-json events     SSE chunks + usage
                    |                      |
              Token tracking         Token tracking
              (cache-aware)          (stream_options)
```

Each step can use a different model. The provider is resolved from the model name:
- `claude-haiku-4-5` → Claude CLI subprocess
- `llama3.2:1b` → Ollama (localhost:11434)
- `meta-llama/Llama-3.2-1B-Instruct` → HuggingFace Router
- `gpt-4o` → OpenAI API
- Any OpenRouter model → OpenRouter API

Non-Claude providers use an **agent loop** with OpenAI function calling format, supporting up to 15 tool iterations per step.

### 5. Persistence & Crash Recovery

```
Step completes → saveStepCheckpoint() → SQLite WAL
                                            |
                 Crash occurs here? ────────┘
                                            |
                 Restart → loadCheckpoints() → Resume from last completed step
```

Every step result is persisted to SQLite immediately. If the process crashes mid-execution, restarting will:
1. Load the execution from SQLite
2. Identify which steps completed
3. Skip completed steps
4. Resume from the first incomplete wave

### 6. Queue System

```
POST /execute/chain-name
  → Job enqueued with priority (1-10)
  → Queue checks: workers < MAX_CONCURRENT_EXECUTIONS?
     Yes → Start immediately
     No  → Wait in queue (FIFO within priority)
  → Worker picks job → Executor runs chain → Job marked done
```

Default: 5 concurrent workers. Configurable via `MAX_CONCURRENT_EXECUTIONS`.

## Data Flow: Frontend to Backend

```
React Frontend (port 5173)
     |
     ├── GET /prerequisites     → Setup check modal
     ├── GET /chains            → Chain list for dashboard
     ├── POST /execute/:name    → Start execution
     ├── GET /events (SSE)      → Real-time step progress
     ├── GET /executions/:id    → Execution result + tokens
     ├── POST /workflow-chat    → Chat-based chain builder
     ├── GET /providers         → LLM provider config
     └── PUT /config            → Server configuration
     |
     |  (Vite proxy in dev, direct in production)
     |
REST API (port 4242)
     |
     ├── 102 endpoints
     ├── Bearer auth (optional)
     ├── Rate limiting (configurable)
     └── CORS (configurable)
```

## MCP Bidirectional

```
┌──────────────┐    28 tools    ┌──────────────┐
│ Claude Code  │ ──────────────→│  OCC MCP     │  OCC exposes tools TO Claude
│ / Desktop    │                │  Server      │  (run-chain, list-chains, etc.)
└──────────────┘                └──────┬───────┘
                                       |
                                       |  mcp_call pre-tool
                                       |
                                ┌──────┴───────┐
                                │  External    │  OCC consumes tools FROM
                                │  MCP Servers │  external servers (10K+)
                                └──────────────┘
```

OCC is both an **MCP server** (exposes 28 tools for Claude Code/Desktop to use) and an **MCP client** (chains can call any external MCP server via the `mcp_call` pre-tool).

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 20+ |
| Framework | Express.js |
| Database | better-sqlite3 (WAL mode) |
| Validation | Zod |
| YAML parsing | js-yaml |
| MCP | @modelcontextprotocol/sdk |
| Browser automation | Playwright (optional) |
| Testing | Vitest (3243 tests) |
| Frontend | React + Zustand + CSS Modules |
| Build | tsc + Vite |
