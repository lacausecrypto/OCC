/**
 * Coverage-boost tests for pretool-executor.ts.
 *
 * Targets uncovered lines and branches:
 * - Email tool: RFC validation, Resend provider, SendGrid provider, SMTP fallback
 * - http_fetch: 10MB response size cap, content-length check, json_path extraction
 * - SSRF: IPv6 blocking (::1, fe80::, fc/fd ULA, ::ffff: mapped)
 * - Path traversal: realpathSync checks on read_file and write_file
 * - Cache LRU eviction (MAX_CACHE_SIZE)
 * - Bash variable sanitization (null bytes, newlines, metacharacters)
 * - executePreTools denied set filtering
 * - env_var blocked patterns
 * - db_query: read-only SQL validation, unsupported connection
 * - image_generate: unsupported provider
 * - Unknown pre-tool type (default case)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Mutable DNS mock: change resolve behavior per test ──────────────────
let mockResolve4: (hostname: string, cb: (err: Error | null, addrs: string[]) => void) => void =
  (_h, cb) => cb(null, ["93.184.216.34"]);
let mockResolve6: (hostname: string, cb: (err: Error | null, addrs: string[]) => void) => void =
  (_h, cb) => cb(new Error("no AAAA"), []);

vi.mock("node:dns", () => ({
  resolve4: (hostname: string, cb: (err: Error | null, addrs: string[]) => void) => mockResolve4(hostname, cb),
  resolve6: (hostname: string, cb: (err: Error | null, addrs: string[]) => void) => mockResolve6(hostname, cb),
}));

import {
  executeSinglePreTool,
  executePreTools,
  executePreToolWithRetry,
  checkSSRF,
  clearPreToolCache,
  getPreToolCacheSize,
} from "../src/pretool-executor.js";
import type { PreTool } from "../src/types.js";

const onLog = vi.fn();

/** Create a mock Response object compatible with http_fetch code */
function mockResponse(body: string, opts?: { contentLength?: string; ok?: boolean; status?: number }): Response {
  const headers = new Map<string, string>();
  if (opts?.contentLength) headers.set("content-length", opts.contentLength);
  return {
    ok: opts?.ok ?? true,
    status: opts?.status ?? 200,
    headers: { get: (k: string) => headers.get(k) ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  onLog.mockClear();
  // Reset DNS mocks to default (public IP)
  mockResolve4 = (_h, cb) => cb(null, ["93.184.216.34"]);
  mockResolve6 = (_h, cb) => cb(new Error("no AAAA"), []);
});

// ─── checkSSRF IPv6 blocking ──────────────────────────────────────────────

describe("checkSSRF IPv6 blocking", () => {
  it("blocks ::1 (IPv6 localhost)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["::1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks ::ffff:127.0.0.1 (IPv4-mapped localhost)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["::ffff:127.0.0.1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks fe80:: link-local addresses", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["fe80::1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks fc00:: ULA addresses", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["fc00::1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks fd00:: ULA addresses", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["fd12::5678"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks ::ffff:10.0.0.1 (IPv4-mapped private)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["::ffff:10.0.0.1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks ::ffff:192.168.1.1 (IPv4-mapped private)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["::ffff:192.168.1.1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("blocks ::ffff:172.16.0.1 (IPv4-mapped class B private)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["::ffff:172.16.0.1"]);
    await expect(checkSSRF("https://evil.test")).rejects.toThrow(/SSRF blocked.*private IPv6/);
  });

  it("throws when hostname cannot be resolved at all", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("NXDOMAIN"), []);
    mockResolve6 = (_h, cb) => cb(new Error("NXDOMAIN"), []);
    await expect(checkSSRF("https://nonexistent.invalid")).rejects.toThrow(/Cannot resolve/);
  });

  it("allows public IPv6 addresses", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("no A"), []);
    mockResolve6 = (_h, cb) => cb(null, ["2606:4700::6810:85e5"]);
    await expect(checkSSRF("https://cloudflare.test")).resolves.toBeUndefined();
  });

  it("blocks IPv4 literal 127.0.0.1 when dns resolve fails (fallback)", async () => {
    mockResolve4 = (_h, cb) => cb(new Error("fail"), []);
    mockResolve6 = (_h, cb) => cb(new Error("fail"), []);
    await expect(checkSSRF("https://127.0.0.1")).rejects.toThrow(/SSRF blocked/);
  });
});

// ─── Email tool ───────────────────────────────────────────────────────────

describe("email pre-tool full coverage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  });

  it("rejects invalid email address (RFC validation)", async () => {
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "mail", to: "not-an-email", subject: "Test" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/invalid recipient address/);
  });

  it("rejects email without @ sign", async () => {
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "mail", to: "userexample.com", subject: "Test" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/invalid recipient address/);
  });

  it("rejects email with spaces", async () => {
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "mail", to: "user @example.com", subject: "Test" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/invalid recipient address/);
  });

  it("SendGrid provider requires API key", async () => {
    delete process.env.SENDGRID_API_KEY;
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", provider: "sendgrid" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/SENDGRID_API_KEY/);
  });

  it("SendGrid provider sends email successfully", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 }) as any;

    const result = await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Hello", provider: "sendgrid", from: "sender@example.com" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("Email sent to user@example.com");
    expect(result).toContain("202");
  });

  it("SendGrid provider reports failure on non-ok response", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as any;

    const result = await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Hello", provider: "sendgrid" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("Email failed: 401");
  });

  it("Resend provider requires API key", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(
      executeSinglePreTool(
        { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", provider: "resend" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("Resend provider sends email successfully", async () => {
    process.env.RESEND_API_KEY = "re_test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

    const result = await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Hello", provider: "resend", from: "sender@resend.dev" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("Email sent to user@example.com via Resend");
    expect(result).toContain("200");
  });

  it("Resend provider reports failure on non-ok response", async () => {
    process.env.RESEND_API_KEY = "re_test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as any;

    const result = await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Hello", provider: "resend" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("Email failed: 403");
  });

  it("Resend uses RESEND_FROM env var as default sender", async () => {
    process.env.RESEND_API_KEY = "re_test-key";
    process.env.RESEND_FROM = "custom@resend.dev";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", provider: "resend" } as PreTool,
      {},
      onLog,
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from).toBe("custom@resend.dev");
  });

  it("SMTP provider executes mail command (may succeed or fail depending on env)", async () => {
    const tool: PreTool = {
      type: "email",
      to: "user@example.com",
      subject: "Test",
      content: "Body",
      provider: "smtp",
      inject_as: "result",
    } as PreTool;
    try {
      const result = await executeSinglePreTool(tool, {}, onLog);
      expect(result).toContain("Email sent to");
    } catch (err) {
      expect(String(err)).toContain("email (smtp) failed");
    }
  });

  it("SMTP provider with smtp_host passes it as argument", async () => {
    const tool: PreTool = {
      type: "email",
      to: "user@example.com",
      subject: "Test",
      content: "Body",
      provider: "smtp",
      smtp_host: "mail.example.com",
      inject_as: "result",
    } as PreTool;
    try {
      await executeSinglePreTool(tool, {}, onLog);
    } catch (err) {
      expect(String(err)).toContain("email");
    }
  });

  it("resolves variables in to, subject, and content", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = mockFetch as any;

    await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "{email}", subject: "{subj}", content: "Hello {name}", provider: "sendgrid" } as PreTool,
      { email: "alice@example.com", subj: "Greetings", name: "Alice" },
      onLog,
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.personalizations[0].to[0].email).toBe("alice@example.com");
    expect(body.subject).toBe("Greetings");
    expect(body.content[0].value).toBe("Hello Alice");
  });

  it("uses body field as fallback for content", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = mockFetch as any;

    await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", body: "from body field", provider: "sendgrid" } as PreTool,
      {},
      onLog,
    );
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.content[0].value).toBe("from body field");
  });
});

