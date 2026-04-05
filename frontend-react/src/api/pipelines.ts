// ─── Pipeline API functions ──────────────────────────────────────────────────

import { api } from "./client";
import type { PipelineDefinition } from "../types/chain";
import type { PipelineExecution } from "../types/execution";

export interface PipelineListItem {
  name: string;
  description?: string;
  version?: string;
  /** Backend returns chainCount */
  chainCount?: number;
  /** Alias */
  chains?: number;
  error?: string;
}

/** List all pipelines */
export function fetchPipelines(): Promise<PipelineListItem[]> {
  return api.get<PipelineListItem[]>("/pipelines");
}

/** Get parsed JSON for a pipeline */
export function fetchPipelineJson(name: string): Promise<PipelineDefinition> {
  return api.get<PipelineDefinition>(
    `/pipelines/${encodeURIComponent(name)}/json`,
  );
}

/** Execute a pipeline */
export function executePipeline(
  name: string,
  input: Record<string, string>,
): Promise<{ executionId: string }> {
  return api.post<{ executionId: string }>(
    `/pipelines/${encodeURIComponent(name)}/execute`,
    { input },
  );
}

/** Delete a pipeline */
export function deletePipeline(name: string): Promise<void> {
  return api.delete<void>(`/pipelines/${encodeURIComponent(name)}`);
}

/** Get a pipeline execution by ID */
export function fetchPipelineExecution(
  id: string,
): Promise<PipelineExecution> {
  return api.get<PipelineExecution>(
    `/pipeline-executions/${encodeURIComponent(id)}`,
  );
}
