#!/usr/bin/env python3
"""
OCC Economy of Scale Benchmark
Compares 3 approaches for the same complex 10-step analysis:
  A) Sequential all-Sonnet  — manual approach, 1 model, no parallelism
  B) Sequential mixed-model — manual approach, haiku+sonnet, no parallelism
  C) OCC orchestrated       — parallel waves, haiku+sonnet, auto-routing

Demonstrates: parallelism gains, model routing savings, and scaling economics.

Usage: python3 chains/run-benchmark-scale.py [RUNS]
"""

import json, time, re, sys, subprocess, os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
TOPIC = "artificial intelligence startups in 2026"
RESULTS_FILE = "chains/benchmark-scale-results.json"
API = "http://localhost:4242"

import urllib.request

# ─── Pricing (per 1M tokens) ─────────────────────────────────────────────
PRICING = {
    "claude-haiku-4-5":  {"input": 0.25,  "output": 1.25},
    "claude-sonnet-4-6": {"input": 3.00,  "output": 15.00},
}

def calc_cost(model, in_tok, out_tok):
    p = PRICING.get(model, {"input": 0, "output": 0})
    return (in_tok * p["input"] + out_tok * p["output"]) / 1_000_000

# ─── Same prompts as bench-complex.yaml ──────────────────────────────────

STEPS = {
    # Wave 1 — 4 parallel
    "research_market": {
        "prompt": f'Analyse le marché de "{TOPIC}". Donne : taille du marché, croissance, segments clés, acteurs majeurs. Réponds en 5-8 phrases factuelles.',
        "wave": 1, "deps": [],
    },
    "research_tech": {
        "prompt": f'Analyse les tendances technologiques de "{TOPIC}". Donne : technologies émergentes, stack technique, innovations récentes. Réponds en 5-8 phrases factuelles.',
        "wave": 1, "deps": [],
    },
    "research_competition": {
        "prompt": f'Analyse la compétition dans "{TOPIC}". Donne : principaux concurrents, parts de marché, différentiateurs, barrières à l\'entrée. Réponds en 5-8 phrases factuelles.',
        "wave": 1, "deps": [],
    },
    "research_risks": {
        "prompt": f'Analyse les risques de "{TOPIC}". Donne : risques réglementaires, techniques, financiers, éthiques. Réponds en 5-8 phrases factuelles.',
        "wave": 1, "deps": [],
    },
    # Wave 2 — 3 parallel
    "swot": {
        "prompt_tpl": 'À partir de ces analyses, génère un SWOT complet en JSON :\nMARCHÉ: {research_market}\nCOMPÉTITION: {research_competition}\n\nFormat: {{"strengths": [...], "weaknesses": [...], "opportunities": [...], "threats": [...]}}\nRéponds UNIQUEMENT en JSON.',
        "wave": 2, "deps": ["research_market", "research_competition"],
    },
    "tech_roadmap": {
        "prompt_tpl": 'À partir de cette analyse tech, propose une roadmap produit sur 12 mois :\nTECH: {research_tech}\n\nDonne 4 milestones avec : nom, durée, technologies, livrables. Format liste numérotée.',
        "wave": 2, "deps": ["research_tech"],
    },
    "risk_matrix": {
        "prompt_tpl": 'À partir de cette analyse des risques, génère une matrice de risques en JSON :\nRISQUES: {research_risks}\n\nFormat: [{{"risk": "...", "probability": "high|medium|low", "impact": "high|medium|low", "mitigation": "..."}}]\nRéponds UNIQUEMENT en JSON.',
        "wave": 2, "deps": ["research_risks"],
    },
    # Wave 3 — 2 parallel
    "score_opportunity": {
        "prompt_tpl": 'Évalue l\'opportunité business sur 100 :\nSWOT: {swot}\nROADMAP: {tech_roadmap}\n\nDonne un score global /100 avec justification en 3 phrases.\nFormat: {{"score": N, "justification": "..."}}',
        "wave": 3, "deps": ["swot", "tech_roadmap"],
    },
    "score_risk": {
        "prompt_tpl": 'Évalue le niveau de risque global sur 100 :\nMATRICE: {risk_matrix}\n\nDonne un score de risque /100 (100=très risqué) avec justification en 3 phrases.\nFormat: {{"risk_score": N, "justification": "..."}}',
        "wave": 3, "deps": ["risk_matrix"],
    },
    # Wave 4 — 1 step (Sonnet for synthesis)
    "executive_summary": {
        "prompt_tpl": 'Tu es un analyste stratégique senior. Rédige un executive summary professionnel.\n\nDONNÉES :\n- SWOT: {swot}\n- Roadmap tech: {tech_roadmap}\n- Matrice de risques: {risk_matrix}\n- Score opportunité: {score_opportunity}\n- Score risque: {score_risk}\n\nRédige un executive summary structuré avec :\n1. Verdict (GO/NO-GO avec score confiance)\n2. Synthèse marché (3 phrases)\n3. Avantage compétitif (3 phrases)\n4. Risques critiques (top 3)\n5. Recommandation stratégique (5 phrases)\n\nMaximum 400 mots. Ton professionnel et direct.',
        "wave": 4, "deps": ["score_opportunity", "score_risk", "swot", "tech_roadmap", "risk_matrix"],
    },
}