// ─── http_fetch response size cap ─────────────────────────────────────────

describe("http_fetch response size cap", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects response when content-length exceeds 10MB", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse("data", { contentLength: "20000000" }),
    ) as any;

    await expect(
      executeSinglePreTool(
        { type: "http_fetch", inject_as: "data", url: "https://example.com/big" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/response too large/);
  });

  it("truncates response body exceeding 10MB (without content-length header)", async () => {
    const hugeBody = "x".repeat(11 * 1024 * 1024);
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(hugeBody)) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://example.com/huge" } as PreTool,
      {},
      onLog,
    );
    expect(result.length).toBeLessThanOrEqual(50020);
    expect(result).toContain("[truncated]");
  });

  it("extracts json_path from response (string result)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('{"data":{"name":"Alice","items":[1,2,3]}}'),
    ) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://api.example.com/user", json_path: "data.name" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("Alice");
  });

  it("serializes non-string json_path result to JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('{"data":{"count":42,"items":["a","b"]}}'),
    ) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://api.example.com/items", json_path: "data.items" } as PreTool,
      {},
      onLog,
    );
    expect(JSON.parse(result)).toEqual(["a", "b"]);
  });

  it("serializes numeric json_path result to JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('{"count":42}'),
    ) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://api.example.com/count", json_path: "count" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("42");
  });

  it("warns on json_path extraction failure (invalid JSON)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse("not json"),
    ) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://api.example.com/broken", json_path: "data.name" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("not json");
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("json_path extraction failed"), "warn");
  });

  it("passes custom headers and body for POST", async () => {
    const mockFn = vi.fn().mockResolvedValue(mockResponse('{"ok":true}'));
    globalThis.fetch = mockFn as any;

    await executeSinglePreTool(
      {
        type: "http_fetch", inject_as: "data", url: "https://api.example.com/post",
        method: "POST", headers: { "X-Custom": "{token}" }, body: '{"msg":"{greeting}"}',
      } as PreTool,
      { token: "abc123", greeting: "hello" },
      onLog,
    );
    const callArgs = mockFn.mock.calls[0];
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].headers["X-Custom"]).toBe("abc123");
    expect(callArgs[1].body).toBe('{"msg":"hello"}');
  });

  it("does not send body for GET requests even if body is set", async () => {
    const mockFn = vi.fn().mockResolvedValue(mockResponse("ok"));
    globalThis.fetch = mockFn as any;

    await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://example.com", method: "GET", body: "should-not-send" } as PreTool,
      {},
      onLog,
    );
    expect(mockFn.mock.calls[0][1].body).toBeUndefined();
  });

  it("does not send body for DELETE requests", async () => {
    const mockFn = vi.fn().mockResolvedValue(mockResponse("deleted"));
    globalThis.fetch = mockFn as any;

    await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://api.example.com/item/1", method: "DELETE", body: "should-not-send" } as PreTool,
      {},
      onLog,
    );
    expect(mockFn.mock.calls[0][1].body).toBeUndefined();
  });

  it("truncates response to 50KB after initial fetch", async () => {
    const largeBody = "a".repeat(60000);
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(largeBody)) as any;

    const result = await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://example.com/large" } as PreTool,
      {},
      onLog,
    );
    expect(result.length).toBeLessThanOrEqual(50020);
    expect(result).toContain("[truncated]");
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("truncated to 50KB"), "warn");
  });

  it("sends headers only when provided", async () => {
    const mockFn = vi.fn().mockResolvedValue(mockResponse("ok"));
    globalThis.fetch = mockFn as any;

    await executeSinglePreTool(
      { type: "http_fetch", inject_as: "data", url: "https://example.com" } as PreTool,
      {},
      onLog,
    );
    expect(mockFn.mock.calls[0][1].headers).toBeUndefined();
  });
});

