#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# OCC Benchmark — Compare 3 LLM providers on identical text analysis
# Usage: bash chains/run-benchmark.sh [URL] [RUNS]
# ═══════════════════════════════════════════════════════════════════════
set -eo pipefail

API="http://localhost:4242"
URL="${1:-https://en.wikipedia.org/wiki/Large_language_model}"
RUNS="${2:-5}"
RESULTS_FILE="chains/benchmark-results.json"

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' B='\033[0;34m' C='\033[0;36m' W='\033[0m' BOLD='\033[1m'

CHAINS=("bench-claude" "bench-ollama" "bench-huggingface")
LABELS=("Claude Haiku 4.5" "Ollama llama3.2:1b" "HuggingFace Llama-3.2-1B")

# ─── Prerequisite checks ────────────────────────────────────────────────
echo -e "${BOLD}${C}══════════════════════════════════════════════════${W}"
echo -e "${BOLD}${C}  OCC LLM Benchmark — 3 Providers × ${RUNS} Runs${W}"
echo -e "${BOLD}${C}══════════════════════════════════════════════════${W}"
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
  if ! curl -sf "${API}/chains/${chain}" > /dev/null 2>&1; then
    echo -e "${R}[FAIL]${W} Chain '${chain}' not found. Make sure chains/*.yaml are in CHAINS_DIR"
    exit 1
  fi
done
echo -e "${G}[OK]${W} All 3 benchmark chains found"
echo ""

echo -e "${BOLD}URL:${W} ${URL}"
echo -e "${BOLD}Runs per chain:${W} ${RUNS}"
echo ""

# ─── Run benchmarks ─────────────────────────────────────────────────────

# JSON accumulator
JSON_RESULTS="[]"

for ci in "${!CHAINS[@]}"; do
  chain="${CHAINS[$ci]}"
  label="${LABELS[$ci]}"

  echo -e "${BOLD}${Y}━━━ ${label} ━━━${W}"

  EXEC_IDS=()
  DURATIONS=()
  INPUT_TOKENS=()
  OUTPUT_TOKENS=()
  LLM_DURATIONS=()
  SUCCESSES=0
  VALID_JSON=0

  for run in $(seq 1 "$RUNS"); do
    echo -ne "  Run ${run}/${RUNS}... "

    # Execute chain
    RESPONSE=$(curl -s -X POST "${API}/execute/${chain}" \
      -H "Content-Type: application/json" \
      -d "{\"input\": {\"url\": \"${URL}\"}}" 2>&1)
    HTTP_ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || echo "")
    if [ -n "$HTTP_ERR" ]; then
      echo -e "${R}ERROR: ${HTTP_ERR}${W}"
      continue
    fi

    EXEC_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('executionId',''))" 2>/dev/null || echo "")
    if [ -z "$EXEC_ID" ]; then
      echo -e "${R}No executionId returned${W}"
      continue
    fi

    EXEC_IDS+=("$EXEC_ID")

    # Poll until done (max 5 minutes)
    STATUS="running"
    ELAPSED=0
    while [ "$STATUS" = "running" ] || [ "$STATUS" = "queued" ]; do
      sleep 2
      ELAPSED=$((ELAPSED + 2))
      EXEC_DATA=$(curl -sf "${API}/executions/${EXEC_ID}" 2>/dev/null || echo "{}")
      STATUS=$(echo "$EXEC_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")

      if [ "$ELAPSED" -ge 300 ]; then
        echo -e "${R}TIMEOUT (5min)${W}"
        STATUS="timeout"
        break
      fi
    done

    if [ "$STATUS" = "done" ]; then
      SUCCESSES=$((SUCCESSES + 1))

      # Extract metrics
      DURATION=$(echo "$EXEC_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs', 0))" 2>/dev/null || echo "0")
      IN_TOK=$(echo "$EXEC_DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
steps=d.get('steps',{})
total=0
for s in steps.values():
  total += s.get('inputTokens',0) or 0
print(total)" 2>/dev/null || echo "0")
      OUT_TOK=$(echo "$EXEC_DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
steps=d.get('steps',{})
total=0
for s in steps.values():
  total += s.get('outputTokens',0) or 0
print(total)" 2>/dev/null || echo "0")
      LLM_DUR=$(echo "$EXEC_DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
steps=d.get('steps',{})
a=steps.get('analyze',{})
print(a.get('durationMs',0) or 0)" 2>/dev/null || echo "0")

      # Check if output is valid JSON
      IS_JSON=$(echo "$EXEC_DATA" | python3 -c "
import sys,json,re
d=json.load(sys.stdin)
result=d.get('result','')
# Strip markdown code fences if present
result=re.sub(r'^\s*\`\`\`json?\s*\n?','',result)
result=re.sub(r'\n?\s*\`\`\`\s*$','',result)
try:
  j=json.loads(result)
  print('1' if 'title' in j and 'summary' in j else '0')
except: print('0')" 2>/dev/null || echo "0")
      VALID_JSON=$((VALID_JSON + IS_JSON))

      DURATIONS+=("$DURATION")
      INPUT_TOKENS+=("$IN_TOK")
      OUTPUT_TOKENS+=("$OUT_TOK")
      LLM_DURATIONS+=("$LLM_DUR")

      echo -e "${G}OK${W} — ${DURATION}ms, ${IN_TOK}→${OUT_TOK} tok"
    else
      echo -e "${R}${STATUS}${W}"
      # Store 0s for failed runs
      DURATIONS+=(0)
      INPUT_TOKENS+=(0)
      OUTPUT_TOKENS+=(0)
      LLM_DURATIONS+=(0)
    fi
  done

  # ─── Compute averages ────────────────────────────────────────────────
  # Join arrays with commas for python
  DUR_CSV=$(IFS=,; echo "${DURATIONS[*]}")
  IN_CSV=$(IFS=,; echo "${INPUT_TOKENS[*]}")
  OUT_CSV=$(IFS=,; echo "${OUTPUT_TOKENS[*]}")
  LLM_CSV=$(IFS=,; echo "${LLM_DURATIONS[*]}")

  if [ "$SUCCESSES" -gt 0 ]; then
    AVG_DUR=$(python3 -c "
d=[${DUR_CSV}]
v=[x for x in d if x>0]
print(round(sum(v)/len(v)) if v else 0)")
    AVG_IN=$(python3 -c "
d=[${IN_CSV}]
v=[x for x in d if x>0]
print(round(sum(v)/len(v)) if v else 0)")
    AVG_OUT=$(python3 -c "
d=[${OUT_CSV}]
v=[x for x in d if x>0]
print(round(sum(v)/len(v)) if v else 0)")
    AVG_LLM=$(python3 -c "
d=[${LLM_CSV}]
v=[x for x in d if x>0]
print(round(sum(v)/len(v)) if v else 0)")
    MIN_DUR=$(python3 -c "
d=[${DUR_CSV}]
v=[x for x in d if x>0]
print(min(v) if v else 0)")
    MAX_DUR=$(python3 -c "
d=[${DUR_CSV}]
v=[x for x in d if x>0]
print(max(v) if v else 0)")
  else
    AVG_DUR=0; AVG_IN=0; AVG_OUT=0; AVG_LLM=0; MIN_DUR=0; MAX_DUR=0
  fi

  # Cost estimation (per 1M tokens)
  COST=$(python3 -c "
label='${label}'
avg_in=${AVG_IN}; avg_out=${AVG_OUT}
if 'Claude' in label:
  cost = (avg_in * 0.25 + avg_out * 1.25) / 1_000_000
elif 'Ollama' in label:
  cost = 0.0  # local, free
else:
  cost = 0.0  # HuggingFace free tier
print(f'{cost:.6f}')")

  echo -e "  ${BOLD}Results:${W} ${SUCCESSES}/${RUNS} success, ${VALID_JSON}/${SUCCESSES} valid JSON"
  echo -e "  Avg duration: ${AVG_DUR}ms (min: ${MIN_DUR}, max: ${MAX_DUR})"
  echo -e "  Avg LLM time: ${AVG_LLM}ms"
  echo -e "  Avg tokens: ${AVG_IN} in → ${AVG_OUT} out"
  echo -e "  Est. cost/run: \$${COST}"
  echo ""

  # Append to JSON
  JSON_RESULTS=$(python3 -c "
import json
results = json.loads('${JSON_RESULTS}')
results.append({
  'provider': '${label}',
  'chain': '${chain}',
  'runs': ${RUNS},
  'successes': ${SUCCESSES},
  'valid_json': ${VALID_JSON},
  'avg_duration_ms': ${AVG_DUR},
  'min_duration_ms': ${MIN_DUR},
  'max_duration_ms': ${MAX_DUR},
  'avg_llm_duration_ms': ${AVG_LLM},
  'avg_input_tokens': ${AVG_IN},
  'avg_output_tokens': ${AVG_OUT},
  'estimated_cost_usd': float('${COST}'),
  'execution_ids': $(python3 -c "import json; print(json.dumps([$(if [ ${#EXEC_IDS[@]} -gt 0 ]; then printf '"%s",' "${EXEC_IDS[@]}" | sed 's/,$//'; fi)]))")
})
print(json.dumps(results))")
done

# ─── Summary table ───────────────────────────────────────────────────────
echo -e "${BOLD}${C}══════════════════════════════════════════════════════════════════════════════${W}"
echo -e "${BOLD}${C}  BENCHMARK RESULTS${W}"
echo -e "${BOLD}${C}══════════════════════════════════════════════════════════════════════════════${W}"

python3 -c "
import json

results = json.loads('$(echo "$JSON_RESULTS" | sed "s/'/\\\\'/g")')

# Header
print(f'  {\"Provider\":<28} {\"Avg Dur\":>9} {\"LLM Dur\":>9} {\"In Tok\":>8} {\"Out Tok\":>9} {\"Cost\":>10} {\"OK\":>5} {\"JSON\":>5}')
print(f'  {\"─\"*28} {\"─\"*9} {\"─\"*9} {\"─\"*8} {\"─\"*9} {\"─\"*10} {\"─\"*5} {\"─\"*5}')

for r in results:
    dur = f\"{r['avg_duration_ms']/1000:.1f}s\" if r['avg_duration_ms'] > 0 else 'N/A'
    llm = f\"{r['avg_llm_duration_ms']/1000:.1f}s\" if r['avg_llm_duration_ms'] > 0 else 'N/A'
    cost = f\"\${r['estimated_cost_usd']:.6f}\"
    ok = f\"{r['successes']}/{r['runs']}\"
    vj = f\"{r['valid_json']}/{r['successes']}\" if r['successes'] > 0 else '0/0'
    print(f'  {r[\"provider\"]:<28} {dur:>9} {llm:>9} {r[\"avg_input_tokens\"]:>8} {r[\"avg_output_tokens\"]:>9} {cost:>10} {ok:>5} {vj:>5}')

print()

# Winner analysis
if all(r['successes'] > 0 for r in results):
    fastest = min(results, key=lambda r: r['avg_duration_ms'])
    cheapest = min(results, key=lambda r: r['estimated_cost_usd'])
    most_tokens = max(results, key=lambda r: r['avg_output_tokens'])
    best_json = max(results, key=lambda r: r['valid_json'])

    print(f'  Fastest:       {fastest[\"provider\"]} ({fastest[\"avg_duration_ms\"]/1000:.1f}s)')
    print(f'  Cheapest:      {cheapest[\"provider\"]} (\${cheapest[\"estimated_cost_usd\"]:.6f})')
    print(f'  Most verbose:  {most_tokens[\"provider\"]} ({most_tokens[\"avg_output_tokens\"]} tokens)')
    print(f'  Best JSON:     {best_json[\"provider\"]} ({best_json[\"valid_json\"]}/{best_json[\"runs\"]})')
"

echo ""

# ─── Save results ────────────────────────────────────────────────────────
python3 -c "
import json
from datetime import datetime

results = json.loads('$(echo "$JSON_RESULTS" | sed "s/'/\\\\'/g")')
output = {
  'benchmark': 'OCC LLM Provider Comparison',
  'timestamp': datetime.utcnow().isoformat() + 'Z',
  'url': '${URL}',
  'runs_per_chain': ${RUNS},
  'results': results
}

with open('${RESULTS_FILE}', 'w') as f:
  json.dump(output, f, indent=2)

print(f'Results saved to ${RESULTS_FILE}')
"

echo -e "${BOLD}${G}Benchmark complete!${W}"
