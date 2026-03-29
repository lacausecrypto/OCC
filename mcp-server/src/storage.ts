/**
 * SQLite-backed persistence layer for executions + step checkpoints.
 *
 * Replaces the old executions.json with:
 * - Per-step checkpointing (survives crash mid-execution)
 * - Time-travel queries (view any historical state)
 * - Efficient queries (by chain, status, date range)
 * - Auto-purge by age
 */
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ChainExecution, StepResult, ExecutionStatus } from "./types.js";

let db: Database.Database;

// ─── Init ───────────────────────────────────────────────────────────────────

function getDbPath(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "occ.db");
  }
  return process.env.OCC_DB ?? path.join(os.tmpdir(), "occ.db");
}

export function initStorage(): void {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // Write-Ahead Logging for better concurrency
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      chain_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS step_checkpoints (
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      checkpoint_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (execution_id, step_id),
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_exec_chain ON executions(chain_name);
    CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);
    CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at);
    CREATE INDEX IF NOT EXISTS idx_step_exec ON step_checkpoints(execution_id);
  `);

  // Migrate: fix orphaned running executions from previous crash
  db.prepare(`
    UPDATE executions SET status = 'error', error = 'Interrupted — server restarted', finished_at = datetime('now')
    WHERE status = 'running'
  `).run();

  // Purge old executions
  const maxAge = Number(process.env.EXECUTION_MAX_AGE_DAYS) || 7;
  const purged = db.prepare(`
    DELETE FROM executions WHERE started_at < datetime('now', '-' || ? || ' days')
  `).run(maxAge);

  const count = db.prepare(`SELECT COUNT(*) as cnt FROM executions`).get() as { cnt: number };
  process.stderr.write(`[occ-db] SQLite initialized: ${dbPath} (${count.cnt} executions${purged.changes ? `, purged ${purged.changes}` : ""})\n`);
}

// ─── Execution CRUD ─────────────────────────────────────────────────────────

const stmts = {
  get insertExecution() {
    return db.prepare(`
      INSERT INTO executions (id, chain_name, status, input, started_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  },
  get updateExecution() {
    return db.prepare(`
      UPDATE executions SET status = ?, result = ?, error = ?, finished_at = ?, duration_ms = ?
      WHERE id = ?
    `);
  },
  get getExecution() {
    return db.prepare(`SELECT * FROM executions WHERE id = ?`);
  },
  get getAllExecutions() {
    return db.prepare(`SELECT * FROM executions ORDER BY started_at DESC LIMIT ? OFFSET ?`);
  },
  get getExecutionsByChain() {
    return db.prepare(`SELECT * FROM executions WHERE chain_name = ? ORDER BY started_at DESC LIMIT ?`);
  },
  get deleteExecution() {
    return db.prepare(`DELETE FROM executions WHERE id = ?`);
  },
  // Step checkpoints
  get upsertStep() {
    return db.prepare(`
      INSERT INTO step_checkpoints (execution_id, step_id, status, output, error, started_at, finished_at, duration_ms, input_tokens, output_tokens, checkpoint_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(execution_id, step_id) DO UPDATE SET
        status = excluded.status,
        output = excluded.output,
        error = excluded.error,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        duration_ms = excluded.duration_ms,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        checkpoint_at = datetime('now')
    `);
  },
  get getSteps() {
    return db.prepare(`SELECT * FROM step_checkpoints WHERE execution_id = ? ORDER BY started_at`);
  },
  get getStepHistory() {
    return db.prepare(`
      SELECT sc.*, e.chain_name FROM step_checkpoints sc
      JOIN executions e ON e.id = sc.execution_id
      WHERE sc.execution_id = ? ORDER BY sc.checkpoint_at
    `);
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function saveExecution(exec: ChainExecution): void {
  const existing = stmts.getExecution.get(exec.id);
  if (!existing) {
    stmts.insertExecution.run(exec.id, exec.chainName, exec.status, JSON.stringify(exec.input), exec.startedAt);
  }
  stmts.updateExecution.run(exec.status, exec.result ?? null, exec.error ?? null, exec.finishedAt ?? null, exec.durationMs ?? null, exec.id);
}

export function checkpointStep(executionId: string, step: StepResult): void {
  stmts.upsertStep.run(
    executionId,
    step.stepId,
    step.status,
    step.output ?? null,
    step.error ?? null,
    step.startedAt ?? null,
    step.finishedAt ?? null,
    step.durationMs ?? null,
    step.inputTokens ?? null,
    step.outputTokens ?? null,
  );
}

export function loadExecution(id: string): ChainExecution | null {
  const row = stmts.getExecution.get(id) as any;
  if (!row) return null;

  const steps: Record<string, StepResult> = {};
  const stepRows = stmts.getSteps.all(id) as any[];
  for (const s of stepRows) {
    steps[s.step_id] = {
      stepId: s.step_id,
      status: s.status,
      output: s.output ?? undefined,
      error: s.error ?? undefined,
      startedAt: s.started_at ?? undefined,
      finishedAt: s.finished_at ?? undefined,
      durationMs: s.duration_ms ?? undefined,
      inputTokens: s.input_tokens ?? undefined,
      outputTokens: s.output_tokens ?? undefined,
    };
  }

  return {
    id: row.id,
    chainName: row.chain_name,
    status: row.status as ExecutionStatus,
    input: JSON.parse(row.input || "{}"),
    steps,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
  };
}

export function listExecutions(limit = 50, offset = 0): ChainExecution[] {
  const rows = stmts.getAllExecutions.all(limit, offset) as any[];
  return rows.map((row) => {
    const steps: Record<string, StepResult> = {};
    const stepRows = stmts.getSteps.all(row.id) as any[];
    for (const s of stepRows) {
      steps[s.step_id] = {
        stepId: s.step_id,
        status: s.status,
        output: s.output ?? undefined,
        error: s.error ?? undefined,
        startedAt: s.started_at ?? undefined,
        finishedAt: s.finished_at ?? undefined,
        durationMs: s.duration_ms ?? undefined,
        inputTokens: s.input_tokens ?? undefined,
        outputTokens: s.output_tokens ?? undefined,
      };
    }
    return {
      id: row.id,
      chainName: row.chain_name,
      status: row.status as ExecutionStatus,
      input: JSON.parse(row.input || "{}"),
      steps,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    };
  });
}

/** Time-travel: get the full checkpoint history for an execution. */
export function getExecutionTimeline(executionId: string): Array<{
  stepId: string;
  status: string;
  checkpointAt: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}> {
  const rows = stmts.getStepHistory.all(executionId) as any[];
  return rows.map((r) => ({
    stepId: r.step_id,
    status: r.status,
    checkpointAt: r.checkpoint_at,
    durationMs: r.duration_ms ?? undefined,
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
  }));
}

/** Get execution stats for a chain. */
export function getChainStats(chainName: string): {
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalTokens: { input: number; output: number };
} {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as success,
      AVG(duration_ms) as avg_duration
    FROM executions WHERE chain_name = ?
  `).get(chainName) as any;

  const tokens = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output
    FROM step_checkpoints sc
    JOIN executions e ON e.id = sc.execution_id
    WHERE e.chain_name = ?
  `).get(chainName) as any;

  return {
    totalRuns: stats.total || 0,
    successRate: stats.total > 0 ? (stats.success / stats.total) * 100 : 0,
    avgDurationMs: Math.round(stats.avg_duration || 0),
    totalTokens: {
      input: tokens.total_input || 0,
      output: tokens.total_output || 0,
    },
  };
}

export function closeStorage(): void {
  if (db) db.close();
}