# ─── Claude CLI call ─────────────────────────────────────────────────────

def call_claude(prompt, model="claude-haiku-4-5"):
    t0 = time.monotonic()
    result = subprocess.run(
        ["claude", "-p", prompt, "--model", model,
         "--output-format", "json", "--max-turns", "1"],
        capture_output=True, text=True, timeout=180,
    )
    dur = time.monotonic() - t0

    if result.returncode != 0:
        raise RuntimeError(f"Claude error: {result.stderr[:200]}")

    data = json.loads(result.stdout)
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
        "model": model,
    }

# ─── Colors ──────────────────────────────────────────────────────────────
C = "\033[0;36m"; G = "\033[0;32m"; Y = "\033[0;33m"; R = "\033[0;31m"
B = "\033[1m"; DIM = "\033[2m"; W = "\033[0m"

print(f"{B}{C}{'='*72}{W}")
print(f"{B}{C}  OCC Economy of Scale — 10 Steps, 4 Waves, 3 Approaches x {RUNS} Runs{W}")
print(f"{B}{C}{'='*72}{W}")
print(f"{B}Topic:{W} {TOPIC}")
print(f"{B}Steps:{W} 10 (Wave1: 4 parallel, Wave2: 3 parallel, Wave3: 2 parallel, Wave4: 1)")
print()

all_approaches = []

# ═══════════════════════════════════════════════════════════════════════════
# APPROACH A: Sequential, all Sonnet (naive manual approach)
# ═══════════════════════════════════════════════════════════════════════════
print(f"{B}{Y}{'━'*72}{W}")
print(f"{B}{Y}  APPROACH A: Sequential — All Sonnet (naive manual){W}")
print(f"{B}{Y}{'━'*72}{W}")

a_runs = []
for run_idx in range(1, RUNS + 1):
    print(f"  Run {run_idx}/{RUNS}... ", end="", flush=True)
    t0 = time.monotonic()
    outputs = {}
    total_in = 0; total_out = 0; total_cost = 0.0
    step_data = {}

    try:
        step_order = ["research_market", "research_tech", "research_competition", "research_risks",
                       "swot", "tech_roadmap", "risk_matrix",
                       "score_opportunity", "score_risk", "executive_summary"]

        for sid in step_order:
            info = STEPS[sid]
            if "prompt" in info:
                prompt = info["prompt"]
            else:
                prompt = info["prompt_tpl"]
                for dep in info["deps"]:
                    prompt = prompt.replace("{" + dep + "}", outputs.get(dep, ""))

            model = "claude-sonnet-4-6"  # All sonnet
            res = call_claude(prompt, model)
            outputs[sid] = res["text"]
            total_in += res["inputTokens"]
            total_out += res["outputTokens"]
            total_cost += calc_cost(model, res["inputTokens"], res["outputTokens"])
            step_data[sid] = {
                "model": model, "durationMs": res["durationMs"],
                "inputTokens": res["inputTokens"], "outputTokens": res["outputTokens"],
            }

        total_dur = round((time.monotonic() - t0) * 1000)
        a_runs.append({"totalDurationMs": total_dur, "totalInputTokens": total_in,
                        "totalOutputTokens": total_out, "totalCost": total_cost, "steps": step_data})
        print(f"{G}OK{W} — {total_dur/1000:.0f}s, {total_in}→{total_out} tok, ${total_cost:.4f}")

    except Exception as e:
        print(f"{R}ERROR: {e}{W}")

