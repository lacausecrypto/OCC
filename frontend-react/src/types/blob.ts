// ─── BLOB types — organic conversational graph ──────────────────────────────

/** A BLOB session — one living organism of conversation + chains */
export interface BlobSession {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  /** Autonomous mode: blob grows on its own at scheduled intervals */
  autonomous: boolean;
  autonomousIntervalMs?: number; // e.g. 3600000 = 1 hour
  lastAutonomousRun?: string;
  /** Custom prompts per session */
  chatPrompt?: string;
  plannerPrompt?: string;
  /** Stats */
  nodeCount: number;
  edgeCount: number;
  messageCount: number;
  totalTokens: number;
}

/** Node types in the blob graph */
export type BlobNodeType =
  | "core"        // Central LLM chat node
  | "branch"      // Auto-generated topic branch
  | "step"        // Executable chain step (agent, transform, etc.)
  | "memory"      // Knowledge graph memory node
  | "input"       // User input node
  | "output"      // Result output node
  | "fork";       // Fork point where a branch diverges

/** A node in the blob graph */
export interface BlobNode {
  id: string;
  sessionId: string;
  type: BlobNodeType;
  label: string;
  /** Position on canvas (polar from center for organic layout) */
  x: number;
  y: number;
  /** Radial distance from center (for organic layout algorithm) */
  depth: number;
  /** Angular position in radians */
  angle: number;
  /** Node-specific data */
  data: BlobNodeData;
  /** Visual state */
  status: "idle" | "thinking" | "running" | "done" | "error";
  /** When this node was created */
  createdAt: string;
  /** Growth animation progress 0-1 */
  growthProgress: number;
}

/** Node data varies by type */
export type BlobNodeData =
  | { kind: "core"; messages: BlobMessage[] }
  | { kind: "branch"; topic: string; summary: string; chainSteps: string[] }
  | { kind: "step"; stepType: string; prompt: string; model?: string; output?: string; durationMs?: number; inputTokens?: number; outputTokens?: number }
  | { kind: "memory"; concept: string; facts: string[]; connections: string[] }
  | { kind: "input"; text: string; fromMessageId: string }
  | { kind: "output"; text: string; stepId: string }
  | { kind: "fork"; parentBranchId: string; reason: string };

/** Chat message in the core node */
export interface BlobMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  /** Which branch/nodes were spawned from this message */
  spawnedNodeIds: string[];
  /** Tokens used */
  inputTokens?: number;
  outputTokens?: number;
}

/** Edge between blob nodes */
export interface BlobEdge {
  id: string;
  sessionId: string;
  from: string;
  to: string;
  type: "root" | "branch" | "fork" | "data" | "memory";
  /** For animated growth — 0 to 1 */
  growthProgress: number;
  /** Edge label (optional) */
  label?: string;
}

/** Knowledge graph entry — persists across sessions */
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

/** BLOB execution plan — what the LLM decides to build */
export interface BlobPlan {
  /** New branches to create */
  branches: Array<{
    topic: string;
    steps: Array<{
      type: string;
      label: string;
      prompt: string;
      model?: string;
      tools?: string[];
      dependsOn?: string[];
    }>;
  }>;
  /** Existing branches to reuse */
  reuseBranches: Array<{
    branchNodeId: string;
    forkAtStepId?: string;
    newSteps?: Array<{
      type: string;
      label: string;
      prompt: string;
    }>;
  }>;
  /** Memory concepts to store/update */
  memoryUpdates: Array<{
    concept: string;
    facts: string[];
  }>;
  /** Direct response (for simple questions that don't need chains) */
  directResponse?: string;
}

/** Camera state for blob canvas */
export interface BlobCamera {
  x: number;
  y: number;
  zoom: number;
}
