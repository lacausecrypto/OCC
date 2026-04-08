# OCC Benchmarks — Real Execution Results

> All results from **real executions** on April 8, 2026.  
> Hardware: MacBook Pro (Apple Silicon), 16 GB RAM, OCC v2.0.0.  
> Each scenario run **3–5 times** — averages shown. Raw data in `chains/benchmark-*-results.json`.

---

## TL;DR — Is OCC Worth It?

| Scenario | Without OCC | With OCC | Verdict |
|----------|-------------|----------|---------|
| **Simple task** (1 step) | 14.0s, $0.029 | 15.9s, $0.029 | **No gain.** +14% overhead. Use direct API calls. |
| **Complex task** (10 steps) vs naive | 229s, $0.60 | **69s, $0.18** | **Yes. 70% faster, 70% cheaper.** |
| **Complex task** vs smart manual | 97s, $0.12 | **69s, $0.18** | **Depends.** 29% faster but 48% more expensive. |

OCC shines on multi-step workflows. The value comes from **model routing** (biggest cost saver) and **parallel execution** (biggest time saver), not from single-step calls where it only adds overhead.

---

## Benchmark 1 — Provider Comparison (Same Task, 3 LLMs)

**Task:** 4 steps — comprehension, generation, JSON structuration, merge.  
**Input:** Fixed AI text (100 words) + topic "artificial intelligence".  
**Runs:** 5 per provider.

| Provider | Avg Duration | Input Tokens | Output Tokens | Cost/run | Quality |
|----------|-------------|-------------|--------------|----------|---------|
| Claude Haiku 4.5 | 15.9s | 105,586 | 2,003 | $0.029 | **4.0/4.0** |
| Ollama llama3.2:1b | 19.9s | 1,036 | 1,144 | $0.000 | 3.0/4.0 |
| HuggingFace Llama-3.2-1B | 4.0s | — | — | $0.000 | 2.0/4.0 |

**Quality scoring** (0–4): checks sentence count (comprehension), numbered list items (generation), valid JSON with required keys (structuration), non-trivial output (merge).

### Per-step breakdown

| Provider | Comprehension | Generation | Structuration | Merge |
|----------|:------------:|:----------:|:-------------:|:-----:|
| Claude Haiku | 6.2s | 5.8s | 4.8s | 9.1s |
| Ollama | 3.7s | 8.8s | 7.6s | 9.7s |
| HuggingFace | 1.9s | 2.2s | 1.9s | 1.7s |

### Observations

- **Claude Haiku** is the only provider achieving 4/4 quality consistently (valid JSON, correct format).
- **Ollama 1B** can summarize and merge (3/4) but struggles with strict JSON output.
- **HuggingFace 1B** is fast (4.0s) but produces poor structured output (2/4). Speed comes from the model being too small to follow complex instructions.
- **Token counts for Ollama/HF are lower** because smaller models have smaller context windows and don't receive the Claude system prompt overhead (~26K tokens from Claude's prompt caching).

### Raw API vs OCC (overhead measurement)

Same 4-step task, Claude Haiku only, 5 runs each:

| Mode | Avg Duration | Input Tokens | Output Tokens | Cost |
|------|-------------|-------------|--------------|------|
| Direct API (no OCC) | 14.0s | 105,635 | 1,955 | $0.029 |
| OCC orchestrated | 15.9s | 105,586 | 2,003 | $0.029 |
| **Overhead** | **+1.9s (+14%)** | ~same | ~same | ~same |

The 14% overhead comes from: YAML parsing, variable resolution, SQLite checkpoint persistence, SSE event emission, and queue management. Token counts and cost are identical — OCC doesn't add tokens.

---

## Benchmark 2 — Economy of Scale (10 Steps, 4 Waves)

This is the key benchmark. A realistic **strategic analysis workflow** with 10 LLM steps:

- **Wave 1** (4 parallel): market analysis, tech trends, competition, risks — all Haiku
- **Wave 2** (3 parallel): SWOT matrix, tech roadmap, risk matrix — all Haiku
- **Wave 3** (2 parallel): opportunity score, risk score — all Haiku
- **Wave 4** (1 step): executive summary — **Sonnet** (needs reasoning quality)

Three approaches compared, **3 runs each**:

### Results

| Approach | Duration | Input Tokens | Output Tokens | Cost/run |
|----------|---------|-------------|--------------|---------|
| **A) Sequential, all Sonnet** | 229s | 169,124 | 6,325 | **$0.602** |
| **B) Sequential, Haiku+Sonnet** | 97s | 253,542 | 3,944 | **$0.121** |
| **C) OCC parallel, Haiku+Sonnet** | **69s** | 401,014 | 10,370 | **$0.179** |

### Savings analysis

**Model routing (A → B): 80% cost reduction**

Switching from all-Sonnet to Haiku-for-subtasks + Sonnet-for-synthesis cuts cost from $0.60 to $0.12. This is the single biggest optimization and doesn't require OCC — you can do it manually. OCC just makes it trivial (one `model:` field per step in YAML).

