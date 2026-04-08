#!/usr/bin/env python3
"""
OCC Benchmark — Raw API comparison (without OCC orchestration)
Calls each LLM provider directly with the same 4 prompts used by bench-*.yaml chains.
Measures: duration, input/output tokens, quality, cost — then compares with OCC results.

Usage: python3 chains/run-benchmark-raw.py [RUNS]
"""

import json, time, re, sys, subprocess, os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 5
TOPIC = "artificial intelligence"
OCC_RESULTS_FILE = "chains/benchmark-results.json"
RAW_RESULTS_FILE = "chains/benchmark-raw-results.json"

# ─── Same prompts as bench-*.yaml chains ──────────────────────────────────

AI_TEXT = (
    "Artificial intelligence (AI) is the simulation of human intelligence processes "
    "by computer systems. These processes include learning, reasoning, and self-correction. "
    "AI has applications in healthcare, finance, transportation, and entertainment. "
    "Machine learning, a subset of AI, enables systems to learn from data without being "
    "explicitly programmed. Deep learning, a further subset, uses neural networks with "
    "many layers to analyze complex patterns. Recent advances in large language models "
    "have demonstrated remarkable capabilities in natural language understanding and "
    "generation. However, AI also raises concerns about bias, privacy, job displacement, "
    "and the concentration of power among a few technology companies. Researchers are "
    "actively working on making AI systems more transparent, fair, and accountable."
)

PROMPTS = {
    "comprehension": (
        f"Résume le texte suivant en exactement 3 phrases concises.\n\n"
        f"TEXTE:\n{AI_TEXT}\n\n"
        f"Réponds UNIQUEMENT avec les 3 phrases, sans introduction ni conclusion."
    ),
    "generation": (
        f"Écris exactement 5 avantages et 5 inconvénients de {TOPIC}.\n"
        f"Format: une liste numérotée, chaque point en une seule phrase.\n\n"
        f"Avantages:\n1.\n2.\n3.\n4.\n5.\n\n"
        f"Inconvénients:\n1.\n2.\n3.\n4.\n5."
    ),
    "structuration": (
        f'Génère un JSON valide décrivant le sujet "{TOPIC}" avec cette structure exacte :\n'
        f'{{"name": "string", "category": "string", "score": number_0_to_10, '
        f'"pros": ["str","str","str"], "cons": ["str","str","str"], "summary": "one sentence"}}\n\n'
        f"Réponds UNIQUEMENT avec le JSON, sans markdown, sans explication."
    ),
}

# Merge prompt is built from the 3 outputs
def merge_prompt(comp, gen, struct):
    return (
        f"Combine ces 3 analyses en un rapport final de 5 lignes maximum :\n"
        f"COMPREHENSION: {comp}\n"
        f"GENERATION: {gen}\n"
        f"STRUCTURATION: {struct}"
    )


# ─── Provider implementations ────────────────────────────────────────────

import urllib.request
import urllib.error

