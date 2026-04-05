/**
 * Chain Scheduler — cron-based scheduled execution of chains.
 * Persists schedules to SCHEDULES_FILE (JSON).
 */
import * as cron from "node-cron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { loadChain } from "./loader.js";
import { executeChain } from "./executor.js";
import { loadPipeline } from "./pipeline-loader.js";
import { executePipeline } from "./pipeline-executor.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  label: string;
  type?: "chain" | "pipeline";  // defaults to "chain" for backward compat
  chainName: string;             // chain name OR pipeline name
  input: Record<string, string>;
  cron: string;          // standard 5-field cron expression
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunStatus?: "done" | "error";
  nextRunAt?: string;    // computed, not stored
}

// ── Persistence ───────────────────────────────────────────────────────────────

function schedulesFile(): string {
  return (
    process.env.SCHEDULES_FILE ??
    path.join(
      process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains"),
      "..",
      "schedules.json"
    )
  );
}

function loadSchedules(): Schedule[] {
  const file = schedulesFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Schedule[];
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  const target = schedulesFile();
  const tmp = `${target}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

// ── In-memory state ───────────────────────────────────────────────────────────

let schedules: Schedule[] = [];
const tasks = new Map<string, cron.ScheduledTask>();
const runningSchedules = new Set<string>();

// Emitter callback so SSE works for scheduled runs
import type { ExecutionEvent } from "./types.js";

let sseEmitter: ((executionId: string, event: ExecutionEvent) => void) | null = null;

export function setSSEEmitter(fn: (executionId: string, event: ExecutionEvent) => void): void {
  sseEmitter = fn;
}

// ── Cron helpers ──────────────────────────────────────────────────────────────

function nextRunDate(cronExpr: string): string | undefined {
  try {
    if (!cron.validate(cronExpr)) return undefined;

    // Parse 5-field cron: minute hour day month weekday
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return undefined;

    const now = new Date();
    // Brute-force scan: check every minute for the next 48 hours
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1); // start from next minute

    for (let i = 0; i < 48 * 60; i++) {
      if (matchesCron(candidate, parts)) {
        return candidate.toISOString();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function matchesCron(date: Date, parts: string[]): boolean {
  const [minExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;
  return (
    matchField(date.getMinutes(), minExpr, 0, 59) &&
    matchField(date.getHours(), hourExpr, 0, 23) &&
    matchField(date.getDate(), dayExpr, 1, 31) &&
    matchField(date.getMonth() + 1, monthExpr, 1, 12) &&
    matchField(date.getDay(), weekdayExpr, 0, 7) // 0 and 7 both = Sunday
  );
}

function matchField(value: number, expr: string, min: number, max: number): boolean {
  if (expr === "*") return true;

  // Handle comma-separated values
  for (const part of expr.split(",")) {
    // Handle step: */N or M-N/S
    const stepMatch = part.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
    if (stepMatch) {
      const rangeStart = stepMatch[1] ? parseInt(stepMatch[1]) : min;
      const rangeEnd = stepMatch[2] ? parseInt(stepMatch[2]) : max;
      const step = parseInt(stepMatch[3]);
      if (step > 0 && value >= rangeStart && value <= rangeEnd && (value - rangeStart) % step === 0) return true;
      continue;
    }

    // Handle range: M-N
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]);
      const to = parseInt(rangeMatch[2]);
      if (value >= from && value <= to) return true;
      continue;
    }

    // Exact value
    const exact = parseInt(part);
    if (!isNaN(exact)) {
      // For weekday, handle 7 == 0 (Sunday)
      if (max === 7 && ((exact === 7 && value === 0) || (exact === 0 && value === 0) || exact === value)) return true;
      else if (max !== 7 && exact === value) return true;
    }
  }

  return false;
}

// ── Schedule a single job ─────────────────────────────────────────────────────

async function runScheduleTask(s: Schedule): Promise<void> {
  if (runningSchedules.has(s.id)) return; // already executing — skip
  runningSchedules.add(s.id);

  try {
    s.lastRunAt = new Date().toISOString();
    saveSchedules(schedules);

    let executionId = "";
    const emitter = (event: ExecutionEvent) => {
      if ("executionId" in event && event.type === "execution_started") {
        executionId = event.executionId;
        s.lastRunId = executionId;
      }
      if (executionId && sseEmitter) {
        sseEmitter(executionId, event);
      }
    };

    try {
      if (s.type === "pipeline") {
        const pipeline = loadPipeline(s.chainName);
        await executePipeline(pipeline, s.input, emitter);
      } else {
        const chain = loadChain(s.chainName);
        await executeChain(chain, s.input, emitter);
      }
      s.lastRunStatus = "done";
    } catch {
      s.lastRunStatus = "error";
    }

    s.lastRunAt = new Date().toISOString();
    saveSchedules(schedules);
  } finally {
    runningSchedules.delete(s.id);
  }
}

function startTask(schedule: Schedule): void {
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron)) return;

  const task = cron.schedule(schedule.cron, async () => {
    const s = schedules.find((x) => x.id === schedule.id);
    if (!s || !s.enabled) return;
    await runScheduleTask(s);
  });

  tasks.set(schedule.id, task);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initScheduler(): void {
  schedules = loadSchedules();
  for (const s of schedules) {
    if (s.enabled) startTask(s);
  }
  process.stderr.write(`[scheduler] Loaded ${schedules.length} schedule(s)\n`);
}

export function getSchedules(): Schedule[] {
  return schedules.map((s) => ({
    ...s,
    nextRunAt: s.enabled ? nextRunDate(s.cron) : undefined,
  }));
}

export function getSchedule(id: string): Schedule | undefined {
  const s = schedules.find((x) => x.id === id);
  if (!s) return undefined;
  return { ...s, nextRunAt: s.enabled ? nextRunDate(s.cron) : undefined };
}

export function createSchedule(data: Omit<Schedule, "id" | "createdAt">): Schedule {
  const schedule: Schedule = {
    ...data,
    id: `sched_${crypto.randomBytes(6).toString("hex")}`,
    createdAt: new Date().toISOString(),
  };
  schedules.push(schedule);
  saveSchedules(schedules);
  if (schedule.enabled) startTask(schedule);
  return schedule;
}

export function updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  // Stop existing task
  tasks.get(id)?.stop();
  tasks.delete(id);

  schedules[idx] = { ...schedules[idx], ...patch };
  saveSchedules(schedules);

  if (schedules[idx].enabled) startTask(schedules[idx]);
  return { ...schedules[idx], nextRunAt: nextRunDate(schedules[idx].cron) };
}

export function deleteSchedule(id: string): boolean {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  tasks.get(id)?.stop();
  tasks.delete(id);
  schedules.splice(idx, 1);
  saveSchedules(schedules);
  return true;
}

export function toggleSchedule(id: string): Schedule | null {
  const s = schedules.find((x) => x.id === id);
  if (!s) return null;
  return updateSchedule(id, { enabled: !s.enabled });
}

export async function runNow(id: string): Promise<string> {
  const s = schedules.find((x) => x.id === id);
  if (!s) throw new Error("Schedule not found");

  let executionId = "";
  let resolved = false;
  s.lastRunAt = new Date().toISOString();

  // Create a promise that resolves as soon as execution_started fires
  const executionIdPromise = new Promise<string>((resolve) => {
    const emitter = (event: ExecutionEvent) => {
      if ("executionId" in event && event.type === "execution_started" && !resolved) {
        executionId = event.executionId;
        s.lastRunId = executionId;
        resolved = true;
        resolve(executionId);
      }
      if (executionId && sseEmitter) sseEmitter(executionId, event);
    };

    // Fire off execution in background (don't await)
    (async () => {
      try {
        if (s.type === "pipeline") {
          const pipeline = loadPipeline(s.chainName);
          await executePipeline(pipeline, s.input, emitter);
        } else {
          const chain = loadChain(s.chainName);
          await executeChain(chain, s.input, emitter);
        }
        s.lastRunStatus = "done";
      } catch (err) {
        s.lastRunStatus = "error";
        // If execution_started never fired, reject with the error
        if (!resolved) {
          resolved = true;
          resolve(""); // resolve with empty to avoid hang; the caller gets the error via status
        }
      } finally {
        saveSchedules(schedules);
      }
    })();
  });

  // Safety timeout: if execution_started doesn't fire within 10s, something is wrong
  const timeoutPromise = new Promise<string>((_, reject) => {
    setTimeout(() => {
      if (!resolved) reject(new Error("Execution failed to start within 10s"));
    }, 10000);
  });

  return Promise.race([executionIdPromise, timeoutPromise]);
}
