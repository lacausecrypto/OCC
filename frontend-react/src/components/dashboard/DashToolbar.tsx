import { useChainsStore, type FilterType, type SortBy, type ViewMode, type SizeFilter } from "../../stores/chains";
import { useAppStore } from "../../stores/app";
import styles from "./Dashboard.module.css";

interface DashToolbarProps {
  chainCount: number;
  pipelineCount: number;
  stepTypes: string[];
  typeFilter: string;
  onTypeFilterChange: (t: string) => void;
}

export function DashToolbar({
  chainCount,
  pipelineCount,
  stepTypes,
  typeFilter,
  onTypeFilterChange,
}: DashToolbarProps) {
  const {
    filterType, setFilterType,
    sortBy, setSortBy,
    viewMode, setViewMode,
    searchQuery, setSearchQuery,
    sizeFilter, setSizeFilter,
  } = useChainsStore();

  const total = chainCount + pipelineCount;

  const filters: { id: FilterType; label: string; count: number }[] = [
    { id: "all", label: "All", count: total },
    { id: "chain", label: "Chains", count: chainCount },
    { id: "pipeline", label: "Pipelines", count: pipelineCount },
  ];

  const views: { id: ViewMode; label: string; icon: string }[] = [
    { id: "grid", label: "Grid", icon: "\u25A6" },
    { id: "list", label: "List", icon: "\u2630" },
    { id: "table", label: "Table", icon: "\u2637" },
    { id: "compact", label: "Mini", icon: "\u2B1C" },
  ];

  return (
    <div className={styles.toolbar}>
      {/* Type filter */}
      {filters.map((f) => (
        <button
          key={f.id}
          className={`${styles.filterBtn} ${filterType === f.id ? styles.filterBtnActive : ""}`}
          onClick={() => setFilterType(f.id)}
        >
          {f.label} ({f.count})
        </button>
      ))}

      <span className={styles.sep} />

      {/* Sort */}
      <select
        className={styles.select}
        value={sortBy}
        onChange={(e) => setSortBy(e.target.value as SortBy)}
      >
        <option value="name">Sort: Name</option>
        <option value="steps">Sort: Steps</option>
        <option value="pretools">Sort: Pre-tools</option>
        <option value="tools">Sort: Tools</option>
      </select>

      {/* Step type filter */}
      <select
        className={styles.select}
        value={typeFilter}
        onChange={(e) => onTypeFilterChange(e.target.value)}
      >
        <option value="">All types</option>
        {stepTypes.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      {/* Size filter */}
      <select
        className={styles.select}
        value={sizeFilter}
        onChange={(e) => setSizeFilter(e.target.value as SizeFilter)}
      >
        <option value="">All sizes</option>
        <option value="small">Small (1-4)</option>
        <option value="medium">Medium (5-8)</option>
        <option value="large">Large (9+)</option>
      </select>

      <span className={styles.spacer} />

      {/* View toggle */}
      <div className={styles.viewToggle}>
        {views.map((v) => (
          <button
            key={v.id}
            className={`${styles.viewBtn} ${viewMode === v.id ? styles.viewBtnActive : ""}`}
            onClick={() => setViewMode(v.id)}
            title={v.label}
          >
            {v.icon}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        className={styles.searchInput}
        placeholder="Search..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      {/* New chain */}
      <button
        className={`${styles.filterBtn} ${styles.filterBtnActive}`}
        onClick={() => useAppStore.getState().createNewChain()}
      >
        + New
      </button>
    </div>
  );
}
