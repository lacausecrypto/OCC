/**
 * workflowChat.ts — Zustand store for the Workflow Chat builder.
 * Two-stage: chat (fast response) → plan (generates canvas nodes).
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvas";
import { useServerStore } from "./server";
import { useAppStore } from "./app";
import type { StepAdvancedConfig } from "../types/canvas";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WFMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  createdNodes?: string[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface WFPlanStep {
  type: string;
  label: string;
  prompt: string;
  model?: string;
  tools?: string[];
  outputVar?: string;
  preTools?: Record<string, unknown>[];
  advanced?: Partial<StepAdvancedConfig>;
  depends_on?: string[];
}

export interface WFPlan {
  steps: WFPlanStep[];
  chainName?: string;
  chainDescription?: string;
  directResponse?: string;
}

export interface WFSession {
  id: string;
  contextKey: string; // "chain:deep-researcher", "pipeline:foo", etc.
  name: string;
  createdAt: string;
}

interface WorkflowChatState {
  // Context = which chain/pipeline is active
  contextKey: string;
  // Session = which chat session within this context
  activeSessionId: string | null;
  messages: WFMessage[];
  input: string;
  streaming: boolean;
  thinkingStartedAt: number | null;

  // Config
  chatModel: string;
  plannerModel: string;
  chatSystemPrompt: string;
  plannerSystemPrompt: string;
  configOpen: boolean;

  // Actions
  setInput: (v: string) => void;
  setConfigOpen: (v: boolean) => void;
  setChatModel: (v: string) => void;
  setPlannerModel: (v: string) => void;
  setChatSystemPrompt: (v: string) => void;
  setPlannerSystemPrompt: (v: string) => void;
  sendMessage: () => Promise<void>;
  clearMessages: () => void;
  /** Switch chain/pipeline context — auto-selects last session for this context */
  setContextKey: (key: string) => void;
  /** Switch to a specific session within current context */
  switchSession: (sessionId: string) => void;
  /** Create a new session for current context */
  createSession: (name?: string) => void;
  /** Rename a session */
  renameSession: (sessionId: string, name: string) => void;
  /** Delete a session */
  deleteSession: (sessionId: string) => void;
  /** List sessions for current context */
  getSessionsForContext: () => WFSession[];
}

// ─── Default prompts ────────────────────────────────────────────────────────

const DEFAULT_CHAT_PROMPT = `You are an Agentic Workflow AI — you BUILD, RUN, DEBUG, and MANAGE chains.

You have the following ACTIONS available. Include the exact tag at the end of your response to trigger them:

[READY_TO_BUILD] — Build/modify steps on the canvas from your plan
[ACTION:RUN] — Execute the current chain on the canvas
[ACTION:STOP] — Stop the running execution
[ACTION:ANALYZE] — Analyze the current chain structure (dependencies, bottlenecks, issues)
[ACTION:DEBUG] — Debug the last execution (inspect errors, step outputs, timing)
[ACTION:DRY_RUN] — Show execution plan + cost estimate without running

RULES:
1. Be ACTION-ORIENTED. Build, run, debug — don't just talk.
2. Ask AT MOST 1 clarifying question. Otherwise, make smart assumptions and ACT.
3. When the user says "run", "lance", "execute" → respond briefly then use [ACTION:RUN]
4. When the user says "stop", "cancel", "arrête" → use [ACTION:STOP]
5. When the user says "debug", "what went wrong", "pourquoi ça a fail" → use [ACTION:DEBUG]
6. When the user says "analyze", "check", "vérifie" → use [ACTION:ANALYZE]
7. When the user says "dry-run", "estimate", "combien ça coûte" → use [ACTION:DRY_RUN]
8. Keep responses SHORT. 3-5 bullet points max.
9. Respond in the same language as the user.
10. When building, describe the plan briefly then use [READY_TO_BUILD].
11. You CAN COMBINE multiple actions in one response! e.g. [ACTION:STOP] + [ACTION:DEBUG] to stop a broken execution then debug it.
12. If an execution is running and has errors visible in the debug info, STOP it first then propose fixes with [ACTION:MODIFY].
13. If "debug" is asked and execution is running → show live status. If errors are visible → suggest stopping + fixing.

MODIFY EXISTING STEPS:
When the user wants to modify existing steps (change prompt, model, tools, pre-tools, etc.),
respond with your explanation then use [ACTION:MODIFY] followed by a JSON block:
\`\`\`json
{"modifications": [
  {"stepLabel": "Step Name", "patch": {"prompt": "new prompt", "model": "claude-haiku-4-5"}},
  {"stepLabel": "Another Step", "patch": {"tools": ["WebSearch", "Read"], "preTools": [{"type": "web_search", "inject_as": "results", "query": "..."}]}},
  {"stepLabel": "Old Step", "delete": true}
]}
\`\`\`
Valid patch fields: prompt, model, type, tools (array), outputVar, preTools (array of pre-tool objects).
Set "delete": true to remove a step entirely.
Use the EXACT step label as shown in the canvas context.

CONTEXT: You can see the current canvas state (steps, connections, models) and execution history. Use this context to give precise answers about the chain.

NEVER:
- Ask multiple questions before acting
- Give long explanations without an action
- Refuse to act because of missing details — use smart defaults`;