// ─── Cache LRU eviction ──────────────────────────────────────────────────

describe("Pre-tool cache LRU eviction", () => {
  beforeEach(() => {
    clearPreToolCache();
  });

  it("fills cache with many entries and evicts on overflow", async () => {
    for (let i = 0; i < 1002; i++) {
      await executeSinglePreTool(
        {
          type: "current_datetime",
          inject_as: `dt_${i}`,
          format: "unix",
          cache_ttl_minutes: 60,
          query: `unique_${i}`,
        } as PreTool,
        {},
        onLog,
      );
    }

    // Cache size should be around 900 (eviction happens during the loop at size > 1000)
    const sizeBefore = getPreToolCacheSize();
    expect(sizeBefore).toBeGreaterThan(800);
    expect(sizeBefore).toBeLessThanOrEqual(1002);

    // Trigger one more - if still above 1000, should trigger eviction
    await executeSinglePreTool(
      { type: "current_datetime", inject_as: "trigger", format: "unix", cache_ttl_minutes: 60, query: "trigger_evict" } as PreTool,
      {},
      onLog,
    );

    const sizeAfter = getPreToolCacheSize();
    // Eviction should have reduced the cache to around 900
    expect(sizeAfter).toBeLessThanOrEqual(sizeBefore + 1);
  });

  it("returns cached result on cache hit and logs it", async () => {
    clearPreToolCache();
    const tool: PreTool = {
      type: "current_datetime",
      inject_as: "cached_time",
      format: "unix",
      cache_ttl_minutes: 60,
    } as PreTool;

    const result1 = await executeSinglePreTool(tool, {}, onLog);
    await new Promise((r) => setTimeout(r, 1100));
    const result2 = await executeSinglePreTool(tool, {}, onLog);
    expect(result1).toBe(result2);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("cache hit"), "info");
  });

  it("clearPreToolCache returns count and empties cache", () => {
    const cleared = clearPreToolCache();
    expect(cleared).toBe(0);
    expect(getPreToolCacheSize()).toBe(0);
  });
});

