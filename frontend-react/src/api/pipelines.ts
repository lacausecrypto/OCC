// ─── Pipeline API functions ──────────────────────────────────────────────────

import { api } from "./client";
import type { PipelineDefinition, PipelineChainRef } from "../types/chain";
import type { PipelineExecution } from "../types/execution";

/** Save (create or update) a pipeline definition.
 *  Backend accepts either `{ yaml: string, versionMessage?: string }` or
 *  the raw PipelineDefinition object. We send the JSON form. */
export function savePipeline(
  name: string,
  pipeline: Omit<PipelineDefinition, "name"> & { name?: string },
  versionMessage?: string,
): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { ...pipeline, name };
  if (versionMessage) body.versionMessage = versionMessage;
  return api.post<{ ok: boolean }>(
    `/pipelines/${encodeURIComponent(name)}`,
    body,
  );
}

/** Build a PipelineDefinition from canvas pipeline-stage nodes + edges.
 *  Each pipeline-stage subchain node represents a chain reference.
 *  The prompt field holds "Chain: <chainName>" and outputVar holds the stage id. */
export interface PipelineSerializeOpts {
  name: string;
  description?: string;
  version?: string;
  output?: string;            // template for final output, e.g. "{stage_2}"
  inputs?: PipelineDefinition["inputs"];
}

export function buildPipelineDefinition(
  stages: PipelineChainRef[],
  opts: PipelineSerializeOpts,
): PipelineDefinition {
  return {
    name: opts.name,
    description: opts.description,
    version: opts.version,
    inputs: opts.inputs,
    chains: stages,
    output: opts.output ?? (stages.length > 0 ? `{${stages[stages.length - 1].id}}` : ""),
  };
}

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
