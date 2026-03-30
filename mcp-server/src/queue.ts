/**
 * Execution Queue — persistent job queue with priority and worker pool.
 *
 * Instead of rejecting requests with 429 when busy, jobs are queued
 * and processed in priority order by a configurable worker pool.
 *
 * Features:
 * - Priority queue (higher priority jobs run first)
 * - SQLite persistence (survives server restarts)
 * - Configurable max concurrent workers
 * - Job status tracking (queued → running → done/error)
 * - Auto-retry with backoff for failed jobs
 * - Queue metrics (depth, wait time, throughput)
 */
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface QueueJob {
  id: string;
  type: "chain" | "pipeline";
  name: string;                    // chain or pipeline name
  input: Record<string, string>;
  priority: number;                // higher = first (default: 5)
  status: "queued" | "running" | "done" | "error";
  executionId?: string;            // assigned when execution starts
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  retries: number;
  maxRetries: number;
}

type JobRunner = (job: QueueJob) => Promise<string>; // Returns executionId

let db: Database.Database;
let _runner: JobRunner | null = null;
let _processing = false;
let _interval: ReturnType<typeof setInterval> | null = null;

const MAX_WORKERS = process.env.MAX_CONCURRENT_EXECUTIONS !== undefined
  ? Math.max(1, Number(process.env.MAX_CONCURRENT_EXECUTIONS))
  : 5;
let activeWorkers = 0;

// ─── Init ───────────────────────────────────────────────────────────────────

function getQueueDbPath(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "occ-queue.db");
  }
  return process.env.OCC_QUEUE_DB ?? path.join(os.tmpdir(), "occ-queue.db");
}

export function initQueue(runner: JobRunner): void {
  // Guard against double initialization (leaks interval + db connection)
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  if (db?.open) {
    _stmts = null;
    db.close();
  }

  _runner = runner;
  _processing = false;
  activeWorkers = 0;

  const dbPath = getQueueDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'chain',
      name TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      execution_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority DESC, created_at ASC);
  `);

  // Mark orphaned running jobs as queued (retry on restart)
  const orphaned = db.prepare(`
    UPDATE queue SET status = 'queued', retries = retries + 1
    WHERE status = 'running'
  `).run();
  if (orphaned.changes > 0) {
    process.stderr.write(`[occ-queue] Re-queued ${orphaned.changes} orphaned job(s)\n`);
  }

  // Start processing loop
  _interval = setInterval(processQueue, 1000);

  const pending = db.prepare(`SELECT COUNT(*) as cnt FROM queue WHERE status = 'queued'`).get() as { cnt: number };
  process.stderr.write(`[occ-queue] Queue initialized (${pending.cnt} pending, max ${MAX_WORKERS} workers)\n`);
}

// ─── Prepared statements ────────────────────────────────────────────────────

let _stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  return {
    enqueue: db.prepare(`
      INSERT INTO queue (id, type, name, input, priority, status, created_at, max_retries)
      VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'), ?)
    `),
    nextJob: db.prepare(`
      SELECT * FROM queue
      WHERE status = 'queued' AND (retries < max_retries OR retries = 0)
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `),
    claimJob: db.prepare(`
      UPDATE queue SET status = 'running', started_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `),
    completeJob: db.prepare(`
      UPDATE queue SET status = 'done', execution_id = ?, finished_at = datetime('now')
      WHERE id = ?
    `),
    failJob: db.prepare(`
      UPDATE queue SET status = CASE WHEN retries + 1 < max_retries THEN 'queued' ELSE 'error' END,
        error = ?, retries = retries + 1, finished_at = datetime('now')
      WHERE id = ?
    `),
    getJob: db.prepare(`SELECT * FROM queue WHERE id = ?`),
    listJobs: db.prepare(`SELECT * FROM queue ORDER BY created_at DESC LIMIT ? OFFSET ?`),
    listByStatus: db.prepare(`SELECT * FROM queue WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`),
    cancelJob: db.prepare(`
      UPDATE queue SET status = 'error', error = 'Cancelled', finished_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `),
    purgeOld: db.prepare(`
      DELETE FROM queue WHERE finished_at < datetime('now', '-' || ? || ' days')
      AND status IN ('done', 'error')
    `),
    queueStats: db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') as queued,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'done') as done,
        COUNT(*) FILTER (WHERE status = 'error') as errored,
        AVG(CASE WHEN started_at IS NOT NULL THEN
          (julianday(started_at) - julianday(created_at)) * 86400
        END) as avg_wait_seconds
      FROM queue
    `),
  };
}