# ═══════════════════════════════════════════════════════════════════════════
# APPROACH B: Sequential, mixed model (smart manual approach)
# ═══════════════════════════════════════════════════════════════════════════
print(f"\n{B}{Y}{'━'*72}{W}")
print(f"{B}{Y}  APPROACH B: Sequential — Haiku + Sonnet (smart manual){W}")
print(f"{B}{Y}{'━'*72}{W}")

b_runs = []
for run_idx in range(1, RUNS + 1):
    print(f"  Run {run_idx}/{RUNS}... ", end="", flush=True)
    t0 = time.monotonic()
    outputs = {}
    total_in = 0; total_out = 0; total_cost = 0.0
    step_data = {}

    try:
        step_order = ["research_market", "research_tech", "research_competition", "research_risks",
                       "swot", "tech_roadmap", "risk_matrix",
                       "score_opportunity", "score_risk", "executive_summary"]

        for sid in step_order:
            info = STEPS[sid]
            if "prompt" in info:
                prompt = info["prompt"]
            else:
                prompt = info["prompt_tpl"]
                for dep in info["deps"]:
                    prompt = prompt.replace("{" + dep + "}", outputs.get(dep, ""))

            # Smart routing: Sonnet only for final synthesis
            model = "claude-sonnet-4-6" if sid == "executive_summary" else "claude-haiku-4-5"
            res = call_claude(prompt, model)
            outputs[sid] = res["text"]
            total_in += res["inputTokens"]
            total_out += res["outputTokens"]
            total_cost += calc_cost(model, res["inputTokens"], res["outputTokens"])
            step_data[sid] = {
                "model": model, "durationMs": res["durationMs"],
                "inputTokens": res["inputTokens"], "outputTokens": res["outputTokens"],
            }

        total_dur = round((time.monotonic() - t0) * 1000)
        b_runs.append({"totalDurationMs": total_dur, "totalInputTokens": total_in,
                        "totalOutputTokens": total_out, "totalCost": total_cost, "steps": step_data})
        print(f"{G}OK{W} — {total_dur/1000:.0f}s, {total_in}→{total_out} tok, ${total_cost:.4f}")

    except Exception as e:
        print(f"{R}ERROR: {e}{W}")

# ═══════════════════════════════════════════════════════════════════════════
# APPROACH C: OCC orchestrated (parallel waves + mixed model)
# ═══════════════════════════════════════════════════════════════════════════
print(f"\n{B}{Y}{'━'*72}{W}")
print(f"{B}{Y}  APPROACH C: OCC Orchestrated — Parallel + Haiku/Sonnet{W}")
print(f"{B}{Y}{'━'*72}{W}")

c_runs = []
for run_idx in range(1, RUNS + 1):
    print(f"  Run {run_idx}/{RUNS}... ", end="", flush=True)

    try:
        t0 = time.monotonic()
        resp = urllib.request.urlopen(urllib.request.Request(
            f"{API}/execute/bench-complex",
            data=json.dumps({"input": {"topic": TOPIC}}).encode(),
            headers={"Content-Type": "application/json"},
        ))
        exec_data = json.loads(resp.read())
        exec_id = exec_data.get("executionId", "")

        # Poll
        status = "running"
        while status in ("running", "queued"):
            time.sleep(3)
            if time.monotonic() - t0 > 300:
                status = "timeout"; break
            req = urllib.request.Request(f"{API}/executions/{exec_id}")
            with urllib.request.urlopen(req) as r:
                result = json.loads(r.read())
            status = result.get("status", "unknown")

        total_dur = round((time.monotonic() - t0) * 1000)

        if status == "done":
            steps = result.get("steps", {})
            total_in = sum((s.get("inputTokens", 0) or 0) for s in steps.values())
            total_out = sum((s.get("outputTokens", 0) or 0) for s in steps.values())

            # Cost: 9 haiku steps + 1 sonnet step
            total_cost = 0.0
            for sid, s in steps.items():
                model = "claude-sonnet-4-6" if sid == "executive_summary" else "claude-haiku-4-5"
                total_cost += calc_cost(model, s.get("inputTokens", 0) or 0, s.get("outputTokens", 0) or 0)

            step_data = {}
            for sid, s in steps.items():
                step_data[sid] = {
                    "model": "claude-sonnet-4-6" if sid == "executive_summary" else "claude-haiku-4-5",
                    "durationMs": s.get("durationMs", 0) or 0,
                    "inputTokens": s.get("inputTokens", 0) or 0,
                    "outputTokens": s.get("outputTokens", 0) or 0,
                }

            c_runs.append({"totalDurationMs": total_dur, "totalInputTokens": total_in,
                            "totalOutputTokens": total_out, "totalCost": total_cost, "steps": step_data})
            print(f"{G}OK{W} — {total_dur/1000:.0f}s, {total_in}→{total_out} tok, ${total_cost:.4f}")
        else:
            err = result.get("error", status)
            print(f"{R}{err}{W}")

    except Exception as e:
        print(f"{R}ERROR: {e}{W}")


