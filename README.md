# OCC — Claude Chain Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org)
[![Tests](https://github.com/lacausecrypto/OCC/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/OCC/actions)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)

A powerful workflow orchestration engine for Claude AI agents. Define multi-step AI chains in YAML, execute them with parallel processing, dependency resolution, and real-time streaming — all accessible via MCP (Model Context Protocol) or REST API.

```
You:  "Run deep-researcher on quantum computing"
OCC:  ✓ Step 1/6 — Mainstream research      (parallel)
      ✓ Step 2/6 — Contrarian research       (parallel)
      ✓ Step 3/6 — Academic research          (parallel)
      ✓ Step 4/6 — Source evaluation
      ✓ Step 5/6 — Merge perspectives
      ✓ Step 6/6 — Final synthesis
      Done in 47s — 6 steps, 3 parallel
```

## Why OCC?

Claude is great at single-turn tasks. But real work requires **multi-step workflows**: research → analyze → decide → create → validate. OCC orchestrates these pipelines so Claude agents can tackle complex tasks autonomously.

- **YAML-defined chains** — version-controlled, human-readable, git-friendly
- **Dependency-aware execution** — steps run in parallel when possible, sequentially when needed
- **11 step types** — agent, router, evaluator, gate, transform, loop, merge, browser, subchain, debate, webhook
- **Pre-tools** — inject web search results, API data, files, or env vars before each step
- **Retry & fallback** — automatic retries with exponential backoff, fallback to different models
- **Real-time streaming** — SSE events for every step start, output chunk, and completion
- **Scheduling** — cron-based chain execution with toggle on/off
- **Pipelines** — chain multiple chains together with output passing

## Quick Start

### Option A: npm (recommended)

```bash
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server
npm install && npm run build

# Validate your chains
npm run occ -- validate ../chains

# Start the server
npm run rest
```

### Option B: Docker

```bash
git clone https://github.com/lacausecrypto/OCC.git
cd OCC
docker compose up
# Server running on http://localhost:4242
```

### Option C: MCP (for Claude Code / Claude Desktop)

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your absolute paths
cd mcp-server && npm start
```

### Execute your first chain

Via REST:
```bash
curl -X POST http://localhost:4242/execute/deep-researcher \
  -H "Content-Type: application/json" \
  -d '{"input": {"topic": "quantum computing breakthroughs 2026"}}'
```

Via MCP (in Claude Code):
```
Use the run_chain tool: chain name "deep-researcher", inputs: topic = "quantum computing"
```

## Chain Format

Chains are YAML files in the `chains/` directory:

```yaml
name: my-chain
description: "What this chain does"
version: "1.0"

inputs:
  - name: topic
    description: "The topic to research"
  - name: depth
    description: "How deep to go"
    optional: true

steps:
  - id: step_one
    type: agent
    label: "First step"
    model: claude-sonnet-4-6
    pre_tools:
      - type: web_search
        query: "{input.topic} latest news"
        inject_as: search_results
    prompt: |
      Research this topic: {input.topic}
      Web results: {search_results}
    output_var: research

  - id: step_two
    type: agent
    label: "Second step"
    depends_on: [step_one]
    prompt: |
      Summarize: {research}
    output_var: summary

output: summary
```

### Variable Interpolation

- `{input.topic}` — chain input variables
- `{research}` — output from a previous step (by `output_var`)
- `{search_results}` — data injected by pre_tools

### Step Types

| Type | Description |
|------|-------------|
| **agent** | LLM execution — the workhorse. Sends prompt to Claude, returns response |
| **router** | Conditional branching — routes to different steps based on LLM classification |
| **evaluator** | Quality gate — scores output (1-10) or PASS/FAIL, can trigger retries |
| **gate** | Human approval checkpoint — pauses execution until approved via API |
| **transform** | Data manipulation — json_extract, regex, template, split, merge, truncate |
| **loop** | Iteration — runs a step template for each item, with parallel execution |
| **merge** | Combine outputs — concatenate, json_array, llm_summarize, or pick_best |
| **browser** | Web automation — navigate, click, extract, screenshot via Playwright |
| **subchain** | Reuse — execute another chain as a step, mapping inputs/outputs |
| **debate** | Multi-agent — multiple agents debate, then vote or reach consensus |
| **webhook** | HTTP callback — notify external systems on step completion |

### Pre-Tools

Inject data before a step executes:

```yaml
pre_tools:
  - type: web_search
    query: "AI trends 2026"
    inject_as: trends

  - type: http_fetch
    url: "https://api.example.com/data"
    inject_as: api_data

  - type: read_file
    path: "/path/to/context.md"
    inject_as: context

  - type: bash
    command: "git log --oneline -5"
    inject_as: recent_commits

  - type: env_var
    var_name: "API_KEY"
    inject_as: key

  - type: current_datetime
    inject_as: now

  - type: mcp_call
    server: "github"
    tool: "search_repositories"
    args: { query: "{input.topic}" }
    inject_as: repos
```

### External MCP Servers

OCC can consume any MCP server as a pre-tool. Configure servers in `occ-mcp-servers.json`:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
  }
}
```

Then use `mcp_call` in any chain to access 10,000+ MCP tools (GitHub, Slack, PostgreSQL, Brave Search, etc.).

### Advanced Features

**Retry with fallback models:**
```yaml
retry:
  max: 3
  delay_ms: 2000
  backoff: 2
fallback_models: ["claude-opus-4-6", "claude-sonnet-4-6"]
```

**Output validation (guardrails):**
```yaml
guardrails:
  - type: min_length
    value: 500
  - type: must_not_contain
    value: "I don't know"
  - type: json_valid
output_must_contain: ["## Summary"]
output_max_length: 5000
```

**Conditional execution:**
```yaml
condition: '{codebase_type} == "frontend"'
```

**Caching:**
```yaml
cache:
  enabled: true
  ttl_minutes: 60
```

**Early exit:**
```yaml
early_exit_if: '{alert_score} == "no_signal"'
```

## Pipelines

Pipelines chain multiple chains together:

```yaml
name: research-to-content
description: "Research a topic, then write an article about it"

inputs:
  - name: topic

chains:
  - id: research
    chain: deep-researcher
    inputs:
      topic: "{input.topic}"
      depth: "deep"

  - id: content
    chain: content-engine
    depends_on: [research]
    inputs:
      topic: "{input.topic}"
      tone: "professional"

output: content
```

## Included Demo Chains

| Chain | What it demonstrates |
|-------|---------------------|
| **deep-researcher** | Parallel web research from 3 angles, source evaluation, merge, synthesis |
| **code-review** | Router-based classification, parallel specialized reviews, evaluator scoring, conditional steps |
| **content-engine** | Sequential pipeline, transform (json_extract), guardrails, SEO optimization |
| **competitive-intel** | Loop over competitors, parallel analysis, merge strategies, SWOT |
| **full-stack-scaffold** | Tool use (Bash/Write/Read), retry with fallback models, caching, code generation |
| **market-monitor** | Pre-tools (http_fetch), evaluator with threshold, conditional alerts, scheduling-ready |

## REST API

### Chains
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/chains` | List all chains with metadata |
| GET | `/chains/:name` | Get chain YAML |
| GET | `/chains/:name/stats` | Execution stats (success rate, avg duration, tokens) |
| POST | `/chains/:name` | Create/update chain (JSON or YAML body) |
| DELETE | `/chains/:name` | Delete chain |

### Execution
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/execute/:name` | Execute a chain — runs immediately or queues if busy (returns executionId or jobId) |
| GET | `/executions/:id` | Get execution status and full step results |
| GET | `/executions/:id/stream` | SSE stream of real-time execution events (30s heartbeat) |
| GET | `/executions/:id/timeline` | Time-travel: full step checkpoint history from SQLite |
| GET | `/executions` | List all executions (paginated: `?limit=50&offset=0`) |
| DELETE | `/executions/:id` | Cancel a running execution (kills processes) |
| POST | `/executions/:id/resume` | Resume a failed execution from last completed step |

### Queue
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/queue` | Queue statistics (queued, running, done, avg wait time) |
| GET | `/queue/jobs` | List all jobs (`?status=queued&limit=50`) |
| GET | `/queue/jobs/:id` | Get single job status |
| DELETE | `/queue/jobs/:id` | Cancel a queued job |
| DELETE | `/queue/purge` | Remove old completed/failed jobs (`?days=7`) |

### Gates (Human-in-the-loop)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/approvals` | List pending gate approvals |
| POST | `/executions/:id/approve/:stepId` | Approve or reject a gate |

### Scheduling
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/schedules` | List all schedules |
| GET | `/schedules/:id` | Get single schedule |
| POST | `/schedules` | Create a cron schedule |
| PUT | `/schedules/:id` | Update a schedule |
| PATCH | `/schedules/:id/toggle` | Enable/disable a schedule |
| POST | `/schedules/:id/run` | Trigger a schedule immediately |
| DELETE | `/schedules/:id` | Delete a schedule |

### Pipelines
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pipelines` | List all pipelines |
| GET | `/pipelines/:name` | Get pipeline YAML |
| GET | `/pipelines/:name/json` | Get pipeline as parsed JSON |
| POST | `/pipelines/:name` | Create/update pipeline |
| DELETE | `/pipelines/:name` | Delete pipeline |
| POST | `/pipelines/:name/execute` | Execute a pipeline |
| GET | `/pipeline-executions` | List pipeline executions |
| GET | `/pipeline-executions/:id` | Get single pipeline execution |

### AI Chain Generation
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/generate-chain` | Generate a chain from natural language (conversational, multi-turn) |
| POST | `/generate-chain/stream` | Generate with SSE streaming |
| GET | `/generate-chain/stream/:sessionId` | Resume SSE stream for a session |

### MCP & Utilities
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (version, running executions, queue stats, MCP servers) |
| GET | `/mcp-servers` | List external MCP servers and their available tools |
| GET | `/download?path=...` | Download a file (restricted to tmpdir + WORKSPACE_DIR) |

## MCP Tools

When used via Claude Code or Claude Desktop, OCC exposes 25 MCP tools:

**Chain Management:** `list_chains`, `get_chain`, `create_chain`, `update_chain`, `delete_chain`

**Step Editing:** `add_step`, `update_step`, `remove_step`, `add_pre_tool`, `remove_pre_tool`

**Execution:** `run_chain`, `chain_status`, `chain_result`, `list_executions`, `cancel_execution`

**Scheduling:** `list_schedules`, `create_schedule`, `delete_schedule`, `toggle_schedule`

**Gates:** `list_pending_approvals`, `approve_gate`

**Pipelines:** `list_pipelines`, `get_pipeline`, `run_pipeline`, `pipeline_status`

## Architecture

```
┌──────────────┐     ┌───────────────┐     ┌──────────┐
│  Claude Code  │────▶│   MCP Server   │────▶│          │
│  / Desktop   │ MCP │   (stdio)      │     │ Executor │──▶ Claude CLI
└──────────────┘     └───────────────┘     │          │
                                            │  ┌──────┐│
┌──────────────┐     ┌───────────────┐     │  │Cache ││
│  REST Client  │────▶│  REST + SSE    │────▶│  └──────┘│
│  / curl      │HTTP │  (:4242)       │     │          │
└──────────────┘     └───────────────┘     └──────────┘
                                                  │
                          ┌───────────────────────┤
                          ▼                       ▼
                    ┌──────────┐          ┌────────────┐
                    │  chains/  │          │ executions  │
                    │  (YAML)   │          │   (.json)   │
                    └──────────┘          └────────────┘
```

- **MCP Server** — stdio transport, exposes 25 tools for Claude Code
- **REST Server** — Express on port 4242, CORS-enabled, SSE streaming
- **Executor** — topological sort, parallel execution, process management, timeout handling
- **Loader** — YAML parsing with Zod validation, dependency graph construction
- **Scheduler** — cron-based execution with node-cron
- **Pipeline Executor** — multi-chain orchestration with output passing
- **Storage** — SQLite (WAL mode) with per-step checkpointing and time-travel queries
- **MCP Client** — consume external MCP servers (GitHub, Slack, PostgreSQL, etc.) via `mcp_call` pre-tool
- **Linter** — static analysis: undefined variables, unreachable steps, invalid routes, unused outputs

## CLI

OCC includes a command-line interface for local development and CI/CD:

```bash
# List all chains and pipelines
occ list

# Validate all chains (lint + dependency check)
occ validate ./chains

# Preview execution plan without LLM calls (dry-run)
occ dry-run deep-researcher --input topic="AI"

# Execute a chain and stream logs
occ run deep-researcher --input topic="quantum computing"

# Check execution status
occ status <executionId>

# Stream real-time logs
occ logs <executionId>

# Server health check
occ health
```

Dry-run shows the full execution plan with cost estimates:
```
Execution Plan: deep-researcher

  Wave 1 (3 parallel)
    search_mainstream [claude-sonnet-4-6]
    search_contrarian [claude-sonnet-4-6]
    search_academic   [claude-sonnet-4-6]
  Wave 2
    evaluate_sources  [claude-sonnet-4-6] ← search_mainstream, search_contrarian, search_academic
  Wave 3
    merge_perspectives [claude-sonnet-4-6]
  Wave 4
    synthesize        [claude-sonnet-4-6]

Estimated Cost:
  Steps: 6 (4 waves)
  Models: claude-sonnet-4-6: 6 steps (~$0.126-$0.360)
  Total: ~$0.126-$0.360
```

## Docker

```bash
# Quick start
docker compose up

# Or build manually
docker build -t occ .
docker run -p 4242:4242 -v ./chains:/app/chains occ
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CHAINS_DIR` | `../chains` | Directory containing chain YAML files |
| `PIPELINES_DIR` | `../pipelines` | Directory containing pipeline YAML files |
| `REST_PORT` | `4242` | HTTP server port |
| `REST_HOST` | `0.0.0.0` | HTTP server bind address |
| `EXECUTIONS_FILE` | `./executions.json` | Execution history persistence |
| `EXECUTION_MAX_AGE_DAYS` | `7` | Auto-purge executions older than N days |
| `CLAUDE_TIMEOUT_MS` | `300000` | Default per-step timeout (5 min) |
| `CLAUDE_CLI` | `claude` | Path to Claude CLI binary |
| `NO_COLOR` | — | Disable ANSI colors in Claude output |

## How OCC Compares

| Feature | OCC | LangChain | CrewAI | AutoGen |
|---------|-----|-----------|--------|---------|
| **Chain definition** | YAML (declarative) | Python code | Python code | Python code |
| **Step types** | 11 built-in (router, evaluator, gate, loop, merge, browser...) | Custom chains | Role-based agents | Conversation patterns |
| **Parallel execution** | Automatic (dependency graph) | Manual | Sequential by default | Round-robin |
| **Human-in-the-loop** | Native gate steps with API | Callbacks | Limited | Chat-based |
| **MCP integration** | Native (25 tools) | Via adapter | None | None |
| **Real-time streaming** | SSE built-in | Callbacks | Logging | Print |
| **Scheduling** | Built-in cron | External | External | External |
| **Retry + fallback** | Per-step, with model fallback | Per-chain | None | None |
| **Output validation** | Guardrails (regex, length, content) | Output parsers | None | None |
| **Setup complexity** | `npm install && npm start` | pip + API keys + code | pip + API keys + code | pip + API keys + code |
| **Lines of code to define a workflow** | ~30 (YAML) | ~100+ (Python) | ~80+ (Python) | ~120+ (Python) |

**OCC's sweet spot:** You want Claude to handle complex multi-step tasks autonomously, with zero Python, declarative YAML, and native MCP integration. If you're already in the Claude ecosystem, OCC is the orchestration layer that's missing.

### Token Consumption

One of the biggest costs when orchestrating LLM agents is token waste. OCC is designed to minimize it at every level:

| Strategy | OCC | LangChain | CrewAI | AutoGen |
|----------|-----|-----------|--------|---------|
| **Step isolation** | Each step gets only its own prompt + injected variables — no conversation history bloat | Full chain context forwarded | Agents share full conversation | All agents see all messages |
| **Dependency-scoped context** | Steps only receive outputs from their `depends_on` steps, not all previous steps | Sequential — each step sees everything before it | All agents share memory | Full conversation passed |
| **Transform steps** | `json_extract`, `truncate`, `regex` — extract only what matters, zero LLM tokens | Must write Python code | Not available | Not available |
| **Merge before pass** | `pick_best` or `llm_summarize` to compress parallel outputs into one | Manual concatenation | Not available | Not available |
| **Caching** | Per-step cache with TTL — identical prompts skip the LLM entirely | Per-chain only | None | None |
| **Conditional execution** | `condition` field skips irrelevant steps — no tokens wasted | Must code if/else | Not available | Not available |
| **Output guardrails** | Reject and retry only when output fails validation — not on every call | Output parsers retry everything | Not available | Not available |
| **Model selection per step** | Use `claude-haiku-4-5` for simple steps, `claude-opus-4-6` for critical ones | Global model setting | Global model | Global model |

**Example:** A 6-step research chain in OCC uses ~15K tokens. The equivalent in a single-prompt approach would need ~40K+ tokens because the model must hold all context at once. OCC's step isolation means each step only pays for the tokens it actually needs.

### Context Window Optimization

OCC splits complex tasks across multiple focused prompts instead of cramming everything into one giant context window. This is architecturally superior:

| Technique | How OCC does it | Why it matters |
|-----------|----------------|----------------|
| **Parallel decomposition** | Independent steps run simultaneously in separate prompts | 3 parallel research steps use 3 small contexts instead of 1 huge one |
| **Context strategy per step** | `context_strategy: { research: "summarize", raw_data: "truncate:2000" }` | Control exactly how much of each dependency a step sees |
| **Variable interpolation** | Steps receive `{variable}` — resolved to the specific output they need | No "here's everything that happened so far" dumps |
| **Pre-tools injection** | Web search, file reads, API calls happen *before* the prompt — data is ready, not requested mid-conversation | LLM sees clean data, not tool-calling overhead |
| **Evaluator + retry** | Score output quality, retry the specific step that failed — not the whole chain | Failed step 4 re-runs step 4, not steps 1-4 |
| **Transform pipeline** | `json_extract` → `truncate` → `template` — shape data between steps without LLM calls | Zero-token data manipulation between LLM steps |
| **Subchains** | Reuse a chain as a step — its internal context is fully isolated | Complex sub-workflows don't pollute the parent's context |
| **Early exit** | `early_exit_if` — stop the chain when the answer is found | Don't run steps 5-8 if step 4 already has the answer |

```yaml
# Example: context-optimized chain
steps:
  - id: research
    prompt: "Research {input.topic}"
    output_var: raw_research        # Could be 5000 tokens

  - id: extract_key_facts
    type: transform
    operation: json_extract          # Zero LLM tokens
    json_path: "key_findings"
    input_var: raw_research
    output_var: facts                # Now only 500 tokens

  - id: write_report
    depends_on: [extract_key_facts]
    prompt: "Write a report based on: {facts}"  # Receives 500 tokens, not 5000
    output_var: report
```

**Bottom line:** OCC treats the context window as a scarce resource. Every token sent to the LLM earns its place.

## Requirements

- **Node.js** >= 18
- **Claude CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **npm** >= 9

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your branch (`git checkout -b feature/amazing`)
3. Run tests (`cd mcp-server && npm test`)
4. Commit and push
5. Open a Pull Request

## License

MIT — see [LICENSE](LICENSE)
