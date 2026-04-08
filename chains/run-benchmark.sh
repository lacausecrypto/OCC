#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# OCC Benchmark — Compare 3 LLM providers on identical multi-step tasks
# Usage: bash chains/run-benchmark.sh [TOPIC] [RUNS]
#
# Each chain runs 4 steps (3 parallel + 1 merge):
#   1. Comprehension — summarize a fixed text
#   2. Generation    — produce pros/cons list
#   3. Structuration — output strict JSON
#   4. Merge         — combine all into final report
#
# Metrics per run: total duration, per-step tokens (in/out), per-step
# duration, JSON validity, total cost estimate.
# ═══════════════════════════════════════════════════════════════════════
set -eo pipefail

API="http://localhost:4242"
TOPIC="${1:-artificial intelligence}"
RUNS="${2:-5}"
RESULTS_FILE="chains/benchmark-results.json"
STEP_IDS=("comprehension" "generation" "structuration" "merge")

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' B='\033[0;34m' C='\033[0;36m' DIM='\033[2m' W='\033[0m' BOLD='\033[1m'

CHAINS=("bench-claude" "bench-ollama" "bench-huggingface")
LABELS=("Claude Haiku 4.5" "Ollama llama3.2:1b" "HuggingFace Llama-3.2-1B")

# ─── Prerequisite checks ────────────────────────────────────────────────
echo -e "${BOLD}${C}══════════════════════════════════════════════════════════${W}"
echo -e "${BOLD}${C}  OCC LLM Benchmark — 3 Providers × ${RUNS} Runs × 4 Steps${W}"
echo -e "${BOLD}${C}══════════════════════════════════════════════════════════${W}"
echo ""

echo -e "${B}[check]${W} OCC server at ${API}..."
if ! curl -sf "${API}/health" > /dev/null 2>&1; then
  echo -e "${R}[FAIL]${W} OCC server not running. Start with: cd mcp-server && npm run rest"
  exit 1
fi
echo -e "${G}[OK]${W} OCC server is up"

echo -e "${B}[check]${W} Ollama at localhost:11434..."
if ! curl -sf "http://localhost:11434/api/tags" > /dev/null 2>&1; then
  echo -e "${Y}[WARN]${W} Ollama not running — bench-ollama will likely fail"
else
  echo -e "${G}[OK]${W} Ollama is up"
fi

echo -e "${B}[check]${W} Chains exist..."
for chain in "${CHAINS[@]}"; do
  if ! curl -sf "${API}/chains" 2>/dev/null | python3 -c "import sys,json; chains=json.load(sys.stdin); exit(0 if any(c['name']=='${chain}' for c in chains) else 1)" 2>/dev/null; then
    echo -e "${R}[FAIL]${W} Chain '${chain}' not found"
    exit 1
  fi
done
echo -e "${G}[OK]${W} All 3 benchmark chains found"
echo ""

echo -e "${BOLD}Topic:${W} ${TOPIC}"
echo -e "${BOLD}Runs per chain:${W} ${RUNS}"
echo -e "${BOLD}Steps per run:${W} comprehension → generation → structuration → merge"
echo ""

# ─── Run benchmarks ─────────────────────────────────────────────────────
JSON_RESULTS="[]"

for ci in "${!CHAINS[@]}"; do
  chain="${CHAINS[$ci]}"
  label="${LABELS[$ci]}"

  echo -e "${BOLD}${Y}━━━ ${label} ━━━${W}"

  EXEC_IDS=()
  ALL_RUNS_JSON="[]"
  SUCCESSES=0

  for run in $(seq 1 "$RUNS"); do
    echo -ne "  Run ${run}/${RUNS}... "

    # Execute chain with topic input
    RESPONSE=$(curl -s -X POST "${API}/execute/${chain}" \
      -H "Content-Type: application/json" \
      -d "{\"input\": {\"topic\": \"${TOPIC}\"}}" 2>&1)
    HTTP_ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || echo "")
    if [ -n "$HTTP_ERR" ]; then
      echo -e "${R}ERROR: ${HTTP_ERR}${W}"
      continue
    fi

    EXEC_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('executionId',''))" 2>/dev/null || echo "")
    if [ -z "$EXEC_ID" ]; then
      echo -e "${R}No executionId${W}"
      continue
    fi
    EXEC_IDS+=("$EXEC_ID")

    # Poll until done (max 5 minutes)
    STATUS="running"
    ELAPSED=0
    while [ "$STATUS" = "running" ] || [ "$STATUS" = "queued" ]; do
      sleep 3
      ELAPSED=$((ELAPSED + 3))
      EXEC_DATA=$(curl -sf "${API}/executions/${EXEC_ID}" 2>/dev/null || echo "{}")
      STATUS=$(echo "$EXEC_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")
      if [ "$ELAPSED" -ge 300 ]; then
        STATUS="timeout"
        break
      fi
    done

    if [ "$STATUS" = "done" ]; then
      SUCCESSES=$((SUCCESSES + 1))

      # Extract detailed per-step metrics + quality checks
      RUN_JSON=$(echo "$EXEC_DATA" | python3 -c "
import sys, json, re

d = json.load(sys.stdin)
steps = d.get('steps', {})
run = {
  'executionId': d.get('id', ''),
  'status': d.get('status', ''),
  'totalDurationMs': d.get('durationMs', 0) or 0,
  'totalInputTokens': 0,
  'totalOutputTokens': 0,
  'steps': {},
  'quality': {}
}

for sid in ['comprehension', 'generation', 'structuration', 'merge']:
  s = steps.get(sid, {})
  inTok = s.get('inputTokens', 0) or 0
  outTok = s.get('outputTokens', 0) or 0
  dur = s.get('durationMs', 0) or 0
  run['totalInputTokens'] += inTok
  run['totalOutputTokens'] += outTok
  run['steps'][sid] = {
    'inputTokens': inTok,
    'outputTokens': outTok,
    'durationMs': dur,
    'status': s.get('status', 'missing')
  }

# Quality checks
comp = steps.get('comprehension', {}).get('output', '')
gen = steps.get('generation', {}).get('output', '')
struct_raw = steps.get('structuration', {}).get('output', '')
merge_out = steps.get('merge', {}).get('output', '')

# Q1: Comprehension — did it produce ~3 sentences?
sentences = [s.strip() for s in re.split(r'[.!?]+', comp) if s.strip()]
run['quality']['comprehension_sentences'] = len(sentences)
run['quality']['comprehension_ok'] = 2 <= len(sentences) <= 5

# Q2: Generation — did it produce numbered items?
pros_cons = re.findall(r'^\d+\.', gen, re.MULTILINE)
run['quality']['generation_items'] = len(pros_cons)
run['quality']['generation_ok'] = len(pros_cons) >= 6  # at least 6 of 10

# Q3: Structuration — valid JSON with expected keys?
struct_clean = re.sub(r'^\s*\x60\x60\x60json?\s*\n?', '', struct_raw)
struct_clean = re.sub(r'\n?\s*\x60\x60\x60\s*$', '', struct_clean)
try:
  j = json.loads(struct_clean)
  has_keys = all(k in j for k in ['name', 'category', 'score', 'pros', 'cons', 'summary'])
  run['quality']['structuration_valid_json'] = True
  run['quality']['structuration_has_keys'] = has_keys
except:
  run['quality']['structuration_valid_json'] = False
  run['quality']['structuration_has_keys'] = False

# Q4: Merge — non-empty?
run['quality']['merge_length'] = len(merge_out)
run['quality']['merge_ok'] = len(merge_out) > 20

# Overall quality score (0-4)
score = sum([
  run['quality']['comprehension_ok'],
  run['quality']['generation_ok'],
  run['quality']['structuration_valid_json'] and run['quality']['structuration_has_keys'],
  run['quality']['merge_ok']
])
run['quality']['score'] = score

print(json.dumps(run))
" 2>/dev/null || echo "{}")

      # Display summary
      TOTAL_DUR=$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalDurationMs',0))")
      TOTAL_IN=$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalInputTokens',0))")
      TOTAL_OUT=$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalOutputTokens',0))")
      QUALITY=$(echo "$RUN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('quality',{}).get('score',0))")

      echo -e "${G}OK${W} — ${TOTAL_DUR}ms, ${TOTAL_IN}→${TOTAL_OUT} tok, quality: ${QUALITY}/4"

      # Append run to array
      ALL_RUNS_JSON=$(python3 -c "
import json
runs = json.loads('''${ALL_RUNS_JSON}''')
runs.append(json.loads('''${RUN_JSON}'''))
print(json.dumps(runs))
")
    else
      echo -e "${R}${STATUS}${W}"
    fi
  done

  # ─── Compute aggregated stats ──────────────────────────────────────────
  PROVIDER_JSON=$(python3 -c "
import json

runs = json.loads('''${ALL_RUNS_JSON}''')
label = '${label}'
chain = '${chain}'
n = len(runs)

if n == 0:
  print(json.dumps({
    'provider': label, 'chain': chain, 'runs': ${RUNS},
    'successes': 0, 'steps': {}, 'quality': {}, 'totals': {}
  }))
  exit()

# Per-step aggregation
step_ids = ['comprehension', 'generation', 'structuration', 'merge']
step_stats = {}
for sid in step_ids:
  durations = [r['steps'][sid]['durationMs'] for r in runs if r['steps'].get(sid, {}).get('durationMs', 0) > 0]
  in_tokens = [r['steps'][sid]['inputTokens'] for r in runs if r['steps'].get(sid, {}).get('inputTokens', 0) > 0]
  out_tokens = [r['steps'][sid]['outputTokens'] for r in runs if r['steps'].get(sid, {}).get('outputTokens', 0) > 0]
  step_stats[sid] = {
    'avg_duration_ms': round(sum(durations)/len(durations)) if durations else 0,
    'avg_input_tokens': round(sum(in_tokens)/len(in_tokens)) if in_tokens else 0,
    'avg_output_tokens': round(sum(out_tokens)/len(out_tokens)) if out_tokens else 0,
  }

# Totals
total_durs = [r['totalDurationMs'] for r in runs if r['totalDurationMs'] > 0]
total_in = [r['totalInputTokens'] for r in runs]
total_out = [r['totalOutputTokens'] for r in runs]
quality_scores = [r['quality']['score'] for r in runs]

avg_dur = round(sum(total_durs)/len(total_durs)) if total_durs else 0
avg_in = round(sum(total_in)/n)
avg_out = round(sum(total_out)/n)
avg_quality = round(sum(quality_scores)/n, 1)

# Cost
if 'Claude' in label:
  cost = (avg_in * 0.25 + avg_out * 1.25) / 1_000_000
else:
  cost = 0.0

# Quality breakdown
q = {
  'avg_score': avg_quality,
  'comprehension_ok': sum(1 for r in runs if r['quality']['comprehension_ok']),
  'generation_ok': sum(1 for r in runs if r['quality']['generation_ok']),
  'json_valid': sum(1 for r in runs if r['quality']['structuration_valid_json']),
  'json_has_keys': sum(1 for r in runs if r['quality']['structuration_has_keys']),
  'merge_ok': sum(1 for r in runs if r['quality']['merge_ok']),
}

result = {
  'provider': label,
  'chain': chain,
  'runs': ${RUNS},
  'successes': n,
  'totals': {
    'avg_duration_ms': avg_dur,
    'min_duration_ms': min(total_durs) if total_durs else 0,
    'max_duration_ms': max(total_durs) if total_durs else 0,
    'avg_input_tokens': avg_in,
    'avg_output_tokens': avg_out,
    'estimated_cost_usd': round(cost, 8),
  },
  'steps': step_stats,
  'quality': q,
  'raw_runs': runs,
}

print(json.dumps(result))
")

  # Display provider summary
  python3 -c "
import json
p = json.loads('''${PROVIDER_JSON}''')
t = p['totals']
q = p['quality']
n = p['successes']

print(f'  Results: {n}/${RUNS} success')
print(f'  Avg total duration: {t[\"avg_duration_ms\"]}ms (min: {t[\"min_duration_ms\"]}, max: {t[\"max_duration_ms\"]})')
print(f'  Avg tokens: {t[\"avg_input_tokens\"]} in → {t[\"avg_output_tokens\"]} out')
print(f'  Est. cost/run: \${t[\"estimated_cost_usd\"]:.6f}')
print(f'  Quality: {q[\"avg_score\"]}/4.0 avg — comp:{q[\"comprehension_ok\"]}/{n} gen:{q[\"generation_ok\"]}/{n} json:{q[\"json_has_keys\"]}/{n} merge:{q[\"merge_ok\"]}/{n}')
print()
print(f'  Per-step breakdown:')
for sid, s in p['steps'].items():
  print(f'    {sid:<17} {s[\"avg_duration_ms\"]:>6}ms  {s[\"avg_input_tokens\"]:>6} in  {s[\"avg_output_tokens\"]:>6} out')
"
  echo ""

  # Append to global results
  JSON_RESULTS=$(python3 -c "
import json
results = json.loads('''${JSON_RESULTS}''')
results.append(json.loads('''${PROVIDER_JSON}'''))
print(json.dumps(results))
")
done

# ─── Summary table ───────────────────────────────────────────────────────
echo -e "${BOLD}${C}═══════════════════════════════════════════════════════════════════════════════════════${W}"
echo -e "${BOLD}${C}  BENCHMARK RESULTS${W}"
echo -e "${BOLD}${C}═══════════════════════════════════════════════════════════════════════════════════════${W}"

python3 -c "
import json

results = json.loads('''$(echo "$JSON_RESULTS")''')

print()
print(f'  {\"Provider\":<28} {\"Duration\":>10} {\"In Tok\":>8} {\"Out Tok\":>9} {\"Cost\":>12} {\"Success\":>8} {\"Quality\":>8}')
print(f'  {\"─\"*28} {\"─\"*10} {\"─\"*8} {\"─\"*9} {\"─\"*12} {\"─\"*8} {\"─\"*8}')

for r in results:
    t = r['totals']
    q = r['quality']
    dur = f'{t[\"avg_duration_ms\"]/1000:.1f}s' if t['avg_duration_ms'] > 0 else 'N/A'
    cost = f'\${t[\"estimated_cost_usd\"]:.6f}'
    ok = f'{r[\"successes\"]}/{r[\"runs\"]}'
    qs = f'{q[\"avg_score\"]}/4.0'
    print(f'  {r[\"provider\"]:<28} {dur:>10} {t[\"avg_input_tokens\"]:>8} {t[\"avg_output_tokens\"]:>9} {cost:>12} {ok:>8} {qs:>8}')

print()

# Per-step comparison
print(f'  {\"\":28}  {\"comprehension\":>15}  {\"generation\":>15}  {\"structuration\":>15}  {\"merge\":>15}')
print(f'  {\"─\"*28}  {\"─\"*15}  {\"─\"*15}  {\"─\"*15}  {\"─\"*15}')
for r in results:
    parts = []
    for sid in ['comprehension', 'generation', 'structuration', 'merge']:
        s = r['steps'].get(sid, {})
        d = s.get('avg_duration_ms', 0)
        parts.append(f'{d/1000:.1f}s' if d > 0 else 'N/A')
    print(f'  {r[\"provider\"]:<28}  {parts[0]:>15}  {parts[1]:>15}  {parts[2]:>15}  {parts[3]:>15}')

print()

# Winner analysis
successful = [r for r in results if r['successes'] > 0]
if len(successful) >= 2:
    fastest = min(successful, key=lambda r: r['totals']['avg_duration_ms'])
    cheapest = min(successful, key=lambda r: r['totals']['estimated_cost_usd'])
    most_verbose = max(successful, key=lambda r: r['totals']['avg_output_tokens'])
    best_quality = max(successful, key=lambda r: r['quality']['avg_score'])

    print(f'  🏆 Fastest:      {fastest[\"provider\"]} ({fastest[\"totals\"][\"avg_duration_ms\"]/1000:.1f}s)')
    print(f'  💰 Cheapest:     {cheapest[\"provider\"]} (\${cheapest[\"totals\"][\"estimated_cost_usd\"]:.6f})')
    print(f'  📝 Most output:  {most_verbose[\"provider\"]} ({most_verbose[\"totals\"][\"avg_output_tokens\"]} tokens)')
    print(f'  ⭐ Best quality: {best_quality[\"provider\"]} ({best_quality[\"quality\"][\"avg_score\"]}/4.0)')
"

echo ""

# ─── Save results ────────────────────────────────────────────────────────
python3 -c "
import json
from datetime import datetime

results = json.loads('''$(echo "$JSON_RESULTS")''')

# Strip raw_runs for cleaner output file
for r in results:
    r.pop('raw_runs', None)

output = {
  'benchmark': 'OCC LLM Provider Comparison',
  'version': '2.0',
  'timestamp': datetime.utcnow().isoformat() + 'Z',
  'config': {
    'topic': '${TOPIC}',
    'runs_per_chain': ${RUNS},
    'steps': ['comprehension', 'generation', 'structuration', 'merge'],
    'tasks': {
      'comprehension': 'Summarize a fixed 100-word AI text in 3 sentences',
      'generation': 'Produce 5 pros and 5 cons numbered list',
      'structuration': 'Output strict JSON with 6 required keys',
      'merge': 'Combine 3 outputs into 5-line report'
    }
  },
  'results': results
}

with open('${RESULTS_FILE}', 'w') as f:
  json.dump(output, f, indent=2)

print(f'Results saved to ${RESULTS_FILE}')
"

echo -e "${BOLD}${G}Benchmark complete!${W}"
