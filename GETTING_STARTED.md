# Getting Started with OCC (Orchestrator Chain Chimera)

> From zero to your first chain running in 5 minutes.

## Step 1 — Install

```bash
# Option A: npm (recommended)
npm install -g occ-orchestrator

# Option B: from source
git clone https://github.com/lacausecrypto/OCC.git
cd OCC/mcp-server && npm install && npm run build
```

## Step 2 — Install Claude CLI

OCC uses Claude as its default LLM engine. Install and authenticate:

```bash
npm install -g @anthropic-ai/claude-code
claude   # opens browser to authenticate your Anthropic account
```

Verify it works:

```bash
claude -p "Say hello" --max-turns 1
```

## Step 3 — Start the Server

```bash
# If installed via npm:
cd your-project && occ rest

# If installed from source:
cd OCC/mcp-server && npm run rest
```

You should see:

```
[occ-rest] Listening on http://127.0.0.1:4242
```

## Step 4 — Start the Frontend (optional)

```bash
cd OCC/frontend-react && npm install && npm run dev
# → http://localhost:5173
```

On first load, a **Setup Check modal** verifies all prerequisites. Green = ready, orange = optional, red = action needed.

## Step 5 — Create Your First Chain

Create a file `my-chain.yaml`:

```yaml
name: my-chain
description: "My first OCC chain"

inputs:
  - name: topic
    description: "What to analyze"

steps:
  - id: research
    model: claude-haiku-4-5
    prompt: |
      Research the topic "{input.topic}" and provide:
      1. Key facts (5 bullet points)
      2. Recent trends
      3. Main challenges
    output_var: research_result

  - id: summary
    model: claude-haiku-4-5
    depends_on: [research]
    prompt: |
      Based on this research, write a 3-sentence executive summary:
      {research_result}
    output_var: final_summary

output: final_summary
```

## Step 6 — Run It

**Via CLI:**
```bash
occ run my-chain.yaml -i topic="renewable energy"
```

**Via REST API:**
```bash
curl -X POST http://localhost:4242/execute/my-chain \
  -H "Content-Type: application/json" \
  -d '{"input": {"topic": "renewable energy"}}'
```

**Via the React Dashboard:**
1. Open http://localhost:5173
2. Click on `my-chain` in the chain list
3. Click "Run", enter your topic, click "Execute"

## What Just Happened?

```
1. Loader parsed my-chain.yaml and validated it with Zod
2. Executor resolved dependencies:
   - Wave 1: [research]         ← runs first
   - Wave 2: [summary]          ← runs after research completes
3. Step "research" called Claude Haiku with your prompt
4. Result stored in {research_result} variable
5. Step "summary" received {research_result} in its prompt
6. Final output returned via SSE stream
7. Everything checkpointed to SQLite (crash-safe)
```

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
