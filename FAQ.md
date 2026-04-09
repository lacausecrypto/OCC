# OCC — Frequently Asked Questions

## Installation & Setup

### "Failed to spawn claude: spawn claude ENOENT"

Claude CLI is not installed or not in your PATH. Fix:

```bash
npm install -g @anthropic-ai/claude-code
claude   # authenticate in browser
```

Then restart the OCC server. The Setup Check modal (first launch) will verify this automatically.

### Can I use OCC without Claude CLI?

Yes, but with limitations. You can use Ollama (local), HuggingFace, OpenRouter, or OpenAI as providers. Configure them in Settings > LLM Providers. The workflow chat and BLOB sessions currently require Claude CLI, but chains work with any provider.

### Does OCC require Docker?

No. Docker is optional — only needed for sandboxed `bash` pre-tool execution. OCC runs natively with Node.js 20+ and SQLite.

### How do I run the Setup Check again?

Go to **Settings > About > Run Setup Check**. This reopens the prerequisites modal.

---

## Models & Providers

### Which model should I use?

| Use case | Recommended | Why |
|----------|------------|-----|
| Simple classification, extraction | `claude-haiku-4-5` | Fast, cheap ($0.25/M input) |
| Analysis, synthesis, writing | `claude-sonnet-4-6` | Best quality/cost balance ($3/M input) |
| Deep reasoning, complex tasks | `claude-opus-4-6` | Most capable ($15/M input) |
| Privacy-sensitive data | `llama3.2:1b` (Ollama) | Runs locally, zero cost, data stays on machine |
| Budget-critical, high volume | Ollama or HuggingFace free tier | $0 per token |

**Best practice:** Use Haiku for subtasks and Sonnet only for the final synthesis step. This saves [80% on cost](BENCHMARKS.md).

### Can I mix models in the same chain?

Yes. Each step has its own `model:` field:

```yaml
steps:
  - id: gather
    model: claude-haiku-4-5     # cheap
  - id: analyze
    model: claude-sonnet-4-6    # smart
```

### How do I add Ollama models?

