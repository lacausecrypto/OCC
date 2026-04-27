/**
 * Canvas connection context — turn a node's incoming/outgoing edges into a
 * piece of structured text the agent can use as working context.
 *
 * Used by the Terminal canvas item so that connecting it to a Portal / File /
 * Obsidian Note / Sticky / etc. actually feeds the agent the upstream content
 * (URL, file body, markdown, etc.) instead of leaving the connection purely
 * decorative.
 *
 * For interactive Portal nodes (Playwright sessions running on the backend)
 * we also fetch a LIVE DOM snapshot — that's how a Terminal Agent connected
 * to e.g. Hyperliquid sees current prices/positions, not just the URL.
 */
import type { CanvasNode, CanvasEdge } from "../types/canvas";
import { getPortalSnapshot } from "../api/portal";

/** Cap injected content per node so a huge file doesn't blow up the prompt. */
const MAX_CONTENT_PER_NODE = 4000;

/**
 * All directly-connected canvas-item nodes (both directions). We don't follow
 * the graph transitively — context follows the user's mental model of "the
 * things I drew a line to".
 */
export function getConnectedCanvasNodes(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): { upstream: CanvasNode[]; downstream: CanvasNode[] } {
  const upstream: CanvasNode[] = [];
  const downstream: CanvasNode[] = [];
  for (const e of edges.values()) {
    if (e.to === nodeId) {
      const n = nodes.get(e.from);
      if (n && n.id !== nodeId) upstream.push(n);
    } else if (e.from === nodeId) {
      const n = nodes.get(e.to);
      if (n && n.id !== nodeId) downstream.push(n);
    }
  }
  return { upstream, downstream };
}

function trim(s: string | undefined, max = MAX_CONTENT_PER_NODE): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

/**
 * Render a canvas node as a textual context block the LLM can consume.
 * Returns an empty string for nodes with nothing useful to share (e.g. a
 * stale node with no content yet).
 *
 * Sync version — for interactive Portal nodes the live DOM snapshot is NOT
 * fetched here; use `formatNodeForLLMAsync` (or `buildConnectedContextAsync`)
 * if the LLM needs live page content.
 */
export function formatNodeForLLM(n: CanvasNode): string {
  const kind = n.kind ?? "step";
  const label = n.label || n.stepId || n.id;
  switch (kind) {
    case "portal": {
      if (!n.portalUrl) return "";
      const meta: string[] = [];
      if (n.portalTitle) meta.push(`Title: ${n.portalTitle}`);
      if (n.portalDescription) meta.push(`Description: ${n.portalDescription}`);
      return [`Portal "${label}" — URL: ${n.portalUrl}`, ...meta].join("\n");
    }
    case "file": {
      if (!n.filePath && !n.fileContent) return "";
      const head = n.filePath ? `File "${n.filePath}":` : `File "${label}":`;
      return n.fileContent ? `${head}\n\`\`\`\n${trim(n.fileContent)}\n\`\`\`` : head;
    }
    case "obsidian": {
      if (!n.obsidianContent && !n.obsidianNotePath) return "";
      const path = n.obsidianNotePath ? ` (${n.obsidianNotePath})` : "";
      const vault = n.obsidianVault ? ` [vault: ${n.obsidianVault}]` : "";
      const head = `Obsidian note "${label}"${path}${vault}:`;
      return n.obsidianContent ? `${head}\n\`\`\`markdown\n${trim(n.obsidianContent)}\n\`\`\`` : head;
    }
    case "sticky": {
      const text = n.stickyText?.trim();
      if (!text) return "";
      return `Sticky note "${label}":\n${trim(text, 1000)}`;
    }
    case "text": {
      const md = n.markdown?.trim();
      if (!md) return "";
      return `Text block "${label}":\n${trim(md, 2000)}`;
    }
    case "link": {
      if (!n.linkUrl) return "";
      return `Link "${n.linkTitle || label}": ${n.linkUrl}`;
    }
    case "terminal": {
      const msgs = n.terminalMessages ?? [];
      if (msgs.length === 0) return `Connected agent "${label}" (no messages yet)`;
      const recent = msgs.slice(-4)
        .map((m) => `  ${m.role}: ${trim(m.content, 300)}`)
        .join("\n");
      return `Connected agent "${label}" (model: ${n.terminalModel ?? "?"}) — recent exchange:\n${recent}`;
    }
    case "step": {
      // Workflow step — share its prompt/output_var so the agent knows what role it plays.
      const parts: string[] = [`Workflow step "${label}" (type: ${n.type ?? "agent"})`];
      if (n.outputVar) parts.push(`output_var: ${n.outputVar}`);
      if (n.prompt) parts.push(`prompt: ${trim(n.prompt, 500)}`);
      return parts.join("\n");
    }
    default:
      return "";
  }
}

