// ─── Chains & pipelines store ────────────────────────────────────────────────

import { create } from "zustand";
import { fetchChains } from "../api/chains";
import {
  fetchPipelines,
  type PipelineListItem,
} from "../api/pipelines";
import type { ChainListItem } from "../api/chains";

export type SortBy = "name" | "steps" | "pretools" | "tools";
export type FilterType = "all" | "chain" | "pipeline";
export type ViewMode = "grid" | "list" | "compact" | "table";
export type SizeFilter = "" | "small" | "medium" | "large";

interface ChainsState {
  chains: ChainListItem[];
  pipelines: PipelineListItem[];
  loading: boolean;
  error: string | null;

  searchQuery: string;
  sortBy: SortBy;
  filterType: FilterType;
  viewMode: ViewMode;
  sizeFilter: SizeFilter;

  setSearchQuery: (q: string) => void;
  setSortBy: (s: SortBy) => void;
  setFilterType: (f: FilterType) => void;
  setViewMode: (v: ViewMode) => void;
  setSizeFilter: (s: SizeFilter) => void;

  fetchChains: () => Promise<void>;
  fetchPipelines: () => Promise<void>;
  fetchAll: () => Promise<void>;
}

export const useChainsStore = create<ChainsState>((set) => ({
  chains: [],
  pipelines: [],
  loading: false,
  error: null,

  searchQuery: "",
  sortBy: "name",
  filterType: "all",
  viewMode: "grid",
  sizeFilter: "",

  setSearchQuery: (q) => set({ searchQuery: q }),
  setSortBy: (s) => set({ sortBy: s }),
  setSizeFilter: (s) => set({ sizeFilter: s }),
  setFilterType: (f) => set({ filterType: f }),
  setViewMode: (v) => set({ viewMode: v }),

  fetchChains: async () => {
    try {
      set({ loading: true, error: null });
      const chains = await fetchChains();
      set({ chains, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch chains",
        loading: false,
      });
    }
  },

  fetchPipelines: async () => {
    try {
      const pipelines = await fetchPipelines();
      set({ pipelines });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to fetch pipelines",
      });
    }
  },

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const [chains, pipelines] = await Promise.all([
        fetchChains(),
        fetchPipelines(),
      ]);
      set({ chains, pipelines, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch data",
        loading: false,
      });
    }
  },
}));