const DEFAULT_PLANNER_PROMPT = `You are a chain planner. Given a conversation and the current canvas state, produce a JSON plan.

IMPORTANT — Check the canvas context:
- If the canvas ALREADY HAS steps → use [ACTION:MODIFY] to FIX/UPDATE existing steps. Do NOT recreate the chain.
- If the canvas is EMPTY → create new steps.
- If the user asks to debug/fix → only modify the broken steps, keep working ones intact.

Rules:
- Output ONLY valid JSON, no markdown fences, no commentary
- Each step needs: type, label, prompt, outputVar
- Valid types: agent, router, evaluator, gate, transform, loop, merge, webhook, subchain, debate, browser
- Use depends_on to wire steps together (array of step labels used as IDs)
- Tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- Keep prompts ACTIONABLE and SPECIFIC — include {variable} references
- For pre_tools, use: web_search, http_fetch, bash, read_file, write_file, state_save, state_load, notify, email, db_query

When CREATING new steps (empty canvas), output:
{
  "chainName": "kebab-case-name",
  "chainDescription": "one line",
  "steps": [
    {
      "type": "agent",
      "label": "Step Name",
      "prompt": "Do X with {input}...",
      "outputVar": "step_name_out",
      "model": "claude-sonnet-4-6",
      "tools": ["WebSearch"],
      "preTools": [{"type": "web_search", "inject_as": "results", "query": "{input.topic}"}],
      "depends_on": []
    }
  ]
}

When MODIFYING existing steps (non-empty canvas), output:
{
  "modifications": [
    { "label": "Existing Step Name", "patch": { "prompt": "new prompt...", "model": "new-model", "tools": ["Bash"] } },
    { "label": "Broken Step", "delete": true }
  ],
  "addSteps": [
    { "type": "agent", "label": "New Step", "prompt": "...", "outputVar": "new_out", "depends_on": ["Existing Step Name"] }
  ]
}`;

// ─── Multi-session persistence ──────────────────────────────────────────────
// Storage layout:
//   occ-wfc-index    → WFSession[]  (all sessions metadata)
//   occ-wfc-msg-{id} → WFMessage[]  (messages per session)
//   occ-wfc-active   → { contextKey: sessionId }  (last active session per context)

const IDX_KEY = "occ-wfc-index";
const ACTIVE_KEY = "occ-wfc-active";

