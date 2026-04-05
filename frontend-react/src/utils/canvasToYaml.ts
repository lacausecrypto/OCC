// ─── Convert canvas state to chain YAML ──────────────────────────────────────

import type { CanvasNode, CanvasEdge } from "../types/canvas";

/**
 * Serialize canvas nodes + edges back into a YAML chain definition string.
 * Produces output compatible with the OCC chain format.
 */
export function canvasToYaml(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
  chainName: string,
  description?: string,
): string {
  if (nodes.size === 0) return "";

  // Build dependency map: nodeId → list of upstream nodeIds
  const depsMap = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const deps = depsMap.get(edge.to) ?? [];
    deps.push(edge.from);
    depsMap.set(edge.to, deps);
  }

  // Topological sort for consistent ordering
  const sorted = topoSort(nodes, edges);

  const lines: string[] = [];
  lines.push(`name: ${yamlStr(chainName)}`);
  if (description) lines.push(`description: ${yamlStr(description)}`);
  lines.push("version: '1.0'");

  // Detect inputs from {input.*} patterns in prompts
  const inputs = detectInputs(nodes);
  if (inputs.length > 0) {
    lines.push("inputs:");
    for (const inp of inputs) {
      lines.push(`  - name: ${yamlStr(inp)}`);
      lines.push(`    description: ""`);
    }
  }

  lines.push("");
  lines.push("steps:");

  for (const nodeId of sorted) {
    const node = nodes.get(nodeId);
    if (!node) continue;

    const stepId = sanitizeId(node.stepId || node.label || nodeId);
    const type = node.type ?? "agent";

    lines.push(`  - id: ${yamlStr(stepId)}`);
    lines.push(`    type: ${type}`);
    if (node.label && node.label !== stepId) {
      lines.push(`    label: ${yamlStr(node.label)}`);
    }
    if (node.model) {
      lines.push(`    model: ${node.model}`);
    }

    // Prompt (always emit, even if empty — required by backend schema)
    const prompt = node.prompt || "TODO: add prompt";
    if (prompt.includes("\n")) {
      lines.push("    prompt: |");
      for (const pl of prompt.split("\n")) {
        lines.push(`      ${pl}`);
      }
    } else {
      lines.push(`    prompt: ${yamlStr(prompt)}`);
    }

    // Tools
    if (node.tools && node.tools.length > 0) {
      lines.push(`    tools: [${node.tools.map(yamlStr).join(", ")}]`);
    }

    // Pre-tools
    if (node.preTools && node.preTools.length > 0) {
      lines.push("    pre_tools:");
      for (const pt of node.preTools) {
        lines.push(`      - type: ${pt.type}`);
        lines.push(`        inject_as: ${yamlStr(pt.inject_as)}`);
        // Include relevant fields based on type
        for (const [k, v] of Object.entries(pt)) {
          if (["type", "inject_as", "on_error", "timeout_ms", "retry", "cache_ttl_minutes", "parallel"].includes(k)) continue;
          if (v === undefined || v === null || v === "") continue;
          if (typeof v === "object") continue;
          lines.push(`        ${k}: ${yamlStr(String(v))}`);
        }
        if (pt.on_error) lines.push(`        on_error: ${pt.on_error}`);
        if (pt.timeout_ms) lines.push(`        timeout_ms: ${pt.timeout_ms}`);
      }
    }

    // Dependencies
    const deps = depsMap.get(nodeId);
    if (deps && deps.length > 0) {
      const depIds = deps.map((d) => {
        const dn = nodes.get(d);
        return sanitizeId(dn?.stepId || dn?.label || d);
      });
      lines.push(`    depends_on: [${depIds.map(yamlStr).join(", ")}]`);
    }

    // Output var
    const outputVar = node.outputVar || `${stepId}_out`;
    lines.push(`    output_var: ${yamlStr(outputVar)}`);

    // Advanced config
    const adv = node.advanced;
    if (adv) {
      if (adv.timeout_ms) lines.push(`    timeout_ms: ${adv.timeout_ms}`);
      if (adv.condition) lines.push(`    condition: ${yamlStr(adv.condition)}`);
      if (adv.early_exit_if) lines.push(`    early_exit_if: ${yamlStr(adv.early_exit_if)}`);
      if (adv.retry) {
        lines.push("    retry:");
        lines.push(`      max: ${adv.retry.max}`);
        if (adv.retry.delay_ms) lines.push(`      delay_ms: ${adv.retry.delay_ms}`);
        if (adv.retry.backoff) lines.push(`      backoff: ${adv.retry.backoff}`);
      }
      if (adv.cache?.enabled) {
        lines.push("    cache:");
        lines.push("      enabled: true");
        if (adv.cache.ttl_minutes) lines.push(`      ttl_minutes: ${adv.cache.ttl_minutes}`);
      }
      // Type-specific fields
      if (type === "router" && adv.routes) {
        lines.push("    routes:");
        for (const [key, targets] of Object.entries(adv.routes)) {
          lines.push(`      ${yamlStr(key)}: [${targets.map(yamlStr).join(", ")}]`);
        }
        if (adv.default_route) lines.push(`    default_route: ${yamlStr(adv.default_route)}`);
      }
      if (type === "evaluator") {
        if (adv.input_var) lines.push(`    input_var: ${yamlStr(adv.input_var)}`);
        if (adv.criteria) lines.push(`    criteria: ${yamlStr(adv.criteria)}`);
        if (adv.on_fail) lines.push(`    on_fail: ${adv.on_fail}`);
      }
      if (type === "gate") {
        if (adv.timeout_hours) lines.push(`    timeout_hours: ${adv.timeout_hours}`);
        if (adv.on_timeout) lines.push(`    on_timeout: ${adv.on_timeout}`);
      }
      if (type === "transform" && adv.operation) {
        lines.push(`    operation: ${adv.operation}`);
        if (adv.json_path) lines.push(`    json_path: ${yamlStr(adv.json_path)}`);
        if (adv.regex) lines.push(`    regex: ${yamlStr(adv.regex)}`);
        if (adv.template_str) lines.push(`    template_str: ${yamlStr(adv.template_str)}`);
      }
      if (type === "loop") {
        if (adv.items_var) lines.push(`    items_var: ${yamlStr(adv.items_var)}`);
        if (adv.max_parallel) lines.push(`    max_parallel: ${adv.max_parallel}`);
      }
      if (type === "merge") {
        if (adv.inputs) lines.push(`    inputs: [${adv.inputs.map(yamlStr).join(", ")}]`);
        if (adv.strategy) lines.push(`    strategy: ${adv.strategy}`);
      }
      if (type === "webhook") {
        if (adv.webhook_url) lines.push(`    url: ${yamlStr(adv.webhook_url)}`);
        if (adv.webhook_method) lines.push(`    webhook_method: ${adv.webhook_method}`);
      }
      if (type === "subchain") {
        if (adv.subchain) lines.push(`    subchain: ${yamlStr(adv.subchain)}`);
      }
      if (type === "debate") {
        if (adv.debate_rounds) lines.push(`    debate_rounds: ${adv.debate_rounds}`);
        if (adv.debate_decision) lines.push(`    debate_decision: ${adv.debate_decision}`);
      }
      if (type === "browser") {
        if (adv.browser_url) lines.push(`    browser_url: ${yamlStr(adv.browser_url)}`);
        if (adv.browser_task) lines.push(`    browser_task: ${yamlStr(adv.browser_task)}`);
      }
    }

    lines.push("");
  }

  // Output: last step's output_var
  const lastNode = nodes.get(sorted[sorted.length - 1]);
  const outputVar = lastNode?.outputVar || "final_output";
  lines.push(`output: ${yamlStr(outputVar)}`);

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function yamlStr(s: string): string {
  if (!s) return '""';
  // Quote if contains special chars or could be interpreted as non-string
  if (/[:#{}[\],&*?|>!%@`'"\\]/.test(s) || s.includes("\n") || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function sanitizeId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function detectInputs(nodes: Map<string, CanvasNode>): string[] {
  const inputs = new Set<string>();
  for (const node of nodes.values()) {
    const matches = (node.prompt || "").matchAll(/\{input\.(\w+)\}/g);
    for (const m of matches) {
      inputs.add(m[1]);
    }
  }
  return [...inputs].sort();
}

function topoSort(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): string[] {
  const inDeg = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const id of nodes.keys()) {
    inDeg.set(id, 0);
    children.set(id, []);
  }
  for (const e of edges.values()) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    children.get(e.from)?.push(e.to);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const child of children.get(cur) ?? []) {
      const d = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  // Add any remaining nodes (cycles or disconnected)
  for (const id of nodes.keys()) {
    if (!sorted.includes(id)) sorted.push(id);
  }

  return sorted;
}
