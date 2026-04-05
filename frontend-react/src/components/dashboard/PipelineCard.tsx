import { useServerStore } from "../../stores/server";
import styles from "./Dashboard.module.css";

export interface PipelineCardData {
  name: string;
  description?: string;
  chainCount: number;
  chains?: string[];
}

interface PipelineCardProps {
  pipeline: PipelineCardData;
  onRun: (name: string) => void;
  onEdit: (name: string) => void;
  onDelete?: (name: string) => void;
}

export function PipelineCard({ pipeline, onRun, onEdit, onDelete }: PipelineCardProps) {
  const { serverOnline } = useServerStore();
  const chainNames = pipeline.chains ?? [];

  return (
    <div className={styles.card}>
      <div className={styles.cardName}>
        {pipeline.name}
        <span className={`${styles.pill} ${styles.pillPipeline}`}>
          pipeline
        </span>
      </div>
      <div className={styles.cardDesc}>{pipeline.description ?? ""}</div>
      <div className={styles.cardMeta}>
        {chainNames.map((cn) => (
          <span key={cn} className={`${styles.pill} ${styles.pillAccent}`}>
            {cn}
          </span>
        ))}
      </div>
      <div className={styles.cardBottom}>
        <div className={styles.cardStatus}>
          <span
            className={`${styles.statusDot} ${serverOnline ? styles.online : ""}`}
          />
          {pipeline.chainCount} stages
        </div>
        <div className={styles.cardActions}>
          <button
            className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`}
            onClick={() => onRun(pipeline.name)}
          >
            Run
          </button>
          <button
            className={`${styles.btn} ${styles.btnSmall}`}
            onClick={() => onEdit(pipeline.name)}
          >
            Edit
          </button>
          {onDelete && (
            <button
              className={`${styles.btn} ${styles.btnSmall}`}
              onClick={() => onDelete(pipeline.name)}
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