/**
 * Build the full "Connected canvas items" context block for a node.
 * Returns an empty string if the node has no useful neighbours — caller can
 * skip injecting anything in that case.
 *
 * Sync — interactive Portal nodes only emit URL+title. For live DOM text
 * (current prices on a trading page, etc.) use `buildConnectedContextAsync`.
 */
export function buildConnectedContext(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): string {
  const { upstream, downstream } = getConnectedCanvasNodes(nodeId, nodes, edges);
  const parts: string[] = [];

  const upBlocks = upstream.map(formatNodeForLLM).filter(Boolean);
  if (upBlocks.length > 0) {
    parts.push("[Upstream connected items — these feed into you]");
    parts.push(...upBlocks.map((b) => `\n${b}`));
  }

  const downBlocks = downstream.map(formatNodeForLLM).filter(Boolean);
  if (downBlocks.length > 0) {
    parts.push(`\n[Downstream connected items — these consume your output]`);
    parts.push(...downBlocks.map((b) => `\n${b}`));
  }

  if (parts.length === 0) return "";

  return [
    "── Connected canvas context ──",
    "You are connected to the following items on the canvas. Treat their content as authoritative working context for this conversation.",
    "",
    ...parts,
    "",
    "── End connected context ──",
  ].join("\n");
}

/**
 * Async version that, for each interactive Portal node connected to `nodeId`,
 * fetches a live DOM snapshot from the backend Playwright session and
 * inlines it into the agent's context. Falls back to the sync block (URL
 * only) if no live session is running.
 *
 * This is the function that powers "the Terminal Agent reads the live
 * trading page, not just its URL".
 */
export async function buildConnectedContextAsync(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): Promise<string> {
  const { upstream, downstream } = getConnectedCanvasNodes(nodeId, nodes, edges);

  const renderBlock = async (n: CanvasNode): Promise<string> => {
    // Interactive portal → try live snapshot. If anything fails (session
    // missing, snapshot empty), fall through to the static URL line so the
    // agent still gets *something* useful.
    if ((n.kind ?? "step") === "portal" && n.portalMode === "interactive" && n.portalUrl) {
      const persistKey = n.portalPersistKey ?? n.id;
      const snap = await getPortalSnapshot({ persistKey });
      if (snap && snap.text) {
        const head = `Portal "${n.label || n.id}" — URL: ${snap.url}`;
        const title = snap.title ? `Title: ${snap.title}` : "";
        const trimmedFlag = snap.truncated ? "\n[…truncated]" : "";
        return [
          head,
          title,
          "Live page content (visible text, captured at message time):",
          "```",
          snap.text + trimmedFlag,
          "```",
        ].filter(Boolean).join("\n");
      }
    }
    return formatNodeForLLM(n);
  };

  const upBlocks = (await Promise.all(upstream.map(renderBlock))).filter(Boolean);
  const downBlocks = (await Promise.all(downstream.map(renderBlock))).filter(Boolean);

  const parts: string[] = [];
  if (upBlocks.length > 0) {
    parts.push("[Upstream connected items — these feed into you]");
    parts.push(...upBlocks.map((b) => `\n${b}`));
  }
  if (downBlocks.length > 0) {
    parts.push(`\n[Downstream connected items — these consume your output]`);
    parts.push(...downBlocks.map((b) => `\n${b}`));
  }
  if (parts.length === 0) return "";

  return [
    "── Connected canvas context ──",
    "You are connected to the following items on the canvas. For Portal items, the LIVE page text is included — treat it as the up-to-date state of the page.",
    "",
    ...parts,
    "",
    "── End connected context ──",
  ].join("\n");
}