1. Install [Ollama](https://ollama.com)
2. Pull a model: `ollama pull llama3.2:1b`
3. OCC auto-detects running Ollama models in Settings > LLM Providers

### Do Ollama/HuggingFace models support tools?

Yes, via an OpenAI-compatible agent loop. OCC translates tools (Bash, Read, Write, WebSearch, etc.) to OpenAI function calling format. Quality depends on the model — large models (70B+) handle tools well, small models (1-3B) may struggle.

---

## Chains & Execution

### How does parallel execution work?

OCC analyzes `depends_on` to build a DAG (directed acyclic graph):

```
Steps with no depends_on    → Wave 1 (parallel)
Steps depending on Wave 1   → Wave 2 (parallel)
Steps depending on Wave 2   → Wave 3 (parallel)
```

Wall time = slowest step per wave, not sum of all steps. A 10-step chain with 4 waves runs in ~70s instead of ~120s sequential.

### What happens if a chain crashes mid-execution?

Every step is checkpointed to SQLite immediately after completion. If the process crashes:
1. Restart the server
2. The execution resumes from the last completed step
3. No work is lost

### How do pre-tools save tokens?

Without pre-tools, the LLM must plan a tool call, execute it, read the result — 3 extra interactions costing tokens. With pre-tools, data is collected **before** the LLM call at zero token cost:

```yaml
pre_tools:
  - type: http_fetch           # downloads page content (0 tokens)
    url: "{input.url}"
    inject_as: page_content
prompt: "Analyze: {page_content}"   # LLM only sees the result
```

### Can I run chains on a schedule?

Yes. Use cron syntax:

```bash
curl -X POST http://localhost:4242/schedules \
  -H "Content-Type: application/json" \
  -d '{"chainName": "market-monitor", "cron": "0 9 * * 1-5", "input": {"sector": "AI"}}'
```

This runs `market-monitor` every weekday at 9 AM.

### How do I debug a failing chain?

1. **Dry-run first:** `occ dry-run my-chain -i key=value` — shows execution plan without LLM calls
2. **Check logs:** Set `LOG_LEVEL=debug` in `.env`
3. **Dashboard:** The monitor sidebar shows real-time step status with error messages
4. **Workflow Chat:** Ask "debug this chain" — the AI will analyze step outputs and errors
5. **REST API:** `GET /executions/:id` returns detailed per-step results including error messages

### What's the maximum chain size?

No hard limit. Tested with 12-step chains with 6-way parallelism. Practical limits:
- Steps: ~50 (beyond this, consider pipelines)
- Parallel workers: 5 default (configurable via `MAX_CONCURRENT_EXECUTIONS`)
- Timeout: 30 min per step (configurable via `CLAUDE_TIMEOUT_MS`)

---

## Cost & Performance

### How much does OCC cost to run?

OCC itself is free. You pay for LLM API usage:

| Model | Input cost | Output cost | Typical chain (10 steps) |
|-------|-----------|------------|------------------------|
| Claude Haiku 4.5 | $0.25/M | $1.25/M | ~$0.03 |
| Claude Sonnet 4.6 | $3.00/M | $15.00/M | ~$0.60 |
| Ollama (local) | Free | Free | $0.00 |
| HuggingFace (free tier) | Free | Free | $0.00 |

**With model routing** (Haiku for subtasks + Sonnet for synthesis): ~$0.12-0.18 per complex chain. See [Benchmarks](BENCHMARKS.md).

### Is OCC faster than calling the API directly?

For **single calls**: OCC adds ~14% overhead (2s for YAML parsing, SQLite, SSE).

For **multi-step workflows**: OCC is faster because of parallelism. A 10-step chain runs in 69s via OCC vs 97s sequential. See [Benchmarks](BENCHMARKS.md).

### Why does parallel execution cost more than sequential?

Claude's prompt caching. Sequential calls reuse the cache (repeated context is cheaper). Parallel calls each start fresh — no cache sharing. This is the "parallelism tax": ~48% more cost for ~29% time savings. Whether it's worth it depends on whether you value speed or budget more.

---

## Frontend & Canvas

### The canvas doesn't show my chains

Make sure `CHAINS_DIR` points to the correct directory. The chains directory is set in `.env` or defaults to `./chains` relative to the server working directory.

### How do I build chains visually?

1. Open the **Canvas** tab
2. Right-click to add steps
3. Drag connections between steps to set dependencies
4. Click "Run" to execute
5. Or use **Workflow Chat** — describe what you want in natural language

### What is BLOB?

BLOB (Block-Level Organic Builder) is an autonomous AI canvas. You describe a goal, and the AI plans, builds, and iterates on a chain — adding steps, running tests, and refining. It's more exploratory than the structured canvas editor.

---

## Production & Deployment

### Is OCC production-ready?

OCC is used in production for internal workflows. For public-facing deployments:
- Set `OCC_API_KEY` for authentication
- Use a reverse proxy (nginx/Caddy) for TLS
- Set `REST_HOST=127.0.0.1` (default) to block external access without proxy
- Review [SECURITY.md](SECURITY.md) for the full hardening checklist

### How do I deploy to a VPS?

```bash
# On your server:
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server && npm install && npm run build

# Create .env with production settings:
cp .env.example .env
# Edit: set OCC_API_KEY, OCC_ENCRYPTION_KEY, REST_HOST, etc.

# Run with systemd or pm2:
pm2 start dist/rest.js --name occ
```

See the [Docker deployment](README.md#docker) section for containerized deployment.

### Can I scale OCC horizontally?

Not currently. OCC is single-process with SQLite. For most use cases (up to ~1000 executions/day), this is sufficient. The queue system handles concurrency within a single process.

---

## MCP

### What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) — a standard for LLMs to use tools. OCC is both:
- **MCP Server**: exposes 28 tools (run-chain, list-chains, etc.) for Claude Code/Desktop
- **MCP Client**: chains can call any external MCP server via the `mcp_call` pre-tool

### How do I use OCC from Claude Code?

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "occ": {
      "command": "node",
      "args": ["/path/to/OCC/mcp-server/dist/index.js"]
    }
  }
}
```

Then in Claude Code, you can say "run the code-review chain on this repo" and it will use OCC.

---

## Troubleshooting

### "Error: EBUSY: resource busy" on Windows

SQLite file locking issue on Windows. The shared test cleanup utility handles this in CI. For production, ensure only one OCC process accesses the database at a time.

### Chain shows 0 input tokens

For Claude: check that token counting includes `cache_read_input_tokens`. Fixed in v0.3.0+.
For Ollama: requires `stream_options: { include_usage: true }`. Fixed in v0.3.0+.
For HuggingFace: the Router API doesn't report tokens in streaming mode. This is an API limitation.

### "Invalid chain" error when running

Run the linter to see validation errors:

```bash
occ validate my-chain.yaml
```

Common issues: missing `output_var`, invalid step type, missing `prompt` field.