function loadIndex(): WFSession[] {
  try { return JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]"); } catch { return []; }
}
function saveIndex(sessions: WFSession[]): void {
  try { localStorage.setItem(IDX_KEY, JSON.stringify(sessions)); } catch { /* */ }
}
function loadMessages(sessionId: string): WFMessage[] {
  try { return JSON.parse(localStorage.getItem(`occ-wfc-msg-${sessionId}`) ?? "[]"); } catch { return []; }
}
function saveMessages(sessionId: string, messages: WFMessage[]): void {
  try { localStorage.setItem(`occ-wfc-msg-${sessionId}`, JSON.stringify(messages.slice(-50))); } catch { /* */ }
}
function removeMessages(sessionId: string): void {
  try { localStorage.removeItem(`occ-wfc-msg-${sessionId}`); } catch { /* */ }
}
function loadActiveMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}"); } catch { return {}; }
}
function saveActiveForContext(contextKey: string, sessionId: string): void {
  try {
    const map = loadActiveMap();
    map[contextKey] = sessionId;
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch { /* */ }
}
function getActiveForContext(contextKey: string): string | null {
  return loadActiveMap()[contextKey] ?? null;
}

// Exported for UI
export function getSessionsForContext(contextKey: string): WFSession[] {
  return loadIndex().filter((s) => s.contextKey === contextKey);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _nextId = 0;
function uid() { return `wfc_${Date.now()}_${_nextId++}`; }

function getHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = useServerStore.getState().apiKey;
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

/**
 * Detect if the assistant response signals readiness to build.
 * Supports English and French patterns.
 */
/** Strip action tags from displayed text */
function stripBuildTag(text: string): string {
  return text
    .replace(/\s*\[READY_TO_BUILD\]\s*/g, "")
    .replace(/\s*\[ACTION:\w+\]\s*/g, "")
    .trim();
}

/** Build a rich text summary of current canvas + execution state */
function buildCanvasContext(): string {
  const canvasState = useCanvasStore.getState();
  const appState = useAppStore.getState();
  const nodes = [...canvasState.nodes.values()];
  const edges = [...canvasState.edges.values()];

  const parts: string[] = [];

  // Chain info
  const chainName = appState.canvasChainName || appState.pipelineName || "untitled";
  parts.push(`Chain: "${chainName}" | ${nodes.length} steps | ${edges.length} connections`);

  if (nodes.length === 0) {
    parts.push("Canvas is empty — no steps exist yet.");
    return parts.join("\n");
  }

  // Step details
  parts.push("\nSteps:");
  for (const n of nodes) {
    const deps = edges.filter((e) => e.to === n.id).map((e) => {
      const src = canvasState.nodes.get(e.from);
      return src?.label ?? e.from;
    });
    const model = n.model ? ` [${n.model}]` : "";
    const tools = n.tools?.length ? ` tools:[${n.tools.join(",")}]` : "";
    const pretools = n.preTools?.length ? ` pre-tools:${n.preTools.length}` : "";
    const prompt = n.prompt ? ` prompt:"${n.prompt.slice(0, 60)}..."` : " prompt:EMPTY";
    parts.push(`  - "${n.label}" (${n.type})${model}${tools}${pretools}${deps.length > 0 ? ` ← [${deps.join(", ")}]` : ""}${prompt}`);
  }

  // Execution history (last 3)
  try {
    const { useMonitorStore } = require("./monitor");
    const executions = [...useMonitorStore.getState().executions.values()]
      .filter((e: any) => e.chainName === chainName)
      .sort((a: any, b: any) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
      .slice(0, 3);

    if (executions.length > 0) {
      parts.push("\nRecent executions:");
      for (const ex of executions) {
        const steps = Object.entries(ex.steps ?? {});
        const errors = steps.filter(([, s]: any) => s.status === "error");
        const done = steps.filter(([, s]: any) => s.status === "done");
        const dur = ex.durationMs ? `${(ex.durationMs / 1000).toFixed(1)}s` : "?";
        parts.push(`  - ${ex.status} (${dur}) | ${done.length}/${steps.length} done${errors.length > 0 ? ` | ERRORS: ${errors.map(([id, s]: any) => `${id}: ${s.error?.slice(0, 80)}`).join("; ")}` : ""}${ex.error ? ` | ${ex.error.slice(0, 100)}` : ""}`);
      }
    }
  } catch { /* monitor not available */ }

  return parts.join("\n");
}

/** Build execution debug info for the last run */
function buildDebugContext(): string {
  try {
    const { useMonitorStore } = require("./monitor");
    const appState = useAppStore.getState();
    const chainName = appState.canvasChainName || appState.pipelineName || "";
    const executions = [...useMonitorStore.getState().executions.values()]
      .filter((e: any) => e.chainName === chainName)
      .sort((a: any, b: any) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

    const last = executions[0];
    if (!last) return "No execution history found for this chain.";

    const parts: string[] = [];
    parts.push(`Last execution: ${last.status} | ${last.durationMs ? (last.durationMs / 1000).toFixed(1) + "s" : "?"}`);
    if (last.error) parts.push(`Chain error: ${last.error}`);

    const steps = Object.entries(last.steps ?? {});
    for (const [stepId, step] of steps) {
      const s = step as any;
      const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "";
      const tokens = s.inputTokens ? `${s.inputTokens}+${s.outputTokens} tok` : "";
      const err = s.error ? ` ERROR: ${s.error}` : "";
      const output = s.output ? ` output:"${String(s.output).slice(0, 100)}..."` : "";
      parts.push(`  ${s.status} ${stepId} ${dur} ${tokens}${err}${output}`);
    }

    return parts.join("\n");
  } catch {
    return "Cannot access execution history.";
  }
}

function shouldTriggerPlan(text: string): boolean {
  // Primary: structured tag from LLM (reliable, language-agnostic)
  if (text.includes("[READY_TO_BUILD]")) return true;
  // Fallback: heuristic patterns for backward compat
  const lower = text.toLowerCase();
  const signals = [
    // English
    "i'll build", "i'll create", "i will build", "i will create",
    "let me build", "let me create", "let me generate",
    "here's the plan", "here is the plan",
    "creating the workflow", "generating the chain", "building the chain",
    "creating now", "building now", "generating now",
    "i'll design", "let me design",
    // French
    "je crée", "je construis", "je génère", "je vais créer",
    "je vais construire", "je vais générer", "je le crée",
    "voici le plan", "voici la chaîne", "c'est parti",
    "je lance la création", "je te crée", "je te construis",
    "je le construis", "je la crée", "je la construis",
    // Action keywords (more aggressive — trigger on descriptive plan language)
    "étapes orchestrées", "étapes suivantes", "steps:",
    "la chaîne va", "the chain will", "workflow:",
  ];
  return signals.some((s) => lower.includes(s));
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useWorkflowChatStore = create<WorkflowChatState>((set, get) => ({
  contextKey: "_default",
  activeSessionId: null,
  messages: [],
  input: "",
  streaming: false,
  thinkingStartedAt: null,

  chatModel: "claude-haiku-4-5",
  plannerModel: "claude-sonnet-4-6",
  chatSystemPrompt: DEFAULT_CHAT_PROMPT,
  plannerSystemPrompt: DEFAULT_PLANNER_PROMPT,
  configOpen: false,

  setInput: (v) => set({ input: v }),
  setConfigOpen: (v) => set({ configOpen: v }),
  setChatModel: (v) => set({ chatModel: v }),
  setPlannerModel: (v) => set({ plannerModel: v }),
  setChatSystemPrompt: (v) => set({ chatSystemPrompt: v }),
  setPlannerSystemPrompt: (v) => set({ plannerSystemPrompt: v }),
  clearMessages: () => {
    const { activeSessionId } = get();
    set({ messages: [] });
    if (activeSessionId) saveMessages(activeSessionId, []);
  },

  setContextKey: (key: string) => {
    const { contextKey, activeSessionId, messages } = get();
    if (key === contextKey) return;
    // Save current
    if (activeSessionId) saveMessages(activeSessionId, messages);
    // Find last active session for target context, or create one
    let targetId = getActiveForContext(key);
    const contextSessions = getSessionsForContext(key);
    if (!targetId || !contextSessions.some((s) => s.id === targetId)) {
      if (contextSessions.length > 0) {
        targetId = contextSessions[0].id;
      } else {
        // Auto-create first session
        const newId = uid();
        const label = key.startsWith("chain:") ? key.slice(6) : key.startsWith("pipeline:") ? key.slice(9) : "Chat";
        const session: WFSession = { id: newId, contextKey: key, name: `${label} #1`, createdAt: new Date().toISOString() };
        const idx = loadIndex();
        idx.push(session);
        saveIndex(idx);
        targetId = newId;
      }
    }
    const loaded = loadMessages(targetId!);
    saveActiveForContext(key, targetId!);
    set({ contextKey: key, activeSessionId: targetId, messages: loaded, input: "" });
  },

  switchSession: (sessionId: string) => {
    const { activeSessionId, messages, contextKey } = get();
    if (sessionId === activeSessionId) return;
    if (activeSessionId) saveMessages(activeSessionId, messages);
    const loaded = loadMessages(sessionId);
    saveActiveForContext(contextKey, sessionId);
    set({ activeSessionId: sessionId, messages: loaded, input: "" });
  },

  createSession: (name?: string) => {
    const { activeSessionId, messages, contextKey } = get();
    if (activeSessionId) saveMessages(activeSessionId, messages);
    const newId = uid();
    const count = getSessionsForContext(contextKey).length + 1;
    const label = name || (() => {
      const base = contextKey.startsWith("chain:") ? contextKey.slice(6) : contextKey.startsWith("pipeline:") ? contextKey.slice(9) : "Chat";
      return `${base} #${count}`;
    })();
    const session: WFSession = { id: newId, contextKey, name: label, createdAt: new Date().toISOString() };
    const idx = loadIndex();
    idx.push(session);
    saveIndex(idx);
    saveActiveForContext(contextKey, newId);
    // If no prior session existed, keep orphan messages (don't erase what the user typed)
    const newMessages = activeSessionId ? [] : messages;
    set({ activeSessionId: newId, messages: newMessages, input: "" });
    if (newMessages.length > 0) saveMessages(newId, newMessages);
  },

  renameSession: (sessionId: string, name: string) => {
    const idx = loadIndex();
    const s = idx.find((s) => s.id === sessionId);
    if (s) { s.name = name.trim() || s.name; saveIndex(idx); }
  },

  deleteSession: (sessionId: string) => {
    const { activeSessionId, contextKey } = get();
    const idx = loadIndex().filter((s) => s.id !== sessionId);
    saveIndex(idx);
    removeMessages(sessionId);
    // If deleted the active one, switch to another or create new
    if (sessionId === activeSessionId) {
      const remaining = idx.filter((s) => s.contextKey === contextKey);
      if (remaining.length > 0) {
        get().switchSession(remaining[0].id);
      } else {
        get().createSession();
      }
    }
  },

  getSessionsForContext: () => getSessionsForContext(get().contextKey),

  sendMessage: async () => {
    const { input, chatModel, plannerModel, chatSystemPrompt, plannerSystemPrompt } = get();
    const text = input.trim();
    if (!text || get().streaming) return;

    // Ensure we have an active session before sending anything
    if (!get().activeSessionId) {
      get().createSession();
    }
    const messages = get().messages;

    const userMsg: WFMessage = {
      id: uid(), role: "user", content: text,
      timestamp: new Date().toISOString(),
    };
    set({ messages: [...messages, userMsg], input: "", streaming: true, thinkingStartedAt: Date.now() });

    const headers = getHeaders();
    const context = [...get().messages].slice(-20).map((m) => ({ role: m.role, content: m.content }));
    const canvasCtx = buildCanvasContext();
    // Add debug context if user seems to want debugging
    const lowerText = text.toLowerCase();
    const wantsDebug = /debug|error|fail|bug|wrong|broke|crash|pourquoi|why.*fail|qu.est.ce qui/i.test(lowerText);
    const fullCanvasCtx = wantsDebug
      ? canvasCtx + "\n\n--- EXECUTION DEBUG ---\n" + buildDebugContext()
      : canvasCtx;

    try {
      // ── Stage 1: Chat response (SSE streaming) ────────────────
      const assistantMsg: WFMessage = {
        id: uid(), role: "assistant", content: "",
        timestamp: new Date().toISOString(),
      };
      set({ messages: [...get().messages, assistantMsg] });

      const chatRes = await fetch("/workflow-chat", {
        method: "POST", headers,
        body: JSON.stringify({
          stage: "chat",
          message: text,
          context,
          systemPrompt: chatSystemPrompt,
          model: chatModel,
          canvasContext: fullCanvasCtx,
        }),
      });

      if (!chatRes.ok || !chatRes.body) throw new Error(`Chat failed: ${chatRes.status}`);

      // Stream response tokens
      const reader = chatRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let lastFlush = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "chunk") {
              fullText += evt.text;
              // Clear thinking indicator on first chunk
              if (get().thinkingStartedAt) set({ thinkingStartedAt: null });
              // Debounce state updates (~100ms)
              if (Date.now() - lastFlush > 100) {
                set({ messages: get().messages.map((m) => m.id === assistantMsg.id ? { ...m, content: stripBuildTag(fullText) } : m) });
                lastFlush = Date.now();
              }
            } else if (evt.type === "done") {
              fullText = evt.text ?? fullText;
              inputTokens = evt.inputTokens ?? 0;
              outputTokens = evt.outputTokens ?? 0;
              if (get().thinkingStartedAt) set({ thinkingStartedAt: null });
            } else if (evt.type === "error") {
              throw new Error(evt.error);
            }
          } catch (e) {
            if (e instanceof Error && !e.message.includes("JSON")) throw e;
          }
        }
      }

      // Final update with clean text + token counts
      set({
        messages: get().messages.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: stripBuildTag(fullText), inputTokens, outputTokens }
            : m,
        ),
      });

      // ── Stage 2: Plan (generates nodes) ────────────────────────
      const userLower = text.toLowerCase();
      const userWantsBuild = /^(oui|yes|go|ok|do it|vas-y|vasy|fais[- ]le|crée|create|build|lance|génère|approve|approuve|let's go|c'est bon|permission|accepte)/i.test(userLower)
        || userLower.includes("crée") || userLower.includes("build it") || userLower.includes("go ahead");

      const assistantReady = shouldTriggerPlan(fullText);
      const hasHistory = get().messages.length >= 3;
      const shortAffirmative = text.length < 40 && userWantsBuild && hasHistory;

      if (assistantReady || shortAffirmative) {
        const fullContext = [...get().messages].slice(-20).map((m) => ({ role: m.role, content: m.content }));

        const planningMsg: WFMessage = {
          id: uid(), role: "system",
          content: "Building chain on canvas...",
          timestamp: new Date().toISOString(),
        };
        set({ messages: [...get().messages, planningMsg], thinkingStartedAt: Date.now() });

        const planRes = await fetch("/workflow-chat", {
          method: "POST", headers,
          body: JSON.stringify({
            stage: "plan",
            message: text,
            context: fullContext,
            systemPrompt: plannerSystemPrompt,
            model: plannerModel,
            canvasContext: fullCanvasCtx,
          }),
        });

        if (planRes.ok) {
          const rawText = await planRes.text();
          let plan: WFPlan;
          try {
            plan = JSON.parse(rawText) as WFPlan;
          } catch {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              plan = JSON.parse(jsonMatch[0]) as WFPlan;
            } else {
              throw new Error("Could not parse plan JSON");
            }
          }

          // Handle modification plan (existing canvas)
          const parsed = plan as any;
          if (parsed.modifications || parsed.addSteps) {
            let modCount = 0;
            let addCount = 0;
            const canvasState = useCanvasStore.getState();

            // Apply modifications to existing nodes
            if (Array.isArray(parsed.modifications)) {
              for (const mod of parsed.modifications) {
                const node = [...canvasState.nodes.values()].find(n => n.label === mod.label);
                if (!node) continue;
                if (mod.delete) {
                  canvasState.removeNode(node.id);
                  modCount++;
                } else if (mod.patch) {
                  canvasState.updateNode(node.id, {
                    ...(mod.patch.prompt != null ? { prompt: mod.patch.prompt } : {}),
                    ...(mod.patch.model != null ? { model: mod.patch.model } : {}),
                    ...(mod.patch.type != null ? { type: mod.patch.type } : {}),
                    ...(mod.patch.tools != null ? { tools: mod.patch.tools } : {}),
                  });
                  modCount++;
                }
              }
            }

            // Add new steps if any
            if (Array.isArray(parsed.addSteps) && parsed.addSteps.length > 0) {
              const addPlan: WFPlan = { steps: parsed.addSteps };
              const addedIds = applyPlanToCanvas(addPlan);
              addCount = addedIds.length;
            }

            const summary = [
              modCount > 0 ? `${modCount} step${modCount > 1 ? "s" : ""} modified` : "",
              addCount > 0 ? `${addCount} step${addCount > 1 ? "s" : ""} added` : "",
            ].filter(Boolean).join(", ");

            set({
              messages: get().messages.map((m) =>
                m.id === planningMsg.id
                  ? { ...m, content: `\u2713 ${summary || "No changes needed"}.` }
                  : m,
              ),
            });
          } else if (plan.steps?.length > 0) {
            const createdIds = applyPlanToCanvas(plan);
            set({
              messages: get().messages.map((m) =>
                m.id === assistantMsg.id ? { ...m, createdNodes: createdIds } : m,
              ),
            });
            set({
              messages: get().messages.map((m) =>
                m.id === planningMsg.id
                  ? { ...m, content: `\u2713 Created ${createdIds.length} steps on canvas${plan.chainName ? ` \u2014 "${plan.chainName}"` : ""}. You can now edit, connect, and run the chain.` }
                  : m,
              ),
            });
          } else if (plan.directResponse) {
            set({
              messages: get().messages.map((m) =>
                m.id === planningMsg.id ? { ...m, content: plan.directResponse! } : m,
              ),
            });
          }
        } else {
          set({ messages: get().messages.filter((m) => m.id !== planningMsg.id) });
        }
      }
      // ── Stage 3: Execute detected actions ──────────────────────
      await executeDetectedActions(fullText, get, set);

    } catch (err) {
      const errMsg: WFMessage = {
        id: uid(), role: "system",
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      };
      set({ messages: [...get().messages, errMsg] });
    } finally {
      set({ streaming: false, thinkingStartedAt: null });
    }
  },
}));

