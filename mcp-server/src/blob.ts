/**
 * blob.ts — BLOB session management + LLM planning.
 * The BLOB is an organic, conversational graph that grows in real-time.
 * The LLM analyzes user prompts and decides how to grow the graph.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BlobSession {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  autonomous: boolean;
  autonomousIntervalMs?: number;
  lastAutonomousRun?: string;
  chatPrompt?: string;
  plannerPrompt?: string;
  nodeCount: number;
  edgeCount: number;
  messageCount: number;
  totalTokens: number;
}

export interface BlobPlanRequest {
  sessionId: string;
  userMessage: string;
  /** Existing branch topics for reuse detection */
  existingBranches: Array<{ id: string; topic: string; stepIds: string[] }>;
  /** Known concepts from knowledge graph */
  knownConcepts: string[];
  /** Recent conversation context */
  recentMessages: Array<{ role: string; content: string }>;
}

export interface BlobPlan {
  branches: Array<{
    topic: string;
    steps: Array<{
      type: string;
      label: string;
      prompt: string;
      model?: string;
      tools?: string[];
    }>;
  }>;
  reuseBranches: Array<{
    branchNodeId: string;
    forkAtStepId?: string;
    newSteps?: Array<{ type: string; label: string; prompt: string }>;
  }>;
  memoryUpdates: Array<{ concept: string; facts: string[] }>;
  directResponse?: string;
}

// ─── Session storage ────────────────────────────────────────────────────────

const BLOB_DIR = process.env.BLOB_DIR ?? path.join(process.cwd(), "blobs");

/** Validate sessionId to prevent path traversal */
function validateSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid sessionId format");
  }
  return sessionId;
}

function ensureBlobDir() {
  if (!fs.existsSync(BLOB_DIR)) fs.mkdirSync(BLOB_DIR, { recursive: true });
}

export function listBlobSessions(): BlobSession[] {
  ensureBlobDir();
  const indexPath = path.join(BLOB_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return [];
  try { return JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch { return []; }
}

function saveIndex(sessions: BlobSession[]) {
  ensureBlobDir();
  const target = path.join(BLOB_DIR, "index.json");
  const tmp = `${target}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, target);
}

export function createBlobSession(name: string, description?: string): BlobSession {
  const sessions = listBlobSessions();
  const session: BlobSession = {
    id: `blob_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name, description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabled: true, autonomous: false,
    nodeCount: 1, edgeCount: 0, messageCount: 0, totalTokens: 0,
  };
  sessions.push(session);
  saveIndex(sessions);
  logger.info("occ-blob", `Created session "${name}" (${session.id})`);
  return session;
}

export function updateBlobSession(id: string, patch: Partial<BlobSession>): BlobSession | null {
  const sessions = listBlobSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  sessions[idx] = { ...sessions[idx], ...patch, id, updatedAt: new Date().toISOString() };
  saveIndex(sessions);
  return sessions[idx];
}

export function deleteBlobSession(id: string): boolean {
  const sessions = listBlobSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  if (filtered.length === sessions.length) return false;
  saveIndex(filtered);
  // Remove graph data
  const dataPath = path.join(BLOB_DIR, `${id}.json`);
  if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath);
  logger.info("occ-blob", `Deleted session ${id}`);
  return true;
}

export function saveBlobGraph(sessionId: string, data: unknown): void {
  ensureBlobDir();
  const safe = validateSessionId(sessionId);
  try {
    const target = path.join(BLOB_DIR, `${safe}.json`);
    const tmp = `${target}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.error("occ-blob", `Failed to save graph for ${sessionId}: ${err}`);
  }
}

export function loadBlobGraph(sessionId: string): unknown {
  const safe = validateSessionId(sessionId);
  const dataPath = path.join(BLOB_DIR, `${safe}.json`);
  if (!fs.existsSync(dataPath)) return null;
  try { return JSON.parse(fs.readFileSync(dataPath, "utf-8")); } catch { return null; }
}

// ─── Knowledge graph ────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  concept: string;
  facts: string[];
  relatedConcepts: string[];
  sourceSessionIds: string[];
  sourceNodeIds: string[];
  createdAt: string;
  updatedAt: string;
  accessCount: number;
}

const KNOWLEDGE_PATH = path.join(BLOB_DIR, "knowledge.json");

export function loadKnowledge(): KnowledgeEntry[] {
  ensureBlobDir();
  if (!fs.existsSync(KNOWLEDGE_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8")); } catch { return []; }
}

function saveKnowledgeFile(entries: KnowledgeEntry[]) {
  ensureBlobDir();
  // Atomic write: write to tmp file then rename to prevent corruption
  const tmpPath = `${KNOWLEDGE_PATH}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpPath, KNOWLEDGE_PATH);
}

