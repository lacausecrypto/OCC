import { useEffect, useState, useCallback, useMemo } from "react";
import { useChainsStore } from "../../stores/chains";
import { useServerStore } from "../../stores/server";
import { fetchChainJson, deleteChain } from "../../api/chains";
import { fetchPipelineJson, deletePipeline } from "../../api/pipelines";
import { StatusBar } from "./StatusBar";
import { DashToolbar } from "./DashToolbar";
import { ChainCard, type ChainCardData } from "./ChainCard";
import { PipelineCard, type PipelineCardData } from "./PipelineCard";
import { RunModal } from "../modals";
import { useAppStore } from "../../stores/app";
import { BlobDashSection } from "./BlobDashSection";
import styles from "./Dashboard.module.css";

const PAGE_SIZE = 12;

export function Dashboard() {
  const {
    chains: rawChains,
    pipelines: rawPipelines,
    loading,
    fetchAll,
    searchQuery,
    sortBy,
    filterType,
    viewMode,
    sizeFilter,
  } = useChainsStore();
  const { serverOnline, checkHealth } = useServerStore();

  // Expanded chain detail (lazy-loaded)
  const [chainDetails, setChainDetails] = useState<Map<string, ChainCardData>>(
    new Map(),
  );
  const [pipelineDetails, setPipelineDetails] = useState<
    Map<string, PipelineCardData>
  >(new Map());

  // Pagination
  const [chainLimit, setChainLimit] = useState(PAGE_SIZE);

  // Type filter (step type, e.g. "agent", "router")
  const [typeFilter, setTypeFilter] = useState("");

  // Initial fetch
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Refresh handler
  const onRefresh = useCallback(async () => {
    await checkHealth();
    await fetchAll();
  }, [checkHealth, fetchAll]);

  // Build enriched chain data: use steps from listing API directly, fallback to lazy-loaded
  const chains: ChainCardData[] = useMemo(
    () =>
      rawChains.map((c) => {
        const detail = chainDetails.get(c.name);
        // steps from listing API (array) takes priority, then lazy-loaded detail
        const steps = (Array.isArray(c.steps) ? c.steps : undefined) ?? detail?.steps;
        return {
          name: c.name,
          description: c.description,
          stepCount: steps?.length ?? c.stepCount ?? 0,
          steps,
        };
      }),
    [rawChains, chainDetails],
  );

  // Build enriched pipeline data
  const pipelines: PipelineCardData[] = useMemo(
    () =>
      rawPipelines.map((p) => {
        const detail = pipelineDetails.get(p.name);
        return {
          name: p.name,
          description: p.description,
          chainCount: detail?.chainCount ?? p.chains ?? 0,
          chains: detail?.chains,
        };
      }),
    [rawPipelines, pipelineDetails],
  );

  // Lazy-load chain details when server is online
  useEffect(() => {
    if (!serverOnline || rawChains.length === 0) return;
    let cancelled = false;

    (async () => {
      for (const c of rawChains) {
        if (cancelled || chainDetails.has(c.name)) continue;
        try {
          const data = await fetchChainJson(c.name);
          if (cancelled) return;
          const steps = (data.steps ?? []).map((s) => ({
            type: s.type,
            id: s.id,
            pre_tools: s.pre_tools
              ?.map((pt): string | undefined => (typeof pt === "string" ? pt : (pt.type ?? pt.tool)))
              .filter((x): x is string => !!x),
            tools: s.tools,
          }));
          setChainDetails((prev) => {
            const next = new Map(prev);
            next.set(c.name, {
              name: c.name,
              description: data.description,
              stepCount: steps.length,
              steps,
            });
            return next;
          });
        } catch {
          /* skip */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverOnline, rawChains, chainDetails]);

  // Lazy-load pipeline details
  useEffect(() => {
    if (!serverOnline || rawPipelines.length === 0) return;
    let cancelled = false;

    (async () => {
      for (const p of rawPipelines) {
        if (cancelled || pipelineDetails.has(p.name)) continue;
        try {
          const data = await fetchPipelineJson(p.name);
          if (cancelled) return;
          const chainNames = (data.chains ?? []).map((ch) =>
            typeof ch === "string" ? ch : ch.chain,
          );
          setPipelineDetails((prev) => {
            const next = new Map(prev);
            next.set(p.name, {
              name: p.name,
              description: data.description,
              chainCount: chainNames.length,
              chains: chainNames,
            });
            return next;
          });
        } catch {
          /* skip */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverOnline, rawPipelines, pipelineDetails]);

  // Collect all unique step types across all loaded chains
  const allStepTypes = useMemo(() => {
    const set = new Set<string>();
    for (const c of chains) {
      for (const s of c.steps ?? []) {
        if (s.type) set.add(s.type);
      }
    }
    return [...set].sort();
  }, [chains]);

  // Filter + sort chains
  const filteredChains = useMemo(() => {
    const q = searchQuery.toLowerCase();
    let result = chains.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !(c.description ?? "").toLowerCase().includes(q))
        return false;
      if (typeFilter && !(c.steps ?? []).some((s) => s.type === typeFilter))
        return false;
      // Size filter
      if (sizeFilter === "small" && c.stepCount > 4) return false;
      if (sizeFilter === "medium" && (c.stepCount < 5 || c.stepCount > 8)) return false;
      if (sizeFilter === "large" && c.stepCount < 9) return false;
      return true;
    });

    // Sort
    if (sortBy === "steps") {
      result = [...result].sort((a, b) => b.stepCount - a.stepCount);
    } else if (sortBy === "pretools") {
      result = [...result].sort((a, b) => {
        const aPt = (a.steps ?? []).reduce((n, s) => n + (s.pre_tools?.length ?? 0), 0);
        const bPt = (b.steps ?? []).reduce((n, s) => n + (s.pre_tools?.length ?? 0), 0);
        return bPt - aPt;
      });
    } else if (sortBy === "tools") {
      result = [...result].sort((a, b) => {
        const aT = (a.steps ?? []).reduce((n, s) => n + (s.tools?.length ?? 0), 0);
        const bT = (b.steps ?? []).reduce((n, s) => n + (s.tools?.length ?? 0), 0);
        return bT - aT;
      });
    } else {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    }

    return result;
  }, [chains, searchQuery, typeFilter, sortBy, sizeFilter]);

  // Filter pipelines
  const filteredPipelines = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return pipelines.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.description ?? "").toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [pipelines, searchQuery]);

  // Visible chains (paginated)
  const visibleChains = filteredChains.slice(0, chainLimit);
  const hasMoreChains = filteredChains.length > chainLimit;

  // View mode CSS class
  const gridClass = [
    styles.cardGrid,
    viewMode === "list" ? styles.viewList : "",
    viewMode === "compact" ? styles.viewCompact : "",
    viewMode === "table" ? styles.viewTable : "",
  ]
    .filter(Boolean)
    .join(" ");

  // RunModal state
  const [runModal, setRunModal] = useState<{ name: string; type: "chain" | "pipeline" } | null>(null);

  // Callbacks
  const onRunChain = useCallback((name: string) => {
    setRunModal({ name, type: "chain" });
  }, []);

  const onEditChain = useCallback((name: string) => {
    void useAppStore.getState().loadChainToCanvas(name);
  }, []);

  const onRunPipeline = useCallback((name: string) => {
    setRunModal({ name, type: "pipeline" });
  }, []);

  const onEditPipeline = useCallback((name: string) => {
    void useAppStore.getState().loadPipelineToCanvas(name);
  }, []);

  const onDeleteChain = useCallback(async (name: string) => {
    if (!window.confirm(`Delete chain "${name}"? This cannot be undone.`)) return;
    try {
      await deleteChain(name);
      void fetchAll();
    } catch (err) {
      console.error("[OCC] Failed to delete chain:", err);
    }
  }, [fetchAll]);

  const onDeletePipeline = useCallback(async (name: string) => {
    if (!window.confirm(`Delete pipeline "${name}"? This cannot be undone.`)) return;
    try {
      await deletePipeline(name);
      void fetchAll();
    } catch (err) {
      console.error("[OCC] Failed to delete pipeline:", err);
    }
  }, [fetchAll]);

  const showChains = filterType === "all" || filterType === "chain";
  const showPipelines = filterType === "all" || filterType === "pipeline";

  return (
    <div className={styles.dash}>
      <StatusBar onRefresh={onRefresh} />

      <DashToolbar
        chainCount={chains.length}
        pipelineCount={pipelines.length}
        stepTypes={allStepTypes}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
      />

      <div className={styles.dashBody}>
        {loading && <div className={styles.loading}>Loading...</div>}

        {!loading && chains.length === 0 && pipelines.length === 0 && (
          <div className={styles.emptyState}>
            {serverOnline
              ? "No chains or pipelines found. Create one to get started."
              : "Server offline. Start OCC backend to see your chains."}
          </div>
        )}

        {/* Chains section */}
        {showChains && filteredChains.length > 0 && (
          <>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Chains <span className={styles.sectionCount}>{filteredChains.length}</span></div>
            </div>

            {viewMode === "table" ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Steps</th>
                      <th>Pre-tools</th>
                      <th>Tools</th>
                      <th>Types</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleChains.map((c) => {
                      const steps = c.steps ?? [];
                      const ptCount = steps.reduce((n, s) => n + (s.pre_tools?.length ?? 0), 0);
                      const toolCount = steps.reduce((n, s) => n + (s.tools?.length ?? 0), 0);
                      const types = [...new Set(steps.map((s) => s.type ?? "agent"))];
                      return (
                        <tr key={c.name}>
                          <td>
                            <div className={styles.tableName}>{c.name}</div>
                            <div className={styles.tableDesc}>{c.description ?? ""}</div>
                          </td>
                          <td className={styles.tableNum}>{c.stepCount}</td>
                          <td className={styles.tableNum}>{ptCount}</td>
                          <td className={styles.tableNum}>{toolCount}</td>
                          <td>{types.slice(0, 3).join(", ")}</td>
                          <td>
                            <div className={styles.cardActions}>
                              <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => onRunChain(c.name)}>Run</button>
                              <button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onEditChain(c.name)}>Edit</button>
                              <button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onDeleteChain(c.name)} style={{ color: "var(--c-error)" }}>Del</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={gridClass}>
                {visibleChains.map((c) => (
                  <ChainCard key={c.name} chain={c} onRun={onRunChain} onEdit={onEditChain} onDelete={onDeleteChain} />
                ))}
              </div>
            )}

            {hasMoreChains && (
              <div className={styles.showMore}>
                <button className={styles.btn} style={{ width: "100%" }} onClick={() => setChainLimit((v) => v + PAGE_SIZE)}>
                  Show more ({filteredChains.length - chainLimit} remaining)
                </button>
              </div>
            )}
          </>
        )}

        {/* Pipelines section */}
        {showPipelines && filteredPipelines.length > 0 && (
          <>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Pipelines <span className={styles.sectionCount}>{filteredPipelines.length}</span></div>
            </div>
            <div className={gridClass}>
              {filteredPipelines.map((p) => (
                <PipelineCard
                  key={p.name}
                  pipeline={p}
                  onRun={onRunPipeline}
                  onEdit={onEditPipeline}
                  onDelete={onDeletePipeline}
                />
              ))}
            </div>
          </>
        )}

        {/* ═══ BLOB Sessions ═══ */}
        <BlobDashSection />
      </div>

      {/* Run Modal */}
      {runModal && (
        <RunModal
          name={runModal.name}
          type={runModal.type}
          onClose={() => setRunModal(null)}
          onExecuted={(execId) => {
            useAppStore.getState().startExecution(execId, runModal.name, runModal.type);
          }}
        />
      )}
    </div>
  );
}