function stmts() {
  if (!_stmts) _stmts = prepareStatements();
  return _stmts;
}

// ─── Queue processing ───────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  if (_processing || !_runner || !db?.open) return;
  if (activeWorkers >= MAX_WORKERS) return;

  _processing = true;
  try {
    while (activeWorkers < MAX_WORKERS) {
      const job = stmts().nextJob.get() as any;
      if (!job) break; // No more jobs

      // Claim it (atomic)
      const claimed = stmts().claimJob.run(job.id);
      if (claimed.changes === 0) continue; // Someone else got it

      activeWorkers++;
      // Run async — don't await (allows parallel workers)
      runJob(job).finally(() => { activeWorkers--; });
    }
  } finally {
    _processing = false;
  }
}

async function runJob(row: any): Promise<void> {
  const jobId = row.id as string;
  try {
    const executionId = await _runner!({
      id: jobId,
      type: row.type,
      name: row.name,
      input: JSON.parse(row.input || "{}"),
      priority: row.priority,
      status: "running",
      createdAt: row.created_at,
      startedAt: new Date().toISOString(),
      retries: row.retries,
      maxRetries: row.max_retries,
    });
    try {
      stmts().completeJob.run(executionId, jobId);
    } catch (dbErr) {
      process.stderr.write(`[occ-queue] CRITICAL: Failed to mark job ${jobId} as done: ${dbErr}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      stmts().failJob.run(message, jobId);
    } catch (dbErr) {
      process.stderr.write(`[occ-queue] CRITICAL: Failed to mark job ${jobId} as error: ${dbErr}\n`);
    }
    process.stderr.write(`[occ-queue] Job ${jobId} failed: ${message}\n`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function enqueue(
  type: "chain" | "pipeline",
  name: string,
  input: Record<string, string>,
  options: { priority?: number; maxRetries?: number } = {},
): QueueJob {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const priority = options.priority ?? 5;
  const maxRetries = options.maxRetries ?? 1;

  stmts().enqueue.run(id, type, name, JSON.stringify(input), priority, maxRetries);

  // Trigger immediate processing
  setImmediate(() => processQueue());

  return {
    id,
    type,
    name,
    input,
    priority,
    status: "queued",
    createdAt: new Date().toISOString(),
    retries: 0,
    maxRetries,
  };
}

export function getQueueJob(id: string): QueueJob | null {
  const row = stmts().getJob.get(id) as any;
  if (!row) return null;
  return rowToJob(row);
}

export function listQueueJobs(limit = 50, offset = 0): QueueJob[] {
  const rows = stmts().listJobs.all(limit, offset) as any[];
  return rows.map(rowToJob);
}

export function listQueueByStatus(status: string, limit = 50): QueueJob[] {
  const rows = stmts().listByStatus.all(status, limit) as any[];
  return rows.map(rowToJob);
}

export function cancelQueueJob(id: string): boolean {
  const result = stmts().cancelJob.run(id);
  return result.changes > 0;
}

export function getQueueStats(): {
  queued: number;
  running: number;
  done: number;
  errored: number;
  avgWaitSeconds: number;
  maxWorkers: number;
  activeWorkers: number;
} {
  const row = stmts().queueStats.get() as any;
  return {
    queued: row?.queued ?? 0,
    running: row?.running ?? 0,
    done: row?.done ?? 0,
    errored: row?.errored ?? 0,
    avgWaitSeconds: Math.round(row?.avg_wait_seconds ?? 0),
    maxWorkers: MAX_WORKERS,
    activeWorkers,
  };
}

export function purgeOldJobs(days = 7): number {
  return stmts().purgeOld.run(days).changes;
}

export function getActiveWorkerCount(): number {
  return activeWorkers;
}

function rowToJob(row: any): QueueJob {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    input: JSON.parse(row.input || "{}"),
    priority: row.priority,
    status: row.status,
    executionId: row.execution_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    retries: row.retries,
    maxRetries: row.max_retries,
  };
}

export function closeQueue(): void {
  if (_interval) clearInterval(_interval);
  _interval = null;
  _stmts = null;
  _runner = null;
  _processing = false;
  activeWorkers = 0;
  if (db?.open) db.close();
}