export function upsertKnowledge(concept: string, facts: string[], sessionId: string, nodeId: string): KnowledgeEntry {
  const entries = loadKnowledge();
  const existing = entries.find((k) => k.concept.toLowerCase() === concept.toLowerCase());

  if (existing) {
    existing.facts = [...new Set([...existing.facts, ...facts])];
    if (!existing.sourceSessionIds.includes(sessionId)) existing.sourceSessionIds.push(sessionId);
    if (!existing.sourceNodeIds.includes(nodeId)) existing.sourceNodeIds.push(nodeId);
    existing.updatedAt = new Date().toISOString();
    existing.accessCount++;
    saveKnowledgeFile(entries);
    return existing;
  }

  const entry: KnowledgeEntry = {
    id: `k_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    concept, facts,
    relatedConcepts: [],
    sourceSessionIds: [sessionId],
    sourceNodeIds: [nodeId],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessCount: 1,
  };
  entries.push(entry);
  saveKnowledgeFile(entries);
  return entry;
}

export function updateKnowledgeEntry(id: string, patch: Partial<KnowledgeEntry>): KnowledgeEntry | null {
  const entries = loadKnowledge();
  const idx = entries.findIndex((k) => k.id === id);
  if (idx < 0) return null;
  entries[idx] = { ...entries[idx], ...patch, id, updatedAt: new Date().toISOString() };
  saveKnowledgeFile(entries);
  return entries[idx];
}

export function deleteKnowledgeEntry(id: string): boolean {
  const entries = loadKnowledge();
  const filtered = entries.filter((k) => k.id !== id);
  if (filtered.length === entries.length) return false;
  saveKnowledgeFile(filtered);
  return true;
}

export function searchKnowledge(query: string): KnowledgeEntry[] {
  const q = query.toLowerCase();
  return loadKnowledge()
    .filter((k) => k.concept.toLowerCase().includes(q) || k.facts.some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => b.accessCount - a.accessCount);
}

export function linkConcepts(id1: string, id2: string): void {
  const entries = loadKnowledge();
  const e1 = entries.find((k) => k.id === id1);
  const e2 = entries.find((k) => k.id === id2);
  if (!e1 || !e2) return;
  if (!e1.relatedConcepts.includes(e2.concept)) e1.relatedConcepts.push(e2.concept);
  if (!e2.relatedConcepts.includes(e1.concept)) e2.relatedConcepts.push(e1.concept);
  saveKnowledgeFile(entries);
}

// ─── Autonomous mode engine ─────────────────────────────────────────────────

let autonomousTimer: ReturnType<typeof setInterval> | null = null;

export function startAutonomousEngine(): void {
  // Clear any existing timer to prevent leaks on module reload
  if (autonomousTimer) {
    clearInterval(autonomousTimer);
    autonomousTimer = null;
  }

  // Check periodically for sessions that need autonomous runs
  const checkIntervalSec = parseInt(process.env.BLOB_AUTO_CHECK_SEC ?? "60");
  autonomousTimer = setInterval(() => {
    (async () => {
      const sessions = listBlobSessions();
      const now = Date.now();

      for (const session of sessions) {
        if (!session.enabled || !session.autonomous || !session.autonomousIntervalMs) continue;
        // Budget guard: skip if session has run more than 10 times in the last hour
        const MAX_AUTONOMOUS_RUNS_PER_HOUR = 10;
        if (session.lastAutonomousRun) {
          const hourAgo = now - 3600000;
          // Simple heuristic: if interval is too small, enforce minimum 6 minutes
          if (session.autonomousIntervalMs < 360000 && new Date(session.lastAutonomousRun).getTime() > hourAgo) {
            const timeSinceLast = now - new Date(session.lastAutonomousRun).getTime();
            if (timeSinceLast < 360000) continue; // Enforce 6min minimum between runs
          }
        }

        const lastRun = session.lastAutonomousRun ? new Date(session.lastAutonomousRun).getTime() : 0;
        if (now - lastRun < session.autonomousIntervalMs) continue;

        // Time to run this BLOB autonomously
        logger.info("occ-blob", `Autonomous run for "${session.name}" (${session.id})`);

        try {
          // Load the graph to get existing branches + knowledge
          const graphData = loadBlobGraph(session.id) as { nodes?: Array<{ id: string; type: string; label: string; data: { kind: string; topic?: string } }> } | null;
          const existingBranches = graphData?.nodes
            ?.filter((n) => n.type === "branch")
            .map((n) => ({ id: n.id, topic: n.label, stepIds: [] })) ?? [];

          const knowledge = loadKnowledge();
          const knownConcepts = knowledge.map((k) => k.concept);

          // Build a targeted self-directed prompt based on knowledge gaps
          let autoPrompt: string;
          if (knowledge.length === 0) {
            autoPrompt = `Continue growing this BLOB. Review existing branches and knowledge, then expand or deepen areas that would benefit from more research or new connections. Focus on topics that haven't been explored recently.`;
          } else {
            // Find concepts referenced in relatedConcepts but missing their own entry
            const knownSet = new Set(knowledge.map((k) => k.concept.toLowerCase()));
            const uncoveredSet = new Set<string>();
            for (const k of knowledge) {
              for (const rel of k.relatedConcepts) {
                if (!knownSet.has(rel.toLowerCase())) {
                  uncoveredSet.add(rel);
                }
              }
            }
            const uncovered = [...uncoveredSet].slice(0, 5);

            // Find understudied concepts (low accessCount)
            const understudied = [...knowledge]
              .sort((a, b) => a.accessCount - b.accessCount)
              .slice(0, 5)
              .map((k) => k.concept);

            const parts: string[] = [];
            if (uncovered.length > 0) {
              parts.push(`Explore these uncovered areas that are referenced but not yet studied: ${uncovered.join(", ")}.`);
            }
            if (understudied.length > 0) {
              parts.push(`Deepen knowledge in these understudied concepts: ${understudied.join(", ")}.`);
            }
            autoPrompt = parts.length > 0
              ? parts.join(" ")
              : `Continue growing this BLOB. Review existing branches and knowledge, then expand or deepen areas that would benefit from more research or new connections.`;
          }

          const prompt = buildPlanningPrompt({
            sessionId: session.id,
            userMessage: autoPrompt,
            existingBranches,
            knownConcepts,
            recentMessages: [],
          });

          // Run the planner
          const { runClaude } = await import("./claude-runner.js");
          let planText = "";
          await runClaude(prompt, {
            id: "blob-auto-planner",
            type: "agent",
            model: process.env.BLOB_PLANNING_MODEL ?? "claude-haiku-4-5",
            prompt: "",
            tools: [],
            output_var: "_auto_plan",
            pre_tools: [],
          }, (chunk) => { planText += chunk; });

          // Parse and save plan result for frontend to pick up
          const jsonMatch = planText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const plan = JSON.parse(jsonMatch[0]);
            // Save the plan as a pending autonomous action
            ensureBlobDir();
            const planTarget = path.join(BLOB_DIR, `${session.id}_auto_plan.json`);
            const planTmp = `${planTarget}.tmp.${Date.now()}`;
            fs.writeFileSync(planTmp, JSON.stringify({ plan, timestamp: new Date().toISOString() }));
            fs.renameSync(planTmp, planTarget);
          }

          // Update last run time
          updateBlobSession(session.id, { lastAutonomousRun: new Date().toISOString() });
        } catch (err) {
          logger.error("occ-blob", `Autonomous run failed for ${session.id}: ${err}`);
        }
      }
    })().catch((err) => {
      logger.error("occ-blob", `Autonomous engine tick failed: ${err}`);
    });
  }, checkIntervalSec * 1000);

  logger.info("occ-blob", `Autonomous engine started (checking every ${checkIntervalSec}s)`);
}