// Auto-switch context when canvas chain changes
useAppStore.subscribe((state) => {
  const key = state.pipelineName
    ? `pipeline:${state.pipelineName}`
    : state.canvasChainName
      ? `chain:${state.canvasChainName}`
      : "_new";
  const current = useWorkflowChatStore.getState().contextKey;
  if (key !== current) {
    useWorkflowChatStore.getState().setContextKey(key);
  }
});

// Initialize: resolve context + create default session on module load
// (subscribe only fires on *changes*, not on initial state)
(() => {
  const appState = useAppStore.getState();
  const initKey = appState.pipelineName
    ? `pipeline:${appState.pipelineName}`
    : appState.canvasChainName
      ? `chain:${appState.canvasChainName}`
      : "_new";
  useWorkflowChatStore.getState().setContextKey(initKey);

  // Load model defaults from server config
  fetch("/config")
    .then((r) => r.ok ? r.json() : null)
    .then((cfg) => {
      if (!cfg) return;
      const updates: Partial<WorkflowChatState> = {};
      if (cfg.workflowChatModel) updates.chatModel = cfg.workflowChatModel;
      if (cfg.workflowPlannerModel) updates.plannerModel = cfg.workflowPlannerModel;
      if (Object.keys(updates).length > 0) useWorkflowChatStore.setState(updates);
    })
    .catch(() => {});
})();

