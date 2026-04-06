/**
 * Shared test utilities — cross-platform temp directory cleanup.
 *
 * Properly closes SQLite databases (storage + queue) before deleting
 * temp directories. Prevents EBUSY errors on Windows where file handles
 * must be released before deletion.
 */
import * as fs from "node:fs";

/**
 * Safely remove a temporary directory, closing any open SQLite DBs first.
 * Call this in afterEach/afterAll instead of raw fs.rmSync().
 */
export async function cleanupTmpDir(tmpDir: string): Promise<void> {
  // 1. Close all SQLite database connections
  try {
    const { closeStorage } = await import("../src/storage.js");
    closeStorage();
  } catch { /* storage not initialized in this test */ }

  try {
    const { closeQueue } = await import("../src/queue.js");
    closeQueue();
  } catch { /* queue not initialized in this test */ }

  try {
    const { closeExtraDbs } = await import("../src/pretool-extras.js");
    closeExtraDbs();
  } catch { /* extras not initialized in this test */ }

  // 2. On Windows, wait for file handle release
  if (process.platform === "win32") {
    await new Promise(r => setTimeout(r, 150));
  }

  // 3. Delete the temp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Last resort: if still locked, try again after a longer delay
    if (process.platform === "win32") {
      await new Promise(r => setTimeout(r, 500));
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* give up */ }
    }
  }
}

/**
 * Synchronous cleanup for tests that don't use async afterEach.
 * Only wraps rmSync in try/catch — use cleanupTmpDir when possible.
 */
export function cleanupTmpDirSync(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* EBUSY on Windows — DB still locked */ }
}