export function stopAutonomousEngine(): void {
  if (autonomousTimer) {
    clearInterval(autonomousTimer);
    autonomousTimer = null;
  }
}

/** Get pending autonomous plan for a session (if any) */
export function getAutonomousPlan(sessionId: string): unknown | null {
  const planPath = path.join(BLOB_DIR, `${sessionId}_auto_plan.json`);
  if (!fs.existsSync(planPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    // Delete after reading (consumed)
    fs.unlinkSync(planPath);
    return data;
  } catch { return null; }
}

// ─── Knowledge extraction prompt ────────────────────────────────────────────

export function buildExtractionPrompt(stepOutput: string, existingConcepts: string[]): string {
  return `Extract key concepts and facts from this text. Return ONLY a JSON array of objects.

Text:
"""
${stepOutput.slice(0, 3000)}
"""

Known concepts: ${existingConcepts.join(", ") || "(none)"}

Return JSON array:
[
  { "concept": "short concept name", "facts": ["fact 1", "fact 2"], "relatedTo": ["existing concept if relevant"] }
]

Rules:
- Extract 1-5 most important concepts
- Keep concept names SHORT (1-3 words)
- Facts should be specific and actionable
- Link to existing concepts when relevant
- Return ONLY the JSON array, no markdown:`;
}

// ─── Planning prompt ────────────────────────────────────────────────────────

export function buildPlanningPrompt(req: BlobPlanRequest, mcpServers?: string[]): string {
  const branchList = req.existingBranches.length > 0
    ? req.existingBranches.map((b) => `  - [${b.id}] "${b.topic}" (${b.stepIds.length} steps)`).join("\n")
    : "  (none)";

  // Load full knowledge graph for smart context injection
  const allKnowledge = loadKnowledge();
  const relevantKnowledge = findRelevantKnowledge(req.userMessage, allKnowledge);

  const knowledgeSection = relevantKnowledge.length > 0
    ? relevantKnowledge.map((k) => `  - "${k.concept}" [used ${k.accessCount}x]: ${k.facts.slice(0, 3).join("; ")}${k.relatedConcepts.length > 0 ? ` (related: ${k.relatedConcepts.join(", ")})` : ""}`).join("\n")
    : "  (none)";

  const allConceptList = allKnowledge.length > 0
    ? allKnowledge.map((k) => k.concept).join(", ")
    : "(none)";

  return `You are the BLOB Orchestrator — an intelligent system that grows organic workflow graphs from conversations.

## Context
User message: "${req.userMessage}"

## Existing Branches
${branchList}

## Knowledge Graph (relevant to this request)
${knowledgeSection}

## All Known Concepts
${allConceptList}

## Your Task
Analyze the user's message and decide how to grow the BLOB graph. You MUST respond with a JSON object (no markdown) matching this structure:

{
  "branches": [
    {
      "topic": "short topic name",
      "steps": [
        { "type": "agent|transform|web_search|...", "label": "Step Name", "prompt": "what this step does", "tools": ["Bash", "Read"] }
      ]
    }
  ],
  "reuseBranches": [
    { "branchNodeId": "existing_branch_id", "forkAtStepId": "step_to_fork_from", "newSteps": [{ "type": "agent", "label": "New Step", "prompt": "..." }] }
  ],
  "memoryUpdates": [
    { "concept": "key concept", "facts": ["fact 1", "fact 2"] }
  ],
  "directResponse": "optional direct text response if no chain is needed"
}

## Rules
1. SIMPLE question (greeting, opinion, quick fact) → "directResponse" only, no branches
2. REAL WORK (research, code, analysis) → create branches with steps
3. SAME topic as existing branch → reuse via "reuseBranches" (no branchNodeId duplication)
4. SIMILAR but different angle → fork it (reuseBranches with forkAtStepId + newSteps)
5. ALWAYS extract key concepts into "memoryUpdates" — these persist across sessions
6. USE knowledge graph context above to avoid redundant work and make connections
7. If knowledge already covers the answer, reference it in directResponse
8. Step types: agent, transform, web_search, router, evaluator, gate, loop, merge, browser, webhook
9. Branch topics: SHORT (2-4 words)
10. Step prompts: ACTIONABLE and specific, reference known facts when relevant
${mcpServers && mcpServers.length > 0 ? `11. Available MCP tool servers: ${mcpServers.join(", ")}. Use tools: ["mcp_call"] and reference the server name in the step prompt when the user asks for data these servers can provide.` : ""}
Respond with ONLY the JSON object:`;
}

/** Find knowledge entries relevant to a query using keyword matching + BFS graph traversal */
export function findRelevantKnowledge(query: string, allKnowledge: KnowledgeEntry[]): KnowledgeEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return allKnowledge.slice(0, 5);

  // Build a lookup map: concept name (lowercased) → KnowledgeEntry
  const conceptMap = new Map<string, KnowledgeEntry>();
  for (const k of allKnowledge) {
    conceptMap.set(k.concept.toLowerCase(), k);
  }

  // Phase 1: Keyword scoring
  const scoreMap = new Map<string, number>();
  for (const k of allKnowledge) {
    const text = `${k.concept} ${k.facts.join(" ")} ${k.relatedConcepts.join(" ")}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (k.concept.toLowerCase().includes(word)) score += 5;
      else if (text.includes(word)) score += 2;
    }
    // Boost frequently accessed concepts
    score += Math.min(k.accessCount * 0.5, 5);
    if (score > 0) scoreMap.set(k.id, score);
  }

  // Phase 2: BFS through relatedConcepts (depth=2) to find connected concepts
  const directMatches = allKnowledge.filter((k) => (scoreMap.get(k.id) ?? 0) > 0);
  const visited = new Set<string>(directMatches.map((k) => k.id));
  let frontier = directMatches;

  for (let depth = 0; depth < 2; depth++) {
    const nextFrontier: KnowledgeEntry[] = [];
    for (const entry of frontier) {
      for (const relName of entry.relatedConcepts) {
        const related = conceptMap.get(relName.toLowerCase());
        if (related && !visited.has(related.id)) {
          visited.add(related.id);
          // Graph-traversal bonus: +3 for being connected to a matching concept
          const existing = scoreMap.get(related.id) ?? 0;
          scoreMap.set(related.id, existing + 3 + Math.min(related.accessCount * 0.5, 5));
          nextFrontier.push(related);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Collect and sort all scored entries
  const results: Array<{ entry: KnowledgeEntry; score: number }> = [];
  for (const [id, score] of scoreMap) {
    const entry = allKnowledge.find((k) => k.id === id);
    if (entry) results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s) => s.entry);
}