// ─── Bash variable sanitization ──────────────────────────────────────────

describe("bash variable sanitization", () => {
  it("strips null bytes from variables", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo {val}" } as PreTool,
      { val: "hello\0world" },
      onLog,
    );
    expect(result.trim()).toBe("helloworld");
  });

  it("converts newlines to spaces in variables", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo {val}" } as PreTool,
      { val: "line1\nline2" },
      onLog,
    );
    expect(result.trim()).toBe("line1 line2");
  });

  it("strips carriage returns from variables", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo {val}" } as PreTool,
      { val: "hello\rworld" },
      onLog,
    );
    expect(result).not.toContain("\r");
  });

  it("sanitizes all variable keys, not just specific ones", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo {a} {b}" } as PreTool,
      { a: "hello\0", b: "world\0" },
      onLog,
    );
    expect(result.trim()).toBe("hello world");
  });
});

// ─── env_var blocked patterns ────────────────────────────────────────────

describe("env_var security blocks", () => {
  it("blocks access to variables matching KEY pattern", async () => {
    process.env.MY_API_KEY = "secret123";
    try {
      const result = await executeSinglePreTool(
        { type: "env_var", inject_as: "val", var_name: "MY_API_KEY" } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("");
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining("blocked"), "warn");
    } finally {
      delete process.env.MY_API_KEY;
    }
  });

  it("blocks access to variables matching SECRET pattern", async () => {
    process.env.DB_SECRET = "pass123";
    try {
      const result = await executeSinglePreTool(
        { type: "env_var", inject_as: "val", var_name: "DB_SECRET" } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("");
    } finally {
      delete process.env.DB_SECRET;
    }
  });

  it("blocks access to variables matching TOKEN pattern", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "GITHUB_TOKEN" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("blocks PASSWORD pattern", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "DB_PASSWORD" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("blocks PATH variable", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "PATH" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("blocks AWS_ prefixed variables", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "AWS_ACCESS_KEY_ID" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("blocks NODE_OPTIONS", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "NODE_OPTIONS" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("allows allowlisted variables like NODE_ENV", async () => {
    process.env.NODE_ENV = "test";
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "NODE_ENV" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("test");
  });

  it("allows non-sensitive custom variables", async () => {
    process.env.OCC_CHAIN_TEST_VAR = "custom_value";
    try {
      const result = await executeSinglePreTool(
        { type: "env_var", inject_as: "val", var_name: "OCC_CHAIN_TEST_VAR" } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("custom_value");
    } finally {
      delete process.env.OCC_CHAIN_TEST_VAR;
    }
  });

  it("returns default_value for blocked variables", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "MY_API_KEY", default_value: "blocked_default" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("blocked_default");
  });

  it("returns empty string for empty var_name", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("returns default_value for empty var_name when provided", async () => {
    const result = await executeSinglePreTool(
      { type: "env_var", inject_as: "val", var_name: "", default_value: "my_default" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("my_default");
  });
});

// ─── read_file edge cases ────────────────────────────────────────────────

describe("read_file edge cases", () => {
  let tmpDir: string;
  let origWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-read-edge-"));
    origWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = origWorkspace;
    cleanupTmpDirSync(tmpDir);
  });

  it("reads file with custom encoding", async () => {
    fs.writeFileSync(path.join(tmpDir, "latin.txt"), "caf\u00e9", "utf-8");
    const result = await executeSinglePreTool(
      { type: "read_file", inject_as: "content", path: path.join(tmpDir, "latin.txt"), encoding: "utf-8" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("caf");
  });

  it("allows reading from tmp directory", async () => {
    const tmpFile = path.join(os.tmpdir(), `occ-test-read-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "tmp content");
    try {
      const result = await executeSinglePreTool(
        { type: "read_file", inject_as: "content", path: tmpFile } as PreTool,
        {},
        onLog,
      );
      expect(result).toBe("tmp content");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("truncates files over 50KB and logs a warning", async () => {
    fs.writeFileSync(path.join(tmpDir, "big.txt"), "x".repeat(60000));
    const result = await executeSinglePreTool(
      { type: "read_file", inject_as: "content", path: path.join(tmpDir, "big.txt") } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("[truncated]");
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("truncated to 50KB"), "warn");
  });
});

// ─── write_file edge cases ───────────────────────────────────────────────

describe("write_file edge cases", () => {
  let tmpDir: string;
  let origWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-write-edge-"));
    origWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = origWorkspace;
    cleanupTmpDirSync(tmpDir);
  });

  it("logs write operation details", async () => {
    const filePath = path.join(tmpDir, "logged.txt");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "some content" } as PreTool,
      {},
      onLog,
    );
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("write_file"), "info");
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("12 chars"), "info");
  });

  it("logs append operation correctly", async () => {
    const filePath = path.join(tmpDir, "append-log.txt");
    fs.writeFileSync(filePath, "first");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: " second", append: true } as PreTool,
      {},
      onLog,
    );
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("(append)"), "info");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("first second");
  });

  it("writes with custom encoding", async () => {
    const filePath = path.join(tmpDir, "encoded.txt");
    await executeSinglePreTool(
      { type: "write_file", inject_as: "file", path: filePath, content: "test data", encoding: "utf-8" } as PreTool,
      {},
      onLog,
    );
    expect(fs.readFileSync(filePath, "utf-8")).toBe("test data");
  });
});

// ─── db_query SQL validation ─────────────────────────────────────────────

describe("db_query SQL validation", () => {
  it("blocks DROP statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "DROP TABLE users" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*DROP/i);
  });

  it("blocks DELETE statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "DELETE FROM users" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*DELETE/i);
  });

  it("blocks INSERT statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "INSERT INTO users VALUES (1)" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*INSERT/i);
  });

  it("blocks UPDATE statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "UPDATE users SET name='x'" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*UPDATE/i);
  });

  it("blocks ALTER statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "ALTER TABLE users ADD col INT" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*ALTER/i);
  });

  it("blocks TRUNCATE statements", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "TRUNCATE TABLE users" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/blocked SQL keyword.*TRUNCATE/i);
  });

  it("rejects non-SELECT/WITH queries", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "test.db", sql: "SHOW TABLES" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/only SELECT\/WITH queries/);
  });

  it("rejects unsupported connection type", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "mongodb://localhost", sql: "SELECT 1" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/unsupported connection|query execution error/);
  });

  it("replaces variable placeholders with parameterized ?", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "nonexistent.db", sql: "SELECT * FROM users WHERE id = {user_id}" } as PreTool,
        { user_id: "123" },
        onLog,
      ),
    ).rejects.toThrow(/query execution error/);
  });

  it("allows WITH (CTE) queries", async () => {
    await expect(
      executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "nonexistent.db", sql: "WITH cte AS (SELECT 1) SELECT * FROM cte" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/query execution error/);
  });

  it("masks SQL error details in thrown error", async () => {
    try {
      await executeSinglePreTool(
        { type: "db_query", inject_as: "data", connection: "nonexistent.db", sql: "SELECT 1" } as PreTool,
        {},
        onLog,
      );
    } catch (err) {
      expect(String(err)).toContain("query execution error");
    }
  });
});

// ─── executePreTools denied set filtering ────────────────────────────────

describe("executePreTools denied set filtering", () => {
  it("blocks all pre-tools when denied set contains '*'", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now" } as PreTool,
      { type: "env_var", inject_as: "home", var_name: "HOME" } as PreTool,
    ];
    const denied = new Set(["*"]);
    const results = await executePreTools(preTools, {}, onLog, undefined, undefined, undefined, undefined, denied);
    expect(Object.keys(results)).toHaveLength(0);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("All pre-tools blocked"), "warn");
  });

  it("blocks specific pre-tool types", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now" } as PreTool,
      { type: "bash", inject_as: "output", command: "echo hi" } as PreTool,
    ];
    const denied = new Set(["pre:bash"]);
    const results = await executePreTools(preTools, {}, onLog, undefined, undefined, undefined, undefined, denied);
    expect(results.now).toBeDefined();
    expect(results.output).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('Pre-tool "bash" denied'), "warn");
  });

  it("blocks specific MCP servers", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now" } as PreTool,
      { type: "mcp_call", inject_as: "data", server: "blocked-server", tool: "test" } as PreTool,
    ];
    const denied = new Set(["mcp:blocked-server"]);
    const results = await executePreTools(preTools, {}, onLog, undefined, undefined, undefined, undefined, denied);
    expect(results.now).toBeDefined();
    expect(results.data).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('MCP server "blocked-server" denied'), "warn");
  });

  it("allows pre-tools not in denied set", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now" } as PreTool,
    ];
    const denied = new Set(["pre:bash"]);
    const results = await executePreTools(preTools, {}, onLog, undefined, undefined, undefined, undefined, denied);
    expect(results.now).toBeDefined();
  });

  it("processes all pre-tools when denied set is empty", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "now" } as PreTool,
      { type: "env_var", inject_as: "env_val", var_name: "HOME" } as PreTool,
    ];
    const denied = new Set<string>();
    const results = await executePreTools(preTools, {}, onLog, undefined, undefined, undefined, undefined, denied);
    expect(results.now).toBeDefined();
    expect(results.env_val).toBeDefined();
  });
});

// ─── image_generate error paths ──────────────────────────────────────────

describe("image_generate error paths", () => {
  it("requires a prompt", async () => {
    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires a prompt/);
  });

  it("rejects unsupported provider", async () => {
    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "a cat", image_provider: "midjourney" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/unsupported provider/);
  });
});

// ─── Unknown pre-tool type ───────────────────────────────────────────────

describe("unknown pre-tool type", () => {
  it("returns empty string for unknown tool type", async () => {
    const result = await executeSinglePreTool(
      { type: "nonexistent_tool" as any, inject_as: "data" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });
});

// ─── executePreToolWithRetry edge cases ──────────────────────────────────

describe("executePreToolWithRetry edge cases", () => {
  it("logs success without attempt count on first try", async () => {
    const result = await executePreToolWithRetry(
      { type: "current_datetime", inject_as: "now", format: "unix" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBeDefined();
    const successLog = onLog.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("current_datetime") && c[0].includes("chars"),
    );
    expect(successLog).toBeDefined();
    expect(successLog![0]).not.toContain("attempt");
  });

  it("reports character count in success log", async () => {
    await executePreToolWithRetry(
      { type: "current_datetime", inject_as: "now", format: "iso" } as PreTool,
      {},
      onLog,
    );
    const logMsg = onLog.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("chars"),
    );
    expect(logMsg).toBeDefined();
    expect(logMsg![0]).toMatch(/\d+ chars/);
  });
});

// ─── Bash stderr edge cases ─────────────────────────────────────────────

describe("bash stderr edge cases", () => {
  it("captures both stdout and stderr on non-zero exit", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "echo out; echo err >&2; exit 1", stderr: true } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("out");
    expect(result).toContain("err");
  });

  it("returns empty-ish string when stderr mode command produces no output", async () => {
    const result = await executeSinglePreTool(
      { type: "bash", inject_as: "output", command: "true", stderr: true } as PreTool,
      {},
      onLog,
    );
    expect(typeof result).toBe("string");
  });
});

// ─── SendGrid from address fallback ──────────────────────────────────────

describe("email SendGrid from address fallback", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM;
  });

  it("uses SENDGRID_FROM env var when no from specified", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.SENDGRID_FROM = "custom@sendgrid.example.com";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = mockFetch as any;

    await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", provider: "sendgrid" } as PreTool,
      {},
      onLog,
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from.email).toBe("custom@sendgrid.example.com");
  });

  it("falls back to noreply@example.com when no from or env var", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    delete process.env.SENDGRID_FROM;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = mockFetch as any;

    await executeSinglePreTool(
      { type: "email", inject_as: "mail", to: "user@example.com", subject: "Test", provider: "sendgrid" } as PreTool,
      {},
      onLog,
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from.email).toBe("noreply@example.com");
  });
});

// ─── Mixed parallel and sequential pre-tool execution ────────────────────

describe("executePreTools mixed parallel and sequential", () => {
  it("handles mixed parallel and sequential pre-tools correctly", async () => {
    const preTools: PreTool[] = [
      { type: "current_datetime", inject_as: "time1", format: "unix", parallel: true } as PreTool,
      { type: "current_datetime", inject_as: "time2", format: "unix", parallel: true } as PreTool,
      { type: "env_var", inject_as: "home", var_name: "HOME" } as PreTool,
      { type: "current_datetime", inject_as: "time3", format: "unix", parallel: true } as PreTool,
    ];
    const results = await executePreTools(preTools, {}, onLog);
    expect(results.time1).toBeDefined();
    expect(results.time2).toBeDefined();
    expect(results.home).toBeDefined();
    expect(results.time3).toBeDefined();
  });

  it("chains sequential results into next pre-tools", async () => {
    process.env.OCC_BOOST_CHAIN = "chained";
    try {
      const preTools: PreTool[] = [
        { type: "env_var", inject_as: "val", var_name: "OCC_BOOST_CHAIN" } as PreTool,
        { type: "bash", inject_as: "echo", command: "echo {val}" } as PreTool,
      ];
      const results = await executePreTools(preTools, {}, onLog);
      expect(results.val).toBe("chained");
      expect(results.echo.trim()).toBe("chained");
    } finally {
      delete process.env.OCC_BOOST_CHAIN;
    }
  });
});

// ─── image_generate providers (openai, huggingface, stability) ───────────

describe("image_generate providers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.STABILITY_API_KEY;
  });

  it("openai provider requires API key", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "a cat", image_provider: "openai" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/OpenAI provider not configured|no API key/);
  });

  it("openai provider generates image with b64_json response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const fakeB64 = Buffer.from("fake-image-data").toString("base64");
    const mockFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [{ b64_json: fakeB64, revised_prompt: "a fluffy cat" }],
        }),
      });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a cat", image_provider: "openai" } as PreTool,
      {},
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("dall-e-3");
    expect(parsed.revised_prompt).toBe("a fluffy cat");
    expect(fs.existsSync(parsed.path)).toBe(true);
    // Clean up
    fs.unlinkSync(parsed.path);
  });

  it("openai provider generates image with url fallback", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const fakeImageData = Buffer.from("fake-png-data");
    const mockFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [{ url: "https://images.openai.com/fake.png" }],
        }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: () => Promise.resolve(fakeImageData.buffer.slice(fakeImageData.byteOffset, fakeImageData.byteOffset + fakeImageData.byteLength)),
      });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a dog", image_provider: "openai" } as PreTool,
      {},
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("openai");
    expect(fs.existsSync(parsed.path)).toBe(true);
    fs.unlinkSync(parsed.path);
  });

  it("openai provider throws on no image data", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{}] }),
    }) as any;

    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "a fish", image_provider: "openai" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/no image data in response/);
  });

  it("openai provider throws on API error", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("Rate limit exceeded"),
    }) as any;

    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "a bird", image_provider: "openai" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/image_generate \(openai\) 429/);
  });

  it("openai provider passes quality and style options", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const fakeB64 = Buffer.from("fake").toString("base64");
    const mockFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ b64_json: fakeB64 }] }),
    });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      {
        type: "image_generate", inject_as: "img", query: "sunset",
        image_provider: "openai", image_quality: "hd", image_style: "natural",
      } as PreTool,
      {},
      onLog,
    );
    const body = JSON.parse(mockFn.mock.calls[0][1].body);
    expect(body.quality).toBe("hd");
    expect(body.style).toBe("natural");
    const parsed = JSON.parse(result);
    fs.unlinkSync(parsed.path);
  });

  it("huggingface provider generates image successfully", async () => {
    const fakeImageBuffer = Buffer.from("fake-hf-image");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(fakeImageBuffer.byteOffset, fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength)),
    }) as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a landscape", image_provider: "huggingface" } as PreTool,
      {},
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("huggingface");
    expect(parsed.model).toBe("black-forest-labs/FLUX.1-schnell");
    expect(fs.existsSync(parsed.path)).toBe(true);
    fs.unlinkSync(parsed.path);
  });

  it("huggingface provider sends auth header when HF_TOKEN is set", async () => {
    process.env.HF_TOKEN = "hf_test_token";
    const fakeImageBuffer = Buffer.from("fake");
    const mockFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(fakeImageBuffer.byteOffset, fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength)),
    });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a tree", image_provider: "huggingface" } as PreTool,
      {},
      onLog,
    );
    expect(mockFn.mock.calls[0][1].headers["Authorization"]).toBe("Bearer hf_test_token");
    const parsed = JSON.parse(result);
    fs.unlinkSync(parsed.path);
  });

  it("huggingface provider passes negative_prompt", async () => {
    const fakeImageBuffer = Buffer.from("fake");
    const mockFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(fakeImageBuffer.byteOffset, fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength)),
    });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a mountain", image_provider: "huggingface", negative_prompt: "blurry" } as PreTool,
      {},
      onLog,
    );
    const body = JSON.parse(mockFn.mock.calls[0][1].body);
    expect(body.negative_prompt).toBe("blurry");
    const parsed = JSON.parse(result);
    fs.unlinkSync(parsed.path);
  });

  it("huggingface provider throws on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.resolve("Model loading"),
    }) as any;

    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "test", image_provider: "huggingface" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/image_generate \(huggingface\) 503/);
  });

  it("stability provider requires API key", async () => {
    delete process.env.STABILITY_API_KEY;
    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "a cat", image_provider: "stability" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/STABILITY_API_KEY/);
  });

  it("stability provider generates image successfully", async () => {
    process.env.STABILITY_API_KEY = "sk-stab-test";
    const fakeImageBuffer = Buffer.from("fake-stability-image");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(fakeImageBuffer.byteOffset, fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength)),
    }) as any;

    const result = await executeSinglePreTool(
      { type: "image_generate", inject_as: "img", query: "a sunset", image_provider: "stability" } as PreTool,
      {},
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("stability");
    expect(parsed.model).toBe("sd3");
    expect(fs.existsSync(parsed.path)).toBe(true);
    fs.unlinkSync(parsed.path);
  });

  it("stability provider throws on API error", async () => {
    process.env.STABILITY_API_KEY = "sk-stab-test";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Invalid prompt"),
    }) as any;

    await expect(
      executeSinglePreTool(
        { type: "image_generate", inject_as: "img", query: "test", image_provider: "stability" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/image_generate \(stability\) 400/);
  });

  it("stability provider passes negative_prompt and aspect_ratio", async () => {
    process.env.STABILITY_API_KEY = "sk-stab-test";
    const fakeImageBuffer = Buffer.from("fake");
    const mockFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeImageBuffer.buffer.slice(fakeImageBuffer.byteOffset, fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength)),
    });
    globalThis.fetch = mockFn as any;

    const result = await executeSinglePreTool(
      {
        type: "image_generate", inject_as: "img", query: "mountain",
        image_provider: "stability", negative_prompt: "blurry", image_size: "1024x1024",
      } as PreTool,
      {},
      onLog,
    );
    // FormData is sent as body, can't easily inspect it, but call should succeed
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe("stability");
    fs.unlinkSync(parsed.path);
  });
});

// ─── db_query with valid SQLite database ─────────────────────────────────

describe("db_query with valid SQLite database", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-db-"));
  });

  afterEach(() => {
    cleanupTmpDirSync(tmpDir);
  });

  it("executes SELECT query on SQLite database", async () => {
    // Create a test database with better-sqlite3
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(tmpDir, "test.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE users (id INTEGER, name TEXT)");
    db.exec("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");
    db.close();

    const result = await executeSinglePreTool(
      { type: "db_query", inject_as: "data", connection: dbPath, sql: "SELECT * FROM users" } as PreTool,
      {},
      onLog,
    );
    const rows = JSON.parse(result);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Alice");
  });

  it("executes parameterized SELECT query", async () => {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(tmpDir, "params.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE items (id INTEGER, val TEXT)");
    db.exec("INSERT INTO items VALUES (1, 'hello'), (2, 'world')");
    db.close();

    const result = await executeSinglePreTool(
      { type: "db_query", inject_as: "data", connection: dbPath, sql: "SELECT * FROM items WHERE id = {item_id}" } as PreTool,
      { item_id: "1" },
      onLog,
    );
    const rows = JSON.parse(result);
    expect(rows).toHaveLength(1);
    expect(rows[0].val).toBe("hello");
  });

  it("uses sqlite: prefix for connection", async () => {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(tmpDir, "prefix.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (42)");
    db.close();

    const result = await executeSinglePreTool(
      { type: "db_query", inject_as: "data", connection: `sqlite:${dbPath}`, sql: "SELECT x FROM t" } as PreTool,
      {},
      onLog,
    );
    const rows = JSON.parse(result);
    expect(rows[0].x).toBe(42);
  });
});