**Parallelism (B → C): 29% faster, but 48% more expensive**

OCC runs waves in parallel (69s vs 97s sequential), but parallel execution means each step starts with a fresh context — no prompt cache sharing between parallel steps. This increases input tokens (401K vs 254K) and cost ($0.18 vs $0.12). The time savings may or may not justify the cost increase depending on your use case.

**OCC vs naive (A → C): 70% faster AND 70% cheaper**

Against the naive approach (all-Sonnet, sequential), OCC delivers massive gains on both axes. This is the realistic comparison for someone who hasn't optimized their workflow yet.

### OCC wave breakdown (actual timings)

```
Wave 1 (4 parallel): 12.2s wall time
  research_market=12.2s  research_tech=10.1s  research_competition=9.6s  research_risks=12.2s

Wave 2 (3 parallel): 16.8s wall time
  swot=16.8s  tech_roadmap=12.1s  risk_matrix=10.1s

Wave 3 (2 parallel): 12.4s wall time
  score_opportunity=12.4s  score_risk=10.7s

Wave 4 (1 step):     22.6s wall time
  executive_summary=22.6s
```

Sequential sum of all 10 steps would be ~120s. OCC wall time is 69s = **1.7x speedup** from parallelism alone. The theoretical max is ~4x (limited by Wave 4 which must be sequential).

### Scaling projection (100 executions/day)

| Approach | Daily compute | Daily cost | Monthly cost |
|----------|:------------:|:----------:|:------------:|
| A) All-Sonnet sequential | 6.4h | $60 | **$1,807** |
| B) Haiku+Sonnet sequential | 2.7h | $12 | **$362** |
| C) OCC parallel | **1.9h** | $18 | **$537** |

OCC saves **$1,270/month and 4.4h/day** vs naive approach.  
OCC saves **0.8h/day** vs smart manual approach but costs **$175/month more** (the parallelism tax).

---

## When OCC Is Worth It

| Scenario | Worth it? | Why |
|----------|:---------:|-----|
| Single LLM call | No | 14% overhead, no parallelism to gain |
| 2-3 step chain, sequential | Marginal | Convenience (YAML, checkpoints) but no speed gain |
| 4+ steps with parallelism | **Yes** | Time savings compound with wave count |
| 10+ steps, mixed models | **Yes** | Model routing + parallelism = 70% faster, 70% cheaper vs naive |
| Production workloads (100+/day) | **Yes** | Queue management, crash recovery, monitoring, SSE streaming |
| Privacy-sensitive (Ollama) | **Yes** | Orchestrate local models with same YAML as cloud models |

## When OCC Is NOT Worth It

- **One-shot prompts** — just call the API directly.
- **Budget-critical, parallelism-heavy** — parallel steps lose prompt cache sharing. If cost matters more than speed, run sequentially with cache.
- **Real-time latency-sensitive** (<1s) — OCC adds ~2s overhead from orchestration.

---

## Methodology

- **Hardware:** MacBook Pro (Apple Silicon), 16 GB RAM
- **OCC version:** 2.0.0, Node.js 24
- **Providers:** Claude CLI (Haiku 4.5, Sonnet 4.6), Ollama (llama3.2:1b local), HuggingFace Router (Llama-3.2-1B-Instruct)
- **Concurrency:** MAX_CONCURRENT_EXECUTIONS=5
- **Token counting:** Claude CLI stream-json with `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Ollama via `stream_options: { include_usage: true }`. HuggingFace Router does not report tokens in streaming mode.
- **Cost calculation:** Haiku: $0.25/$1.25 per 1M tokens. Sonnet: $3.00/$15.00 per 1M tokens. Ollama/HuggingFace: $0 (local/free tier).
- **Quality scoring:** Automated checks — sentence count, numbered list regex, JSON parse + key validation, output length threshold.
- **No cherry-picking:** All runs included. Averages computed over successful runs only.

### Reproduce

```bash
# Provider comparison (5 runs × 3 providers × 4 steps)
bash chains/run-benchmark.sh "artificial intelligence" 5

# Economy of scale (3 runs × 3 approaches × 10 steps)
python3 chains/run-benchmark-scale.py 3

# Raw API comparison (no OCC, same prompts)
python3 chains/run-benchmark-raw.py 5
```

### Known Limitations

- **Prompt cache effect:** Sequential runs benefit from Claude's prompt caching (repeated context is cheaper). Parallel runs start fresh — each step pays full input cost. This is why OCC (parallel) uses more input tokens than sequential for the same prompts.
- **Network variability:** API latency varies by ~20% between runs. We mitigate with multiple runs and averages.
- **Ollama speed depends on hardware:** llama3.2:1b on Apple Silicon M-series is fast. On CPU-only machines, expect 3-5x slower.
- **HuggingFace token reporting:** The HuggingFace Router API does not return `usage` data in streaming mode. Token counts show as 0 — this is an API limitation, not an OCC bug.
- **Cost estimates are approximate:** Based on published Anthropic pricing as of April 2026.
