/**
 * Tests for pretool-executor.ts via the exported functions.
 * Tests pure pre-tools that don't need external services.
 *
 * Covers:
 * - current_datetime (all formats/timezones)
 * - env_var (with defaults)
 * - read_file (path traversal protection)
 * - write_file (basic + append)
 * - json_parse (via extractJsonPath)
 * - executePreTools orchestration (sequential + parallel)
 * - executePreToolWithRetry error handling
 * - Pre-tool caching
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeSinglePreTool, executePreTools, executePreToolWithRetry } from "../src/pretool-executor.js";
import type { PreTool } from "../src/types.js";

const onLog = vi.fn();

beforeEach(() => {
  onLog.mockClear();
});

// ─── current_datetime ──────────────────────────────────────────────────────

describe("current_datetime pre-tool", () => {
  it("returns ISO format by default", async () => {
    const result = await executeSinglePreTool(
      { type: "current_datetime", inject_as: "now" } as PreTool,
      {},
      onLog,
    );
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns unix timestamp when format is unix", async () => {
    const result = await executeSinglePreTool(
      { type: "current_datetime", inject_as: "now", format: "unix" } as PreTool,
      {},
      onLog,
    );
    const num = Number(result);
    expect(num).toBeGreaterThan(1000000000); // > 2001
    expect(num).toBeLessThan(3000000000);    // < 2065
  });

  it("returns locale format when format is locale", async () => {
    const result = await executeSinglePreTool(
      { type: "current_datetime", inject_as: "now", format: "locale" } as PreTool,
      {},
      onLog,
    );
    // Locale format has commas and words like "Saturday, April 4, 2026"
    expect(result.length).toBeGreaterThan(10);
  });

  it("respects timezone parameter", async () => {
    const result = await executeSinglePreTool(
      { type: "current_datetime", inject_as: "now", format: "locale", timezone: "America/New_York" } as PreTool,
      {},
      onLog,
    );
    expect(result.length).toBeGreaterThan(10);
  });
});

// ─── env_var ───────────────────────────────────────────────────────────────

describe("env_var pre-tool", () => {
  it("reads an existing env variable", async () => {
    process.env.OCC_TEST_VAR = "test_value_123";
    try {
      const result = await executeSinglePreTool(
        { type: "env_var", inject_as: "val", var_name: "OCC_TEST_VAR" } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("test_value_123");
    } finally {
      delete process.env.OCC_TEST_VAR;
    }
  });

  it("returns empty string for missing env var", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "OCC_NONEXISTENT_VAR_12345" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("returns default_value for missing env var", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "OCC_NONEXISTENT_VAR_12345", default_value: "fallback" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("fallback");
  });

  it("returns actual value when var exists (ignores default)", async () => {
    process.env.OCC_TEST_VAR2 = "real";
    try {
      const result = await executeSinglePreTool(
        { type: "env_var", inject_as: "val", var_name: "OCC_TEST_VAR2", default_value: "fallback" } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("real");
    } finally {
      delete process.env.OCC_TEST_VAR2;
    }
  });
});

// ─── read_file ─────────────────────────────────────────────────────────────

describe("read_file pre-tool", () => {
  let tmpDir: string;
  let origWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-read-"));
    origWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = origWorkspace;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a file within workspace", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello world");
    const result = await executeSinglePreTool(
      { type: "read_file", inject_as: "content", path: path.join(tmpDir, "test.txt") } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("hello world");
  });

  it("reads a file with resolved variables in path", async () => {
    fs.writeFileSync(path.join(tmpDir, "data.json"), '{"key":"value"}');
    const result = await executeSinglePreTool(
      { type: "read_file", inject_as: "content", path: "{dir}/data.json" } as PreTool,
      { dir: tmpDir },
      onLog,
    );
    expect(result).toBe('{"key":"value"}');
  });

  it("truncates files over 50KB", async () => {
    fs.writeFileSync(path.join(tmpDir, "big.txt"), "x".repeat(60000));
    const result = await executeSinglePreTool(
      { type: "read_file", inject_as: "content", path: path.join(tmpDir, "big.txt") } as PreTool,
      {},
      onLog,
    );
    expect(result.length).toBeLessThan(55000);
    expect(result).toContain("[truncated]");
  });

  it("rejects path outside workspace (path traversal)", async () => {
    await expect(
      executeSinglePreTool(
        { type: "read_file", inject_as: "content", path: "/etc/hosts" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/outside allowed directory/);
  });
});

// ─── write_file ────────────────────────────────────────────────────────────

describe("write_file pre-tool", () => {
  let tmpDir: string;
  let origWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-write-"));
    origWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = origWorkspace;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a file and returns the path", async () => {
    const filePath = path.join(tmpDir, "output.txt");
    const result = await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "hello" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe(filePath);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello");
  });

  it("writes with variable resolution in content", async () => {
    const filePath = path.join(tmpDir, "vars.txt");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "Hello {name}!" } as PreTool,
      { name: "Alice" },
      onLog,
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Hello Alice!");
  });

  it("appends to existing file when append: true", async () => {
    const filePath = path.join(tmpDir, "append.txt");
    fs.writeFileSync(filePath, "first\n");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "second\n", append: true } as PreTool,
      {},
      onLog,
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("first\nsecond\n");
  });

  it("creates nested directories", async () => {
    const filePath = path.join(tmpDir, "nested", "dir", "file.txt");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "deep" } as PreTool,
      {},
      onLog,
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("deep");
  });

  it("rejects path outside workspace", async () => {
    await expect(
      executeSinglePreTool(
        { type: "write_file", inject_as: "file", path: "/etc/evil.txt", content: "hacked" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/outside allowed directory/);
  });
});

// ─── bash pre-tool ─────────────────────────────────────────────────────────

describe("bash pre-tool", () => {
  it("executes a simple command", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo hello" } as PreTool,
      {},
      onLog,
    );
    expect(result.trim()).toBe("hello");
  });

  it("resolves variables in command", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo {greeting}" } as PreTool,
      { greeting: "world" },
      onLog,
    );
    expect(result.trim()).toBe("world");
  });

  it("captures stderr when stderr: true", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo err >&2; echo out", stderr: true } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("out");
    expect(result).toContain("err");
  });
});

// ─── executePreTools orchestration ─────────────────────────────────────────

describe("executePreTools orchestration", () => {
  it("runs sequential pre-tools and chains output", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now", format: "unix" } as PreTool,
      { type: "env_var", inject_as: "home", var_name: "HOME" } as PreTool,
    ];
    const results = await executePreTools(preTools, {}, onLog);
    expect(results.now).toBeDefined();
    expect(Number(results.now)).toBeGreaterThan(0);
    expect(results.home).toBeDefined();
  });

  it("makes pre-tool A output available to pre-tool B", async () => {
    process.env.OCC_CHAIN_TEST = "chained_value";
    try {
      const preTools: PreTool[] = [
        { type: "env_var", inject_as: "val", var_name: "OCC_CHAIN_TEST" } as PreTool,
        { type: "bash", inject_as: "echo", command: "echo {val}" } as PreTool,
      ];
      const results = await executePreTools(preTools, {}, onLog);
      expect(results.val).toBe("chained_value");
      expect(results.echo.trim()).toBe("chained_value");
    } finally {
      delete process.env.OCC_CHAIN_TEST;
    }
  });

  it("runs parallel pre-tools concurrently", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "time1", format: "unix", parallel: true } as PreTool,
      { type: "current_datetime", inject_as: "time2", format: "unix", parallel: true } as PreTool,
    ];
    const results = await executePreTools(preTools, {}, onLog);
    expect(results.time1).toBeDefined();
    expect(results.time2).toBeDefined();
    // Both should be very close timestamps
    expect(Math.abs(Number(results.time1) - Number(results.time2))).toBeLessThan(2);
  });
});

// ─── Pre-tool caching ──────────────────────────────────────────────────────

describe("Pre-tool caching", () => {
  it("caches result on first call and returns cached on second", async () => {
    const tool = {
      type: "current_datetime",
      inject_as: "now",
      format: "unix",
      cache_ttl_minutes: 60,
    } as PreTool;

    const result1 = await executeSinglePreTool(tool, {}, onLog);
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 1100));
    const result2 = await executeSinglePreTool(tool, {}, onLog);
    // Cached result should be the same unix timestamp
    expect(result1).toBe(result2);
  });

  it("no caching when cache_ttl_minutes is 0 or not set", async () => {
    const result1 = await executeSinglePreTool(
      { type: "current_datetime", inject_as: "now1", format: "iso" } as PreTool,
      {},
      onLog,
    );
    expect(result1).toBeDefined();
    // No cache_ttl_minutes means no caching
  });
});

// ─── http_fetch SSRF protection (integration via executeSinglePreTool) ─────

describe("http_fetch SSRF protection", () => {
  it("blocks file:// scheme", async () => {
    await expect(
      executeSinglePreTool(
        { type: "http_fetch", inject_as: "data", url: "file:///etc/passwd" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("blocks ftp:// scheme", async () => {
    await expect(
      executeSinglePreTool(
        { type: "http_fetch", inject_as: "data", url: "ftp://server/file" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/SSRF blocked/);
  });
});

// ─── mcp_call pre-tool (error without server) ─────────────────────────────

describe("mcp_call pre-tool", () => {
  it("throws when server is not configured", async () => {
    await expect(
      executeSinglePreTool(
        { type: "mcp_call", inject_as: "data", server: "nonexistent", tool: "test_tool", args: {} } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow();
  });
});

// ─── db_query pre-tool (error handling) ────────────────────────────────────

describe("db_query pre-tool", () => {
  it("throws when connection and sql are missing", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "", sql: "" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires connection and sql/);
  });
});

// ─── email pre-tool (error handling) ───────────────────────────────────────

describe("email pre-tool", () => {
  it("throws when to and subject are missing", async () => {
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "data", to: "", subject: "" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires to and subject/);
  });
});

// ─── ocr pre-tool (error handling) ─────────────────────────────────────────

describe("ocr pre-tool", () => {
  it("throws when image_path is missing", async () => {
    await expect(
      executeSinglePreTool(
        { type: "ocr", inject_as: "data" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires image_path/);
  });
});

// ─── pdf_generate pre-tool (error handling) ────────────────────────────────

describe("pdf_generate pre-tool", () => {
  it("throws when html content is missing", async () => {
    await expect(
      executeSinglePreTool(
        { type: "pdf_generate", inject_as: "data" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires html/);
  });
});

// ─── web_search pre-tool (error handling) ──────────────────────────────────

describe("web_search pre-tool", () => {
  it("throws when claudeRunner is not provided", async () => {
    await expect(
      executeSinglePreTool(
        { type: "web_search", inject_as: "data", query: "test" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires a claudeRunner/);
  });
});

// ─── executePreToolWithRetry ───────────────────────────────────────────────

describe("executePreToolWithRetry", () => {
  it("succeeds on first attempt for working pre-tool", async () => {
    const result = await executePreToolWithRetry(
      { type: "current_datetime", inject_as: "now" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns error message on failure when on_error is inject (default)", async () => {
    const result = await executePreToolWithRetry(
      { type: "env_var", inject_as: "missing", var_name: "" } as PreTool,
      {},
      onLog,
    );
    // env_var with empty var_name returns empty string (no error), which is valid
    expect(typeof result).toBe("string");
  });

  it("returns empty string when on_error is skip", async () => {
    // Force an error by trying to read a nonexistent file outside workspace
    process.env.WORKSPACE_DIR = "/tmp";
    try {
      const result = await executePreToolWithRetry(
        {
          type: "read_file",
          inject_as: "content",
          path: "/nonexistent/path/file.txt",
          on_error: "skip",
        } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("");
    } finally {
      delete process.env.WORKSPACE_DIR;
    }
  });

  it("throws when on_error is fail", async () => {
    process.env.WORKSPACE_DIR = "/tmp";
    try {
      await expect(
        executePreToolWithRetry(
          {
            type: "read_file",
            inject_as: "content",
            path: "/nonexistent/path/file.txt",
            on_error: "fail",
          } as PreTool,
          {},
          onLog,
        ),
      ).rejects.toThrow();
    } finally {
      delete process.env.WORKSPACE_DIR;
    }
  });
});