# ═══════════════════════════════════════════════════════════════════════════
# COMPARISON TABLE
# ═══════════════════════════════════════════════════════════════════════════

def agg(runs):
    if not runs:
        return {"dur": 0, "min_dur": 0, "max_dur": 0, "in_tok": 0, "out_tok": 0, "cost": 0.0, "n": 0}
    n = len(runs)
    return {
        "dur": round(sum(r["totalDurationMs"] for r in runs) / n),
        "min_dur": min(r["totalDurationMs"] for r in runs),
        "max_dur": max(r["totalDurationMs"] for r in runs),
        "in_tok": round(sum(r["totalInputTokens"] for r in runs) / n),
        "out_tok": round(sum(r["totalOutputTokens"] for r in runs) / n),
        "cost": sum(r["totalCost"] for r in runs) / n,
        "n": n,
    }

a = agg(a_runs)
b = agg(b_runs)
c = agg(c_runs)

print(f"\n{B}{C}{'='*80}{W}")
print(f"{B}{C}  ECONOMY OF SCALE — FINAL RESULTS{W}")
print(f"{B}{C}{'='*80}{W}\n")

print(f"  {'Approach':<45} {'Duration':>10} {'In Tok':>9} {'Out Tok':>9} {'Cost':>10} {'OK':>5}")
print(f"  {'─'*45} {'─'*10} {'─'*9} {'─'*9} {'─'*10} {'─'*5}")

rows = [
    ("A) Sequential All-Sonnet (naive)", a),
    ("B) Sequential Haiku+Sonnet (smart manual)", b),
    ("C) OCC Parallel Haiku+Sonnet (orchestrated)", c),
]

for label, d in rows:
    if d["n"] == 0:
        print(f"  {label:<45} {'N/A':>10} {'N/A':>9} {'N/A':>9} {'N/A':>10} {'0':>5}")
        continue
    dur_s = f"{d['dur']/1000:.0f}s"
    cost_s = f"${d['cost']:.4f}"
    print(f"  {label:<45} {dur_s:>10} {d['in_tok']:>9} {d['out_tok']:>9} {cost_s:>10} {d['n']:>5}")

# ─── Savings calculations ────────────────────────────────────────────────
print(f"\n  {'─'*80}")
print(f"  {B}SAVINGS ANALYSIS{W}\n")

if a["n"] > 0 and b["n"] > 0:
    cost_save_ab = ((a["cost"] - b["cost"]) / a["cost"]) * 100 if a["cost"] > 0 else 0
    print(f"  Model routing (A→B):    ${a['cost']:.4f} → ${b['cost']:.4f}  = {B}{cost_save_ab:.0f}% cost reduction{W}")
    print(f"                          (Haiku for 9 steps, Sonnet only for synthesis)")

if a["n"] > 0 and c["n"] > 0:
    time_save_ac = ((a["dur"] - c["dur"]) / a["dur"]) * 100 if a["dur"] > 0 else 0
    cost_save_ac = ((a["cost"] - c["cost"]) / a["cost"]) * 100 if a["cost"] > 0 else 0
    print(f"\n  OCC vs naive (A→C):     {a['dur']/1000:.0f}s → {c['dur']/1000:.0f}s  = {B}{time_save_ac:.0f}% faster{W}")
    print(f"                          ${a['cost']:.4f} → ${c['cost']:.4f}  = {B}{cost_save_ac:.0f}% cheaper{W}")

