# Getting Started with OCC (Orchestrator Chain Chimera)

> From zero to your first chain running in 5 minutes.

## Step 1 — Install

```bash
npm install -g occ-orchestrator
```

## Step 2 — Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude   # opens browser to authenticate your Anthropic account
```

## Step 3 — Create a Project

```bash
occ init my-project
cd my-project
```

This creates:
- `chains/` with 3 example chains (hello-world, web-analyzer, parallel-pros-cons)
- `pipelines/` ready for multi-chain workflows
- `.env` with default configuration
- `.gitignore` for databases and secrets

## Step 4 — Check Prerequisites

```bash
occ doctor
```

All green? You're ready. Something red? Follow the hints.

## Step 5 — Start the Server

```bash
occ start
```

You should see `[occ-rest] Listening on http://127.0.0.1:4242`.

**Frontend (optional):** `cd frontend-react && npm install && npm run dev` (http://localhost:5173). On first load, a **Setup Check modal** verifies all prerequisites visually.

## Step 6 — Run a Chain

`occ init` created 3 example chains. Try them:

```bash
occ run hello-world -i topic="renewable energy"
occ run parallel-pros-cons -i topic="remote work"
occ run web-analyzer -i url="https://en.wikipedia.org/wiki/AI"
```

Or via REST API:

```bash
curl -X POST http://localhost:4242/execute/hello-world \
  -H "Content-Type: application/json" \
  -d '{"input": {"topic": "renewable energy"}}'
```

Or via the React Dashboard (http://localhost:5173): click a chain, click "Run".

## Next Steps

### Add Pre-Tools (0 Token Data Collection)

Fetch a URL before the LLM call — the LLM only analyzes, doesn't fetch:

```yaml
steps:
  - id: analyze
    pre_tools:
      - type: http_fetch
        url: "{input.url}"
        inject_as: page_content
    prompt: "Analyze this page:\n{page_content}"
    output_var: analysis
```

### Add Parallel Steps

Steps without `depends_on` run simultaneously:

```yaml
steps:
  - id: pros
    prompt: "List 5 pros of {input.topic}"
    output_var: pros_list
  - id: cons
    prompt: "List 5 cons of {input.topic}"
    output_var: cons_list
  - id: verdict
    depends_on: [pros, cons]
    prompt: "Given:\nPros: {pros_list}\nCons: {cons_list}\nWhat's your verdict?"
    output_var: result
```

`pros` and `cons` run in parallel. `verdict` waits for both.

### Mix Models

Use cheap models for subtasks, expensive models for synthesis:

```yaml
steps:
  - id: gather
    model: claude-haiku-4-5       # $0.25/M tokens — fast, cheap
    prompt: "Gather data about {input.topic}"
    output_var: data
  - id: synthesize
    model: claude-sonnet-4-6      # $3/M tokens — smarter
    depends_on: [gather]
    prompt: "Write an expert analysis:\n{data}"
    output_var: report
```

This pattern saves [80% on cost](BENCHMARKS.md) vs using Sonnet for everything.

### Use Local Models (Ollama)

Run chains on local models for privacy and zero cost:

```yaml
steps:
  - id: classify
    model: llama3.2:1b            # runs locally via Ollama
    prompt: "Classify this text: {input.text}"
    output_var: classification
```

Requires [Ollama](https://ollama.com) running locally. Configure in Settings > LLM Providers.

### Add Human Approval Gates

Pause execution until a human approves:

```yaml
steps:
  - id: draft
    prompt: "Write a press release about {input.topic}"
    output_var: draft
  - id: review
    type: gate
    depends_on: [draft]
    prompt: "Review this draft before publishing:\n{draft}"
    output_var: approval
    timeout_hours: 24
  - id: publish
    depends_on: [review]
    prompt: "Finalize for publication:\n{draft}"
    output_var: final
```

Approve or reject via the dashboard or `POST /approvals/:executionId/:stepId`.

## Learn More

- [Chain Format](README.md#chain-format) — all 12 step types and 30 pre-tools
- [Architecture](ARCHITECTURE.md) — how OCC works under the hood
- [Benchmarks](BENCHMARKS.md) — real performance data
- [FAQ](FAQ.md) — common questions
- [REST API](README.md#rest-api-102-endpoints) — 102 endpoints reference
- [Example Chains](README.md#example-chains-19-included) — 19 ready-to-run examples