// Auto-save messages on every change
useWorkflowChatStore.subscribe((state) => {
  if (state.activeSessionId) {
    saveMessages(state.activeSessionId, state.messages);
  }
});

// ─── Action executor ────────────────────────────────────────────────────────

async function executeDetectedActions(
  fullText: string,
  get: () => WorkflowChatState,
  set: (partial: Partial<WorkflowChatState> | ((s: WorkflowChatState) => Partial<WorkflowChatState>)) => void,
): Promise<void> {
  const headers = getHeaders();
  const actions = [...fullText.matchAll(/\[ACTION:(\w+)\]/g)].map((m) => m[1]);
  if (actions.length === 0) return;

  // Deduplicate actions (LLM sometimes emits the same tag twice)
  const uniqueActions = [...new Set(actions)];

  // If LLM already handled DEBUG+RUN combo (e.g. "no data, I'll run first"), suppress redundant DEBUG output
  const hasRun = uniqueActions.includes("RUN");
  const hasDebug = uniqueActions.includes("DEBUG");
  const suppressDebugMsg = hasRun && hasDebug; // LLM chose to run → debug info is noise

  for (const action of uniqueActions) {
    const sysMsg: WFMessage = {
      id: uid(), role: "system", content: "", timestamp: new Date().toISOString(),
    };

    switch (action) {
      // ── RUN ──────────────────────────────────────────────────────
      case "RUN": {
        const appState = useAppStore.getState();
        const chainName = appState.canvasChainName;
        if (!chainName) {
          sysMsg.content = "No chain loaded on canvas. Save the chain first.";
          break;
        }
        // Check if chain exists on backend before executing
        try {
          const checkRes = await fetch(`/chains/${encodeURIComponent(chainName)}`, { headers, method: "HEAD" });
          if (!checkRes.ok) {
            sysMsg.content = `Chain "${chainName}" not found on server. Save it first (Ctrl+S).`;
            break;
          }
        } catch { /* proceed anyway */ }

        try {
          const res = await fetch(`/execute/${encodeURIComponent(chainName)}`, {
            method: "POST", headers, body: JSON.stringify({ input: {} }),
          });
          const data = await res.json() as { executionId?: string; error?: string };
          if (data.executionId) {
            sysMsg.content = `Chain "${chainName}" started \u2014 execution ${data.executionId.slice(0, 12)}`;
            appState.startExecution(data.executionId, chainName, "chain");
          } else {
            sysMsg.content = `Failed to start: ${data.error ?? "unknown error"}`;
          }
        } catch (err) {
          sysMsg.content = `Run failed: ${(err as Error).message}`;
        }
        break;
      }

      // ── STOP ─────────────────────────────────────────────────────
      case "STOP": {
        try {
          const { useCanvasExecStore } = await import("./canvasExec");
          const execId = useCanvasExecStore.getState().canvasExecId;
          if (!execId) {
            // Try to find running execution from backend
            const appState = useAppStore.getState();
            const chainName = appState.canvasChainName;
            if (chainName) {
              const res = await fetch(`/executions?limit=5`, { headers });
              if (res.ok) {
                const execs = (await res.json()) as Array<{ id: string; chainName: string; status: string }>;
                const running = execs.find(e => e.chainName === chainName && e.status === "running");
                if (running) {
                  await fetch(`/executions/${encodeURIComponent(running.id)}`, { method: "DELETE", headers });
                  sysMsg.content = `Execution ${running.id.slice(0, 12)} cancelled.`;
                  break;
                }
              }
            }
            sysMsg.content = "No running execution to stop.";
          } else {
            await fetch(`/executions/${encodeURIComponent(execId)}`, { method: "DELETE", headers });
            sysMsg.content = `Execution ${execId.slice(0, 12)} cancelled.`;
          }
        } catch (err) {
          sysMsg.content = `Stop failed: ${(err as Error).message}`;
        }
        break;
      }

      // ── DEBUG ────────────────────────────────────────────────────
      case "DEBUG": {
        if (suppressDebugMsg) break;

        const appState = useAppStore.getState();
        const chainName = appState.canvasChainName || "";

        try {
          // Always fetch from backend for fresh data
          const listRes = await fetch(`/executions?limit=10`, { headers });
          if (!listRes.ok) throw new Error("Cannot fetch executions");
          const execs = (await listRes.json()) as Array<{
            id: string; chainName: string; status: string; error?: string;
            durationMs?: number; steps?: Record<string, { status: string; error?: string; durationMs?: number; inputTokens?: number; outputTokens?: number }>;
          }>;
          const relevant = execs.filter(e => e.chainName === chainName);

          if (relevant.length === 0) {
            sysMsg.content = `Debug: No executions found for "${chainName}". Run the chain first.`;
            break;
          }

          const latest = relevant[0];

          // If still running, fetch full detail and show live step status
          if (latest.status === "running") {
            const detailRes = await fetch(`/executions/${encodeURIComponent(latest.id)}`, { headers });
            if (detailRes.ok) {
              const detail = await detailRes.json() as {
                id: string; status: string; steps: Record<string, { status: string; error?: string; durationMs?: number; output?: string; inputTokens?: number; outputTokens?: number }>;
              };
              const stepEntries = Object.entries(detail.steps ?? {});
              const done = stepEntries.filter(([, s]) => s.status === "done");
              const running = stepEntries.filter(([, s]) => s.status === "running");
              const pending = stepEntries.filter(([, s]) => s.status === "pending" || s.status === "queued");
              const errored = stepEntries.filter(([, s]) => s.status === "error");

              const lines: string[] = [
                `Execution ${latest.id.slice(0, 12)} is **running**:`,
                `  ${done.length} done, ${running.length} running, ${pending.length} pending${errored.length > 0 ? `, ${errored.length} errors` : ""}`,
              ];
              if (running.length > 0) lines.push(`  Running now: ${running.map(([id]) => id).join(", ")}`);
              if (done.length > 0) {
                lines.push("  Completed:");
                for (const [id, s] of done) {
                  const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "";
                  const tok = s.inputTokens ? `${s.inputTokens}+${s.outputTokens} tok` : "";
                  lines.push(`    \u2713 ${id} ${dur} ${tok}`);
                }
              }
              if (errored.length > 0) {
                lines.push("  Errors:");
                for (const [id, s] of errored) lines.push(`    \u2717 ${id}: ${s.error?.slice(0, 100)}`);
              }
              lines.push("", "Chain is still running. Ask again when it finishes for full debug.");
              sysMsg.content = `Debug:\n${lines.join("\n")}`;
              break;
            }
          }

          // Finished execution — show full debug
          const lines: string[] = [];
          for (const e of relevant.slice(0, 3)) {
            const dur = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "?";
            const stepEntries = Object.entries(e.steps ?? {});
            const errors = stepEntries.filter(([, s]) => s.status === "error");
            const done = stepEntries.filter(([, s]) => s.status === "done");
            const totalTokens = stepEntries.reduce((sum, [, s]) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0), 0);

            lines.push(`**${e.status}** (${dur}) \u2014 ${done.length}/${stepEntries.length} steps${totalTokens > 0 ? `, ${totalTokens} tokens` : ""}`);

            if (errors.length > 0) {
              for (const [id, s] of errors) {
                lines.push(`  \u2717 ${id}: ${s.error?.slice(0, 120)}`);
              }
            }
            if (e.error) lines.push(`  Chain error: ${e.error.slice(0, 120)}`);

            // Show step timing for done steps
            if (done.length > 0 && done.length <= 10) {
              for (const [id, s] of done) {
                const sdur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "";
                const stok = s.inputTokens ? `${s.inputTokens}+${s.outputTokens}` : "";
                lines.push(`  \u2713 ${id} ${sdur} ${stok}`);
              }
            }
          }
          sysMsg.content = `Debug: ${relevant.length} execution(s) for "${chainName}":\n${lines.join("\n")}`;
        } catch {
          // Fallback to local monitor
          const debugInfo = buildDebugContext();
          sysMsg.content = `Debug:\n${debugInfo}`;
        }
        break;
      }

      // ── ANALYZE ──────────────────────────────────────────────────
      case "ANALYZE": {
        const canvasState = useCanvasStore.getState();
        const nodes = [...canvasState.nodes.values()];
        const edges = [...canvasState.edges.values()];
        if (nodes.length === 0) {
          sysMsg.content = "Canvas is empty \u2014 nothing to analyze.";
          break;
        }
        const issues: string[] = [];
        const noPrompt = nodes.filter((n) => !n.prompt || n.prompt.trim() === "" || n.prompt.startsWith("TODO"));
        if (noPrompt.length > 0) issues.push(`${noPrompt.length} step(s) missing prompts: ${noPrompt.map((n) => n.label).join(", ")}`);
        const orphans = nodes.filter((n) => !edges.some((e) => e.from === n.id || e.to === n.id));
        if (orphans.length > 1) issues.push(`${orphans.length} disconnected steps: ${orphans.map((n) => n.label).join(", ")}`);
        const noOutput = nodes.filter((n) => !n.outputVar);
        if (noOutput.length > 0) issues.push(`${noOutput.length} step(s) missing output variable: ${noOutput.map((n) => n.label).join(", ")}`);
        // Duplicate labels
        const labels = nodes.map(n => n.label.toLowerCase());
        const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
        if (dupes.length > 0) issues.push(`Duplicate labels: ${[...new Set(dupes)].join(", ")}`);
        // Parallel detection
        const roots = nodes.filter((n) => !edges.some((e) => e.to === n.id));
        // Model mix
        const models = [...new Set(nodes.map(n => n.model || "default").filter(Boolean))];

        sysMsg.content = `Analysis: ${nodes.length} steps, ${edges.length} connections, ${roots.length} root(s)\nModels: ${models.join(", ")}\n${issues.length > 0 ? "Issues:\n" + issues.map((i) => `  \u2022 ${i}`).join("\n") : "No issues found."}`;
        break;
      }

      // ── DRY_RUN ──────────────────────────────────────────────────
      case "DRY_RUN": {
        const appState = useAppStore.getState();
        const chainName = appState.canvasChainName;
        if (!chainName) {
          sysMsg.content = "No chain loaded. Save first.";
          break;
        }
        try {
          const canvasState = useCanvasStore.getState();
          const nodes = [...canvasState.nodes.values()];
          const edges = [...canvasState.edges.values()];

          // Model breakdown
          const modelCounts: Record<string, number> = {};
          for (const n of nodes) {
            const m = n.model || "claude-sonnet-4-6";
            modelCounts[m] = (modelCounts[m] ?? 0) + 1;
          }
          // Cost estimation
          const costPerModel: Record<string, number> = {
            "claude-haiku-4-5": 0.003, "claude-sonnet-4-6": 0.04, "claude-opus-4-6": 0.15,
          };
          let estCost = 0;
          for (const [model, count] of Object.entries(modelCounts)) {
            const perStep = Object.entries(costPerModel).find(([k]) => model.includes(k.split("-")[1]))?.[1] ?? 0.04;
            estCost += perStep * count;
          }
          // Parallel waves (rough estimate)
          const roots = nodes.filter((n) => !edges.some((e) => e.to === n.id));
          // Fetch stats from backend
          let statsLine = "";
          try {
            const res = await fetch(`/chains/${encodeURIComponent(chainName)}/stats`, { headers });
            if (res.ok) {
              const stats = await res.json() as { totalRuns?: number; avgDurationMs?: number; successRate?: number };
              if (stats.totalRuns) {
                statsLine = `\nHistory: ${stats.totalRuns} runs, ${stats.successRate?.toFixed(0) ?? "?"}% success, avg ${stats.avgDurationMs ? (stats.avgDurationMs / 1000).toFixed(1) + "s" : "?"}`;
              }
            }
          } catch { /* no stats available */ }

          const modelBreakdown = Object.entries(modelCounts).map(([m, c]) => `${c}x ${m}`).join(", ");
          sysMsg.content = `Dry-run: "${chainName}"\n\u2022 ${nodes.length} steps, ${roots.length} parallel root(s)\n\u2022 Models: ${modelBreakdown}\n\u2022 Estimated cost: ~$${estCost.toFixed(3)}${statsLine}`;
        } catch {
          sysMsg.content = "Cannot compute dry-run.";
        }
        break;
      }

      // ── MODIFY ───────────────────────────────────────────────────
      case "MODIFY": {
        // Parse JSON: try ```json blocks first, then raw JSON with "modifications"
        const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/)
          ?? fullText.match(/```\s*([\s\S]*?)```/)
          ?? fullText.match(/(\{[\s\S]*"modifications"[\s\S]*\})/);
        if (!jsonMatch) {
          sysMsg.content = "Could not parse modification plan. Expected JSON with \"modifications\" array.";
          break;
        }
        try {
          const raw = jsonMatch[1].trim();
          const plan = JSON.parse(raw) as {
            modifications: Array<{
              stepLabel: string;
              patch?: { prompt?: string; model?: string; type?: string; tools?: string[]; outputVar?: string; preTools?: Record<string, unknown>[] };
              delete?: boolean;
            }>;
          };

          if (!Array.isArray(plan.modifications) || plan.modifications.length === 0) {
            sysMsg.content = "Modification plan is empty.";
            break;
          }

          const canvas = useCanvasStore.getState();
          canvas.pushUndo();
          const nodes = [...canvas.nodes.values()];
          let modified = 0;
          let deleted = 0;
          const notFound: string[] = [];

          for (const mod of plan.modifications) {
            const node = nodes.find((n) => n.label.toLowerCase() === mod.stepLabel.toLowerCase());
            if (!node) {
              notFound.push(mod.stepLabel);
              continue;
            }

            if (mod.delete) {
              canvas.removeNode(node.id);
              deleted++;
              continue;
            }

            if (mod.patch) {
              const patch: Record<string, unknown> = {};
              if (mod.patch.prompt !== undefined) patch.prompt = mod.patch.prompt;
              if (mod.patch.model !== undefined) patch.model = mod.patch.model;
              if (mod.patch.type !== undefined) patch.type = mod.patch.type;
              if (mod.patch.tools !== undefined) patch.tools = mod.patch.tools;
              if (mod.patch.outputVar !== undefined) patch.outputVar = mod.patch.outputVar;
              if (mod.patch.preTools !== undefined) patch.preTools = mod.patch.preTools;
              if (Object.keys(patch).length > 0) {
                canvas.updateNode(node.id, patch);
                modified++;
              }
            }
          }

          const parts = [];
          if (modified > 0) parts.push(`${modified} step(s) modified`);
          if (deleted > 0) parts.push(`${deleted} step(s) deleted`);
          if (notFound.length > 0) parts.push(`${notFound.length} not found: ${notFound.join(", ")}`);
          sysMsg.content = parts.join(", ") || "No changes applied.";
        } catch (err) {
          sysMsg.content = `Modification failed: ${(err as Error).message}`;
        }
        break;
      }

      default:
        sysMsg.content = `Unknown action: ${action}`;
    }

    if (sysMsg.content) {
      set({ messages: [...get().messages, sysMsg] });
    }
  }
}

