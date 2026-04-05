// ─── Execution API functions ─────────────────────────────────────────────────

import { api } from "./client";
import type { ChainExecution } from "../types/execution";

export interface ExecuteChainInput {
  [key: string]: string;
}

export interface ExecuteResult {
  executionId: string;
}

/** Execute a chain by name */
export function executeChain(
  name: string,
  input: ExecuteChainInput,
  priority?: number,
): Promise<ExecuteResult> {
  return api.post<ExecuteResult>(`/execute/${encodeURIComponent(name)}`, {
    input,
    ...(priority !== undefined ? { priority } : {}),
  });
}

/** List executions with optional pagination */
export function fetchExecutions(
  limit = 50,
  offset = 0,
): Promise<ChainExecution[]> {
  return api.get<ChainExecution[]>(
    `/executions?limit=${limit}&offset=${offset}`,
  );
}

/** Get a single execution by ID */
export function fetchExecution(id: string): Promise<ChainExecution> {
  return api.get<ChainExecution>(`/executions/${encodeURIComponent(id)}`);
}

/** Cancel a running execution */
export function cancelExecution(id: string): Promise<void> {
  return api.delete<void>(`/executions/${encodeURIComponent(id)}`);
}
