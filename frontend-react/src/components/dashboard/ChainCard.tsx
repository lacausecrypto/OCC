import { useServerStore } from "../../stores/server";
import { getStepTypeColors } from "./stepColors";
import styles from "./Dashboard.module.css";

export interface ChainCardData {
  name: string;
  description?: string;
  stepCount: number;
  steps?: { type?: string; id?: string; pre_tools?: string[]; tools?: string[] }[];
}

interface ChainCardProps {
  chain: ChainCardData;
  onRun: (name: string) => void;
  onEdit: (name: string) => void;
  onDelete?: (name: string) => void;
}

export function ChainCard({ chain, onRun, onEdit, onDelete }: ChainCardProps) {
  const { serverOnline } = useServerStore();

  const steps = chain.steps ?? [];
  const stepCount = chain.stepCount || steps.length;
  const types = steps.map((s) => s.type ?? "agent").filter(Boolean);
  const uniqueTypes = [...new Set(types)];
  const preToolCount = steps.reduce(
    (n, s) => n + (s.pre_tools?.length ?? 0),
    0,
  );
  const toolCount = steps.reduce((n, s) => n + (s.tools?.length ?? 0), 0);

  return (
    <div className={styles.card}>
      <div className={styles.cardName}>{chain.name}</div>
      <div className={styles.cardDesc}>{chain.description ?? ""}</div>
      <div className={styles.cardMeta}>
        <span className={`${styles.pill} ${styles.pillAccent}`}>
          {stepCount} steps
        </span>
        <span className={styles.pill}>{preToolCount} pre-tools</span>
        <span className={styles.pill}>{toolCount} tools</span>
        {uniqueTypes.slice(0, 5).map((t) => {
          const c = getStepTypeColors()[t] ?? "#888";
          return (
          <span
            key={t}
            className={styles.pill}
            style={{
              borderColor: `${c}40`,
              color: c,
            }}
          >
            {t}
          </span>
          );
        })}
      </div>
      <div className={styles.cardBottom}>
        <div className={styles.cardStatus}>
          <span
            className={`${styles.statusDot} ${serverOnline ? styles.online : ""}`}
          />
          {!serverOnline ? "offline" : stepCount === 0 ? "not ready" : "ready"}
        </div>
        <div className={styles.cardActions}>
          <button
            className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`}
            onClick={() => onRun(chain.name)}
          >
            Run
          </button>
          <button
            className={`${styles.btn} ${styles.btnSmall}`}
            onClick={() => onEdit(chain.name)}
          >
            Edit
          </button>
          {onDelete && (
            <button
              className={`${styles.btn} ${styles.btnSmall}`}
              onClick={() => onDelete(chain.name)}
              style={{ color: "var(--c-error)" }}
            >
              Del
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
