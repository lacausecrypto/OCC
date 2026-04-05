/**
 * workflowChat.ts — Zustand store for the Workflow Chat builder.
 * Two-stage: chat (fast response) → plan (generates canvas nodes).
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvas";
import { useServerStore } from "./server";
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

interface WorkflowChatState {
  // Messages
  messages: WFMessage[];
  input: string;
  streaming: boolean;
  thinkingStartedAt: number | null;

  // Config — editable prompts & models
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

When you're ready to build, your response MUST contain one of: "I'll build", "Let me create", "Je crée", "Je construis", "Creating now", "Building now"`;

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
function shouldTriggerPlan(text: string): boolean {
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
  clearMessages: () => set({ messages: [] }),

  sendMessage: async () => {
    const { input, messages, chatModel, plannerModel, chatSystemPrompt, plannerSystemPrompt } = get();
    const text = input.trim();
    if (!text || get().streaming) return;

    // Add user message
    const userMsg: WFMessage = {
      id: uid(), role: "user", content: text,
      timestamp: new Date().toISOString(),
    };
    set({ messages: [...messages, userMsg], input: "", streaming: true, thinkingStartedAt: Date.now() });

    const headers = getHeaders();

    // Build context (last 20 messages)
    const context = [...get().messages].slice(-20).map((m) => ({
      role: m.role, content: m.content,
    }));

    try {
      // ── Stage 1: Chat response (fast) ──────────────────────────
      const chatRes = await fetch("/workflow-chat", {
        method: "POST", headers,
        body: JSON.stringify({
          stage: "chat",
          message: text,
          context,
          systemPrompt: chatSystemPrompt,
          model: chatModel,
        }),
      });

      if (!chatRes.ok) throw new Error(`Chat failed: ${chatRes.status}`);
      const chatData = await chatRes.json() as {
        text: string; inputTokens?: number; outputTokens?: number;
      };

      const assistantMsg: WFMessage = {
        id: uid(), role: "assistant", content: chatData.text,
        timestamp: new Date().toISOString(),
        inputTokens: chatData.inputTokens,
        outputTokens: chatData.outputTokens,
      };
      set({ messages: [...get().messages, assistantMsg] });

      // ── Stage 2: Plan (generates nodes) ────────────────────────
      // Trigger plan if:
      // 1. Assistant signals readiness, OR
      // 2. User explicitly asks to build (affirmative after plan discussion)
      const userLower = text.toLowerCase();
      const userWantsBuild = /^(oui|yes|go|ok|do it|vas-y|vasy|fais[- ]le|crée|create|build|lance|génère|approve|approuve|let's go|c'est bon|permission|accepte)/i.test(userLower)
        || userLower.includes("crée") || userLower.includes("build it") || userLower.includes("go ahead");

      const assistantReady = shouldTriggerPlan(chatData.text);

      // Also trigger if this is message #2+ and user gives a short affirmative
      const hasHistory = get().messages.length >= 3;
      const shortAffirmative = text.length < 40 && userWantsBuild && hasHistory;

      if (assistantReady || shortAffirmative) {
        const fullContext = [...get().messages].slice(-20).map((m) => ({
          role: m.role, content: m.content,
        }));

        // Add system message to indicate planning
        const planningMsg: WFMessage = {
          id: uid(), role: "system",
          content: "Building chain on canvas...",
          timestamp: new Date().toISOString(),
        };
        set({ messages: [...get().messages, planningMsg] });

        const planRes = await fetch("/workflow-chat", {
          method: "POST", headers,
          body: JSON.stringify({
            stage: "plan",
            message: text,
            context: fullContext,
            systemPrompt: plannerSystemPrompt,
            model: plannerModel,
          }),
        });

        if (planRes.ok) {
          const rawText = await planRes.text();
          let plan: WFPlan;
          try {
            plan = JSON.parse(rawText) as WFPlan;
          } catch {
            // Try to extract JSON from the response (sometimes wrapped in markdown)
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              plan = JSON.parse(jsonMatch[0]) as WFPlan;
            } else {
              throw new Error("Could not parse plan JSON");
            }
          }

          if (plan.steps?.length > 0) {
            const createdIds = applyPlanToCanvas(plan);
            // Update assistant message with created node IDs
            set({
              messages: get().messages.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, createdNodes: createdIds }
                  : m,
              ),
            });

            // Replace the "Building..." message with success
            set({
              messages: get().messages.map((m) =>
                m.id === planningMsg.id
                  ? { ...m, content: `✓ Created ${createdIds.length} steps on canvas${plan.chainName ? ` — "${plan.chainName}"` : ""}. You can now edit, connect, and run the chain.` }
                  : m,
              ),
            });
          } else if (plan.directResponse) {
            set({
              messages: get().messages.map((m) =>
                m.id === planningMsg.id
                  ? { ...m, content: plan.directResponse! }
                  : m,
              ),
            });
          }
        } else {
          // Plan request failed — remove the "Building..." message
          set({
            messages: get().messages.filter((m) => m.id !== planningMsg.id),
          });
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