def call_ollama(prompt: str) -> dict:
    """Direct call to Ollama REST API (no OCC)."""
    url = "http://localhost:11434/api/chat"
    body = json.dumps({
        "model": "llama3.2:1b",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode()

    t0 = time.monotonic()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    dur = time.monotonic() - t0

    return {
        "text": data.get("message", {}).get("content", ""),
        "inputTokens": data.get("prompt_eval_count", 0),
        "outputTokens": data.get("eval_count", 0),
        "durationMs": round(dur * 1000),
    }


def call_huggingface(prompt: str) -> dict:
    """Direct call to HuggingFace Router API (no OCC)."""
    url = "https://router.huggingface.co/v1/chat/completions"
    hf_token = os.environ.get("HF_TOKEN", "")
    body = json.dumps({
        "model": "meta-llama/Llama-3.2-1B-Instruct",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
        "stream": False,
    }).encode()

    headers = {"Content-Type": "application/json"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    t0 = time.monotonic()
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    dur = time.monotonic() - t0

    usage = data.get("usage", {})
    return {
        "text": data.get("choices", [{}])[0].get("message", {}).get("content", ""),
        "inputTokens": usage.get("prompt_tokens", 0),
        "outputTokens": usage.get("completion_tokens", 0),
        "durationMs": round(dur * 1000),
    }


def call_claude(prompt: str) -> dict:
    """Direct call to Claude CLI (same as OCC uses, but no orchestration overhead)."""
    t0 = time.monotonic()
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--model", "claude-haiku-4-5",
             "--output-format", "json", "--max-turns", "1"],
            capture_output=True, text=True, timeout=120,
        )
        dur = time.monotonic() - t0

        if result.returncode != 0:
            return {"text": "", "inputTokens": 0, "outputTokens": 0,
                    "durationMs": round(dur * 1000), "error": result.stderr[:200]}

        # Parse JSON output from claude CLI
        data = json.loads(result.stdout)
        text = ""
        in_tok = 0
        out_tok = 0

        # Claude CLI JSON format: {result: "...", usage: {...}, ...}
        if isinstance(data, dict):
            text = data.get("result", "")
            usage = data.get("usage", {})
            in_tok = (usage.get("input_tokens", 0)
                     + usage.get("cache_read_input_tokens", 0)
                     + usage.get("cache_creation_input_tokens", 0))
            out_tok = usage.get("output_tokens", 0)

        return {
            "text": text,
            "inputTokens": in_tok,
            "outputTokens": out_tok,
            "durationMs": round(dur * 1000),
        }
    except subprocess.TimeoutExpired:
        return {"text": "", "inputTokens": 0, "outputTokens": 0,
                "durationMs": 120000, "error": "timeout"}
    except Exception as e:
        return {"text": "", "inputTokens": 0, "outputTokens": 0,
                "durationMs": round((time.monotonic() - t0) * 1000), "error": str(e)}


PROVIDERS = {
    "Claude Haiku 4.5": call_claude,
    "Ollama llama3.2:1b": call_ollama,
    "HuggingFace Llama-3.2-1B": call_huggingface,
}

# ─── Quality checks (same as OCC benchmark) ──────────────────────────────

def check_quality(comp_text, gen_text, struct_text, merge_text):
    q = {}

    # Comprehension: ~3 sentences
    sentences = [s.strip() for s in re.split(r'[.!?]+', comp_text) if s.strip()]
    q["comprehension_ok"] = 2 <= len(sentences) <= 5

    # Generation: numbered items
    items = re.findall(r'^\d+\.', gen_text, re.MULTILINE)
    q["generation_ok"] = len(items) >= 6

    # Structuration: valid JSON with keys
    struct_clean = re.sub(r'^\s*```json?\s*\n?', '', struct_text)
    struct_clean = re.sub(r'\n?\s*```\s*$', '', struct_clean)
    try:
        j = json.loads(struct_clean)
        q["json_valid"] = True
        q["json_has_keys"] = all(k in j for k in ["name", "category", "score", "pros", "cons", "summary"])
    except Exception:
        q["json_valid"] = False
        q["json_has_keys"] = False

    # Merge: non-empty
    q["merge_ok"] = len(merge_text) > 20

    q["score"] = sum([
        q["comprehension_ok"],
        q["generation_ok"],
        q["json_valid"] and q["json_has_keys"],
        q["merge_ok"],
    ])
    return q


# ─── Run benchmark ───────────────────────────────────────────────────────

C = "\033[0;36m"
G = "\033[0;32m"
Y = "\033[0;33m"
R = "\033[0;31m"
B = "\033[1m"
W = "\033[0m"

print(f"{B}{C}{'='*62}{W}")
print(f"{B}{C}  RAW API Benchmark — 3 Providers x {RUNS} Runs x 4 Steps (no OCC){W}")
print(f"{B}{C}{'='*62}{W}")
print(f"{B}Topic:{W} {TOPIC}")
print()

all_results = []

for provider_label, call_fn in PROVIDERS.items():
    print(f"{B}{Y}--- {provider_label} (direct API) ---{W}")

    runs = []
    successes = 0

    for run_idx in range(1, RUNS + 1):
        print(f"  Run {run_idx}/{RUNS}... ", end="", flush=True)
        run_t0 = time.monotonic()

        try:
            # Steps 1-3 in parallel (same as OCC wave 1)
            step_results = {}
            with ThreadPoolExecutor(max_workers=3) as pool:
                futures = {
                    pool.submit(call_fn, PROMPTS[sid]): sid
                    for sid in ["comprehension", "generation", "structuration"]
                }
                for future in as_completed(futures):
                    sid = futures[future]
                    step_results[sid] = future.result()

            # Step 4: merge (sequential, same as OCC wave 2)
            mp = merge_prompt(
                step_results["comprehension"]["text"],
                step_results["generation"]["text"],
                step_results["structuration"]["text"],
            )
            step_results["merge"] = call_fn(mp)

            total_dur = round((time.monotonic() - run_t0) * 1000)
            total_in = sum(s["inputTokens"] for s in step_results.values())
            total_out = sum(s["outputTokens"] for s in step_results.values())

            # Quality
            quality = check_quality(
                step_results["comprehension"]["text"],
                step_results["generation"]["text"],
                step_results["structuration"]["text"],
                step_results["merge"]["text"],
            )

            run_data = {
                "totalDurationMs": total_dur,
                "totalInputTokens": total_in,
                "totalOutputTokens": total_out,
                "steps": {
                    sid: {
                        "inputTokens": sr["inputTokens"],
                        "outputTokens": sr["outputTokens"],
                        "durationMs": sr["durationMs"],
                    }
                    for sid, sr in step_results.items()
                },
                "quality": quality,
            }
            runs.append(run_data)
            successes += 1

            print(f"{G}OK{W} -- {total_dur}ms, {total_in}->{total_out} tok, quality: {quality['score']}/4")

        except Exception as e:
            total_dur = round((time.monotonic() - run_t0) * 1000)
            print(f"{R}ERROR: {e}{W}")

    # Aggregate
    n = len(runs)
    if n > 0:
        avg_dur = round(sum(r["totalDurationMs"] for r in runs) / n)
        min_dur = min(r["totalDurationMs"] for r in runs)
        max_dur = max(r["totalDurationMs"] for r in runs)
        avg_in = round(sum(r["totalInputTokens"] for r in runs) / n)
        avg_out = round(sum(r["totalOutputTokens"] for r in runs) / n)
        avg_quality = round(sum(r["quality"]["score"] for r in runs) / n, 1)

        step_ids = ["comprehension", "generation", "structuration", "merge"]
        step_stats = {}
        for sid in step_ids:
            durs = [r["steps"][sid]["durationMs"] for r in runs if r["steps"].get(sid, {}).get("durationMs", 0) > 0]
            ins = [r["steps"][sid]["inputTokens"] for r in runs if r["steps"].get(sid, {}).get("inputTokens", 0) > 0]
            outs = [r["steps"][sid]["outputTokens"] for r in runs if r["steps"].get(sid, {}).get("outputTokens", 0) > 0]
            step_stats[sid] = {
                "avg_duration_ms": round(sum(durs) / len(durs)) if durs else 0,
                "avg_input_tokens": round(sum(ins) / len(ins)) if ins else 0,
                "avg_output_tokens": round(sum(outs) / len(outs)) if outs else 0,
            }

        # Cost
        if "Claude" in provider_label:
            cost = (avg_in * 0.25 + avg_out * 1.25) / 1_000_000
        else:
            cost = 0.0
    else:
        avg_dur = min_dur = max_dur = avg_in = avg_out = 0
        avg_quality = 0.0
        step_stats = {}
        cost = 0.0

    provider_result = {
        "provider": provider_label,
        "mode": "raw_api",
        "runs": RUNS,
        "successes": successes,
        "totals": {
            "avg_duration_ms": avg_dur,
            "min_duration_ms": min_dur,
            "max_duration_ms": max_dur,
            "avg_input_tokens": avg_in,
            "avg_output_tokens": avg_out,
            "estimated_cost_usd": round(cost, 8),
        },
        "steps": step_stats,
        "quality": {
            "avg_score": avg_quality,
            "comprehension_ok": sum(1 for r in runs if r["quality"]["comprehension_ok"]),
            "generation_ok": sum(1 for r in runs if r["quality"]["generation_ok"]),
            "json_valid": sum(1 for r in runs if r["quality"]["json_valid"]),
            "json_has_keys": sum(1 for r in runs if r["quality"]["json_has_keys"]),
            "merge_ok": sum(1 for r in runs if r["quality"]["merge_ok"]),
        },
    }
    all_results.append(provider_result)

    print(f"  Results: {successes}/{RUNS} success")
    print(f"  Avg duration: {avg_dur}ms (min: {min_dur}, max: {max_dur})")
    print(f"  Avg tokens: {avg_in} in -> {avg_out} out")
    print(f"  Est. cost/run: ${cost:.6f}")
    print(f"  Quality: {avg_quality}/4.0")
    print(f"  Per-step:")
    for sid, ss in step_stats.items():
        print(f"    {sid:<17} {ss['avg_duration_ms']:>6}ms  {ss['avg_input_tokens']:>6} in  {ss['avg_output_tokens']:>6} out")
    print()


# ─── Load OCC results for comparison ─────────────────────────────────────

print(f"{B}{C}{'='*80}{W}")
print(f"{B}{C}  COMPARISON: OCC vs Raw API{W}")
print(f"{B}{C}{'='*80}{W}")
print()

occ_results = {}
if os.path.exists(OCC_RESULTS_FILE):
    with open(OCC_RESULTS_FILE) as f:
        occ_data = json.load(f)
    for r in occ_data.get("results", []):
        occ_results[r["provider"]] = r

# Header
print(f"  {'Provider':<28} {'Mode':<10} {'Duration':>10} {'In Tok':>8} {'Out Tok':>9} {'Cost':>12} {'Quality':>8}")
print(f"  {'─'*28} {'─'*10} {'─'*10} {'─'*8} {'─'*9} {'─'*12} {'─'*8}")

for raw in all_results:
    label = raw["provider"]
    rt = raw["totals"]
    rq = raw["quality"]

    # Raw row
    dur_r = f"{rt['avg_duration_ms']/1000:.1f}s" if rt['avg_duration_ms'] > 0 else "N/A"
    cost_r = f"${rt['estimated_cost_usd']:.6f}"
    print(f"  {label:<28} {'RAW':<10} {dur_r:>10} {rt['avg_input_tokens']:>8} {rt['avg_output_tokens']:>9} {cost_r:>12} {rq['avg_score']:>5}/4.0")

    # OCC row
    if label in occ_results:
        occ = occ_results[label]
        ot = occ["totals"]
        oq = occ["quality"]
        dur_o = f"{ot['avg_duration_ms']/1000:.1f}s" if ot['avg_duration_ms'] > 0 else "N/A"
        cost_o = f"${ot['estimated_cost_usd']:.6f}"
        print(f"  {'':28} {'OCC':<10} {dur_o:>10} {ot['avg_input_tokens']:>8} {ot['avg_output_tokens']:>9} {cost_o:>12} {oq['avg_score']:>5}/4.0")

        # Delta
        if rt['avg_duration_ms'] > 0 and ot['avg_duration_ms'] > 0:
            overhead_ms = ot['avg_duration_ms'] - rt['avg_duration_ms']
            overhead_pct = (overhead_ms / rt['avg_duration_ms']) * 100
            sign = "+" if overhead_ms >= 0 else ""
            print(f"  {'':28} {'DELTA':<10} {sign}{overhead_ms/1000:.1f}s ({sign}{overhead_pct:.0f}%)")
    print()

# Per-step comparison
print(f"\n  Per-step duration comparison (RAW vs OCC):")
print(f"  {'Provider':<28} {'Step':<17} {'RAW':>8} {'OCC':>8} {'Overhead':>10}")
print(f"  {'─'*28} {'─'*17} {'─'*8} {'─'*8} {'─'*10}")

for raw in all_results:
    label = raw["provider"]
    occ = occ_results.get(label, {})
    occ_steps = occ.get("steps", {})

    for sid in ["comprehension", "generation", "structuration", "merge"]:
        raw_dur = raw["steps"].get(sid, {}).get("avg_duration_ms", 0)
        occ_dur = occ_steps.get(sid, {}).get("avg_duration_ms", 0)

        raw_s = f"{raw_dur/1000:.1f}s" if raw_dur > 0 else "N/A"
        occ_s = f"{occ_dur/1000:.1f}s" if occ_dur > 0 else "N/A"

        if raw_dur > 0 and occ_dur > 0:
            delta = occ_dur - raw_dur
            sign = "+" if delta >= 0 else ""
            delta_s = f"{sign}{delta/1000:.1f}s"
        else:
            delta_s = "N/A"

        first_col = label if sid == "comprehension" else ""
        print(f"  {first_col:<28} {sid:<17} {raw_s:>8} {occ_s:>8} {delta_s:>10}")

print()

# ─── Save raw results ────────────────────────────────────────────────────
output = {
    "benchmark": "OCC Raw API Comparison (without OCC orchestration)",
    "version": "2.0",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "config": {
        "topic": TOPIC,
        "runs_per_provider": RUNS,
        "steps": ["comprehension", "generation", "structuration", "merge"],
        "parallel_steps": ["comprehension", "generation", "structuration"],
        "sequential_steps": ["merge"],
    },
    "results": all_results,
}

with open(RAW_RESULTS_FILE, "w") as f:
    json.dump(output, f, indent=2)

print(f"Raw results saved to {RAW_RESULTS_FILE}")
print(f"{B}{G}Benchmark complete!{W}")