// ─── Apply plan to canvas ───────────────────────────────────────────────────

function applyPlanToCanvas(plan: WFPlan): string[] {
  const canvas = useCanvasStore.getState();
  canvas.pushUndo();

  const createdIds: string[] = [];
  const labelToId = new Map<string, string>();

  // Find max Y to place new nodes below existing ones
  let maxY = 0;
  for (const node of canvas.nodes.values()) {
    if (node.y + node.h > maxY) maxY = node.y + node.h;
  }
  const startY = maxY + 80;

  const STEP_W = 240;
  const STEP_H = 80;
  const GAP_X = 280;
  const GAP_Y = 140;
  const COLS = 4;

  plan.steps.forEach((step, i) => {
    const id = `wf_${Date.now()}_${i}`;
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    canvas.addNode({
      id,
      x: 80 + col * GAP_X,
      y: startY + row * GAP_Y,
      w: STEP_W,
      h: STEP_H,
      type: (step.type as "agent") ?? "agent",
      label: step.label,
      model: step.model ?? "claude-sonnet-4-6",
      preTools: (step.preTools ?? []) as never[],
      tools: step.tools ?? [],
      outputVar: step.outputVar ?? step.label.toLowerCase().replace(/\s+/g, "_") + "_out",
      stepId: id,
      prompt: step.prompt,
      advanced: step.advanced ?? {},
    });

    labelToId.set(step.label, id);
    createdIds.push(id);
  });

  // Wire edges from depends_on
  let edgeCounter = 0;
  plan.steps.forEach((step) => {
    const toId = labelToId.get(step.label);
    if (!toId || !step.depends_on) return;
    for (const depLabel of step.depends_on) {
      const fromId = labelToId.get(depLabel);
      if (fromId) {
        canvas.addEdge({
          id: `wfe_${Date.now()}_${edgeCounter++}`,
          from: fromId,
          to: toId,
        });
      }
    }
  });

  // If no explicit depends_on anywhere, wire sequentially
  const hasAnyDeps = plan.steps.some((s) => s.depends_on && s.depends_on.length > 0);
  if (!hasAnyDeps && createdIds.length > 1) {
    for (let i = 1; i < createdIds.length; i++) {
      canvas.addEdge({
        id: `wfe_${Date.now()}_${edgeCounter++}`,
        from: createdIds[i - 1],
        to: createdIds[i],
      });
    }
  }

  return createdIds;
}
