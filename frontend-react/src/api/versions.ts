// ─── Version history API ─────────────────────────────────────────────────────

import { api } from "./client";

export interface VersionMeta {
  id: number;
  versionNumber: number;
  message: string | null;
  stepCount: number | null;
  createdAt: string;
  yamlSize: number;
}

export interface VersionFull extends VersionMeta {
  yamlContent: string;
}

export interface VersionListResponse {
  versions: VersionMeta[];
  total: number;
}

type EntityType = "chain" | "pipeline";

function basePath(type: EntityType, name: string): string {
  const prefix = type === "chain" ? "chains" : "pipelines";
  return `/${prefix}/${encodeURIComponent(name)}/versions`;
}

export function fetchVersions(type: EntityType, name: string, limit = 50, offset = 0): Promise<VersionListResponse> {
  return api.get<VersionListResponse>(`${basePath(type, name)}?limit=${limit}&offset=${offset}`);
}

export function fetchVersion(type: EntityType, name: string, versionNumber: number): Promise<VersionFull> {
  return api.get<VersionFull>(`${basePath(type, name)}/${versionNumber}`);
}

export function deleteVersion(type: EntityType, name: string, versionNumber: number): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(`${basePath(type, name)}/${versionNumber}`);
}

export function restoreVersion(type: EntityType, name: string, versionNumber: number): Promise<{ ok: boolean; restoredFrom: number }> {
  return api.post<{ ok: boolean; restoredFrom: number }>(`${basePath(type, name)}/${versionNumber}/restore`);
}