if b["n"] > 0 and c["n"] > 0:
    time_save_bc = ((b["dur"] - c["dur"]) / b["dur"]) * 100 if b["dur"] > 0 else 0
    cost_delta = c["cost"] - b["cost"]
    cost_pct = (cost_delta / b["cost"]) * 100 if b["cost"] > 0 else 0
    print(f"\n  OCC vs smart manual (B→C): {b['dur']/1000:.0f}s → {c['dur']/1000:.0f}s  = {B}{time_save_bc:.0f}% faster{W}")
    if abs(cost_pct) < 2:
        print(f"                             ${b['cost']:.4f} ≈ ${c['cost']:.4f}  = same cost (tokens identical)")
    else:
        sign = "+" if cost_delta > 0 else ""
        print(f"                             ${b['cost']:.4f} → ${c['cost']:.4f}  = {sign}{cost_pct:.0f}% cost")

# ─── Scaling projection ─────────────────────────────────────────────────
print(f"\n  {'─'*80}")
print(f"  {B}SCALING PROJECTION (100 executions/day){W}\n")

for label, d in rows:
    if d["n"] == 0: continue
    daily_cost = d["cost"] * 100
    daily_time_h = (d["dur"] / 1000) * 100 / 3600
    monthly_cost = daily_cost * 30
    print(f"  {label}")
    print(f"    Daily:   {daily_time_h:.1f}h compute time, ${daily_cost:.2f}")
    print(f"    Monthly: ${monthly_cost:.2f}")
    print()

if a["n"] > 0 and c["n"] > 0:
    monthly_save = (a["cost"] - c["cost"]) * 100 * 30
    time_save_h = ((a["dur"] - c["dur"]) / 1000) * 100 / 3600
    print(f"  {B}OCC saves ${monthly_save:.2f}/month and {time_save_h:.1f}h/day vs naive approach{W}")
    if b["n"] > 0:
        monthly_save_b = (b["cost"] - c["cost"]) * 100 * 30
        time_save_h_b = ((b["dur"] - c["dur"]) / 1000) * 100 / 3600
        print(f"  {B}OCC saves {time_save_h_b:.1f}h/day vs smart manual (same cost){W}")

# ─── Wave timing breakdown ───────────────────────────────────────────────
if c_runs:
    print(f"\n  {'─'*80}")
    print(f"  {B}OCC WAVE BREAKDOWN (last run){W}\n")
    last = c_runs[-1]["steps"]
    waves = {
        1: ["research_market", "research_tech", "research_competition", "research_risks"],
        2: ["swot", "tech_roadmap", "risk_matrix"],
        3: ["score_opportunity", "score_risk"],
        4: ["executive_summary"],
    }
    for wn, sids in waves.items():
        step_durs = [(sid, last.get(sid, {}).get("durationMs", 0)) for sid in sids]
        max_dur = max(d for _, d in step_durs) if step_durs else 0
        steps_str = ", ".join(f"{sid}={d/1000:.1f}s" for sid, d in step_durs)
        parallel = " (parallel)" if len(sids) > 1 else ""
        print(f"  Wave {wn}{parallel}: {max_dur/1000:.1f}s wall time — {steps_str}")

# ─── Save ─────────────────────────────────────────────────────────────────
output = {
    "benchmark": "OCC Economy of Scale",
    "version": "1.0",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "config": {"topic": TOPIC, "runs": RUNS, "steps": 10, "waves": 4},
    "approaches": {
        "A_sequential_all_sonnet": {"avg": a, "runs_count": len(a_runs)},
        "B_sequential_mixed_model": {"avg": b, "runs_count": len(b_runs)},
        "C_occ_parallel_mixed": {"avg": c, "runs_count": len(c_runs)},
    },
}
with open(RESULTS_FILE, "w") as f:
    json.dump(output, f, indent=2)

print(f"\nResults saved to {RESULTS_FILE}")
print(f"{B}{G}Benchmark complete!{W}")
