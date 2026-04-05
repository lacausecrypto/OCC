// ─── Execution types (mirrored from backend types.ts) ────────────────────────

export type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

export type ExecutionStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChainExecution {
  id: string;
  chainName: string;
  status: ExecutionStatus;
  input: Record<string, string>;
  steps: Record<string, StepResult>;
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface PipelineExecution {
  id: string;
  pipelineName: string;
  status: ExecutionStatus;
  input: Record<string, string>;
  chains: Record<
    string,
    {
      chainRefId: string;
      chainName: string;
      status: ExecutionStatus;
      executionId?: string;
      result?: string;
      error?: string;
      durationMs?: number;
    }
  >;
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

// ─── SSE events (discriminated union) ────────────────────────────────────────

interface ExecutionEventBase {
  executionId: string;
  timestamp?: string;
}

export type ExecutionEvent =
  | (ExecutionEventBase & { type: "execution_started"; chainName: string })
  | (ExecutionEventBase & { type: "step_started"; stepId: string; label?: string })
  | (ExecutionEventBase & { type: "step_output"; stepId: string; chunk: string })
  | (ExecutionEventBase & {
      type: "step_done";
      stepId: string;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
    })
  | (ExecutionEventBase & { type: "step_error"; stepId: string; error: string })
  | (ExecutionEventBase & {
      type: "step_log";
      stepId: string;
      message: string;
      level: "info" | "warn" | "error";
    })
  | (ExecutionEventBase & {
      type: "execution_done";
      result: string;
      durationMs: number;
    })
  | (ExecutionEventBase & {
      type: "step_waiting_approval";
      stepId: string;
      prompt: string;
    })
  | (ExecutionEventBase & { type: "execution_error"; error: string })
  | (ExecutionEventBase & { type: "step_cache_hit"; stepId: string })
  | (ExecutionEventBase & {
      type: "gate_action";
      stepId: string;
      action: string;
      reason?: string;
    });
