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

const DEFAULT_CHAT_PROMPT = `You are a Workflow Architect AI that BUILDS chains, not just talks about them.

RULES:
1. Be ACTION-ORIENTED. When the user describes what they want, immediately design and build it.
2. Ask AT MOST 1 clarifying question if truly ambiguous. Otherwise, make smart assumptions and BUILD.
3. When the user says "go", "do it", "create it", "yes", or any affirmative → immediately describe the plan and say "I'll build this now"
4. ALWAYS end your response with "I'll build this now" or "Let me create this" when you have enough context to build.
5. Keep responses SHORT. 3-5 bullet points max for the plan, then build.
6. If the user gives vague instructions like "figure it out yourself" or "you decide", make reasonable assumptions and BUILD immediately.
7. Respond in the same language as the user (French → French, English → English, etc.)

NEVER:
- Ask more than 1 question before building
- Give long explanations without building
- Say "approuve" or "confirme" — just build when you have enough info
- Refuse to build because of missing details — use smart defaults

When you have gathered enough information to build the workflow, end your response with the exact tag [READY_TO_BUILD].
Do NOT include [READY_TO_BUILD] if you still need clarification from the user.
This tag signals the system to proceed to the build phase automatically.`;

const DEFAULT_PLANNER_PROMPT = `You are a chain planner. Given a conversation, produce a JSON plan that creates canvas nodes.

Rules:
- Output ONLY valid JSON, no markdown fences, no commentary
- Each step needs: type, label, prompt, outputVar
- Valid types: agent, router, evaluator, gate, transform, loop, merge, webhook, subchain, debate, browser
- Use depends_on to wire steps together (array of step labels used as IDs)
- Tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- Keep prompts ACTIONABLE and SPECIFIC — include {variable} references
- ALWAYS produce steps — never return empty. If unsure, create a reasonable default chain.
- For pre_tools, use: web_search, http_fetch, bash, read_file, write_file, state_save, state_load, notify, email, db_query

Output format:
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
/** Strip the [READY_TO_BUILD] tag from displayed text */
function stripBuildTag(text: string): string {
  return text.replace(/\s*\[READY_TO_BUILD\]\s*/g, "").trim();
}

/** Build a text summary of the current canvas state for the planner */
function buildCanvasContext(): string {
  const canvasState = useCanvasStore.getState();
  const appState = useAppStore.getState();
  const nodes = [...canvasState.nodes.values()];
  if (nodes.length === 0) return "Empty canvas — no steps exist yet.";
  const edges = [...canvasState.edges.values()];
  const lines = nodes.map((n) => {
    const deps = edges.filter((e) => e.to === n.id).map((e) => {
      const src = canvasState.nodes.get(e.from);
      return src?.label ?? e.from;
    });
    return `- "${n.label}" (${n.type})${deps.length > 0 ? ` [depends on: ${deps.join(", ")}]` : ""}`;
  });
  return `Chain: "${appState.canvasChainName || "untitled"}"\nExisting steps (${nodes.length}):\n${lines.join("\n")}\nConnections: ${edges.length}`;
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
    set({ activeSessionId: newId, messages: [], input: "" });
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
    const { input, messages, chatModel, plannerModel, chatSystemPrompt, plannerSystemPrompt } = get();
    const text = input.trim();
    if (!text || get().streaming) return;

    const userMsg: WFMessage = {
      id: uid(), role: "user", content: text,
      timestamp: new Date().toISOString(),
    };
    set({ messages: [...messages, userMsg], input: "", streaming: true, thinkingStartedAt: Date.now() });

    const headers = getHeaders();
    const context = [...get().messages].slice(-20).map((m) => ({ role: m.role, content: m.content }));
    const canvasCtx = buildCanvasContext();

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
          canvasContext: canvasCtx,
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
      let chunkBuf = "";
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
              chunkBuf += evt.text;
              // Clear thinking indicator on first chunk
              if (get().thinkingStartedAt) set({ thinkingStartedAt: null });
              // Debounce state updates (~100ms)
              if (Date.now() - lastFlush > 100) {
                set({ messages: get().messages.map((m) => m.id === assistantMsg.id ? { ...m, content: stripBuildTag(fullText) } : m) });
                chunkBuf = "";
                lastFlush = Date.now();
              }
            } else if (evt.type === "done") {
              fullText = evt.text ?? fullText;
              inputTokens = evt.inputTokens ?? 0;
              outputTokens = evt.outputTokens ?? 0;
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
            canvasContext: canvasCtx,
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

          if (plan.steps?.length > 0) {
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

// Auto-save messages on every change
useWorkflowChatStore.subscribe((state) => {
  if (state.activeSessionId) {
    saveMessages(state.activeSessionId, state.messages);
  }
});

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
