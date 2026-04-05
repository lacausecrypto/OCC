/**
 * Tests for core claude-runner.ts logic: binary validation, concurrent execution
 * tracking, runStepWithRetry (with mocked runClaude/providers), and applyContextStrategy.
 *
 * Does NOT spawn real Claude CLI processes — all external calls are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChainStep } from "../src/types.js";
import type { ClaudeResult } from "../src/claude-runner.js";

// ─── Module-level mocks ─────────────────────────────────────────────────────

// Mock child_process so validateClaudeBinary and runClaude can be tested
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
    spawn: vi.fn(actual.spawn),
  };
});

// Mock providers so runStepWithRetry routing can be tested without network
vi.mock("../src/providers.js", () => ({
  resolveProvider: vi.fn(() => null),
  runLLMHTTP: vi.fn(),
  loadProviders: vi.fn(),
}));

import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { resolveProvider, runLLMHTTP } from "../src/providers.js";
import {
  validateClaudeBinary,
  getRunningExecutionCount,
  canStartExecution,
  incrementRunningCount,
  decrementRunningCount,
  MAX_CONCURRENT_EXECUTIONS,
  runStepWithRetry,
  applyContextStrategy,
  runClaude,
} from "../src/claude-runner.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<ChainStep> = {}): ChainStep {
  return {
    id: "test-step",
    prompt: "do something",
    output_var: "result",
    tools: [],
    ...overrides,
  } as ChainStep;
}

const noopChunk = () => {};
const noopLog = vi.fn() as ReturnType<typeof vi.fn> & ((msg: string, level: "info" | "warn" | "error") => void);

// ─── validateClaudeBinary ───────────────────────────────────────────────────

describe("validateClaudeBinary (mocked)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const mockExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    mockExecFileSync.mockReset();
  });

  it("logs success when binary is found via 'which'", () => {
    // First call: which claude -> success, second call: claude --version
    mockExecFileSync
      .mockReturnValueOnce("/usr/local/bin/claude" as any)
      .mockReturnValueOnce("claude 1.2.3\n" as any);

    validateClaudeBinary();

    const messages = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => m.includes("Claude binary verified"))).toBe(true);
  });

  it("logs warning when binary is not found", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    validateClaudeBinary();

    const messages = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => m.includes("WARNING") && m.includes("not found"))).toBe(true);
  });

  it("does not throw even when binary check fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() => validateClaudeBinary()).not.toThrow();
  });

  it("respects CLAUDE_CLI env var with absolute path", () => {
    const originalEnv = process.env.CLAUDE_CLI;
    process.env.CLAUDE_CLI = "/usr/local/bin/my-custom-claude";
    mockExecFileSync
      .mockReturnValueOnce("found" as any)
      .mockReturnValueOnce("custom 1.0\n" as any);

    validateClaudeBinary();

    const whichCall = mockExecFileSync.mock.calls[0];
    expect(whichCall[1]).toContain("/usr/local/bin/my-custom-claude");

    if (originalEnv === undefined) delete process.env.CLAUDE_CLI;
    else process.env.CLAUDE_CLI = originalEnv;
  });

  it("rejects relative CLAUDE_CLI paths (security: only absolute or 'claude')", () => {
    const originalEnv = process.env.CLAUDE_CLI;
    process.env.CLAUDE_CLI = "my-custom-claude";
    mockExecFileSync
      .mockReturnValueOnce("found" as any)
      .mockReturnValueOnce("claude 1.0\n" as any);

    validateClaudeBinary();

    // Should fallback to "claude" since relative path is rejected
    const whichCall = mockExecFileSync.mock.calls[0];
    expect(whichCall[1]).toContain("claude");

    if (originalEnv === undefined) delete process.env.CLAUDE_CLI;
    else process.env.CLAUDE_CLI = originalEnv;
  });

  it("respects CLAUDE_BIN env var with absolute path", () => {
    const origCLI = process.env.CLAUDE_CLI;
    const origBIN = process.env.CLAUDE_BIN;
    delete process.env.CLAUDE_CLI;
    process.env.CLAUDE_BIN = "/opt/bin/claude-bin-custom";

    mockExecFileSync
      .mockReturnValueOnce("found" as any)
      .mockReturnValueOnce("custom-bin 2.0\n" as any);

    validateClaudeBinary();

    const whichCall = mockExecFileSync.mock.calls[0];
    expect(whichCall[1]).toContain("/opt/bin/claude-bin-custom");

    if (origCLI === undefined) delete process.env.CLAUDE_CLI;
    else process.env.CLAUDE_CLI = origCLI;
    if (origBIN === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origBIN;
  });
});

// ─── Concurrent execution tracking ──────────────────────────────────────────

describe("Concurrent execution tracking (core)", () => {
  beforeEach(() => {
    while (getRunningExecutionCount() > 0) decrementRunningCount();
  });
  afterEach(() => {
    while (getRunningExecutionCount() > 0) decrementRunningCount();
  });

  it("MAX_CONCURRENT_EXECUTIONS defaults to 5", () => {
    if (!process.env.MAX_CONCURRENT_EXECUTIONS) {
      expect(MAX_CONCURRENT_EXECUTIONS).toBe(5);
    }
  });

  it("increment and decrement are symmetric", () => {
    for (let i = 0; i < 10; i++) incrementRunningCount();
    for (let i = 0; i < 10; i++) decrementRunningCount();
    expect(getRunningExecutionCount()).toBe(0);
  });

  it("decrement never goes below 0", () => {
    decrementRunningCount();
    decrementRunningCount();
    expect(getRunningExecutionCount()).toBe(0);
  });

  it("canStartExecution is true at 0", () => {
    expect(canStartExecution()).toBe(true);
  });

  it("canStartExecution is false at limit", () => {
    for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS; i++) incrementRunningCount();
    expect(canStartExecution()).toBe(false);
  });

  it("canStartExecution is true at limit-1", () => {
    for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS - 1; i++) incrementRunningCount();
    expect(canStartExecution()).toBe(true);
  });

  it("simulates parallel increment/decrement correctly", () => {
    // Simulate 3 concurrent executions starting
    incrementRunningCount();
    incrementRunningCount();
    incrementRunningCount();
    expect(getRunningExecutionCount()).toBe(3);

    // One finishes
    decrementRunningCount();
    expect(getRunningExecutionCount()).toBe(2);
    expect(canStartExecution()).toBe(true);

    // Two more finish
    decrementRunningCount();
    decrementRunningCount();
    expect(getRunningExecutionCount()).toBe(0);
  });

  it("handles rapid increment past the limit", () => {
    for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS + 5; i++) incrementRunningCount();
    expect(getRunningExecutionCount()).toBe(MAX_CONCURRENT_EXECUTIONS + 5);
    expect(canStartExecution()).toBe(false);

    // Bring back under limit
    for (let i = 0; i < 6; i++) decrementRunningCount();
    expect(canStartExecution()).toBe(true);
  });
});

// ─── runStepWithRetry ───────────────────────────────────────────────────────

describe("runStepWithRetry", () => {
  const mockResolveProvider = vi.mocked(resolveProvider);
  const mockRunLLMHTTP = vi.mocked(runLLMHTTP);
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noopLog.mockClear();
    mockResolveProvider.mockReset();
    mockRunLLMHTTP.mockReset();
    // Default: resolve to claude provider (uses runClaude path)
    mockResolveProvider.mockReturnValue({
      provider: { id: "claude", name: "Claude", type: "claude", apiKey: "", baseUrl: "", enabled: true, createdAt: "" },
      model: "claude-sonnet-4-6",
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // For these tests we need to mock runClaude itself. Since it's in the same module,
  // we use vi.spyOn on the module namespace. We import * as claudeRunner to spy.
  // However, runStepWithRetry calls runClaude directly (same module). We work around
  // this by testing the provider routing path (non-claude providers via runLLMHTTP).

  describe("provider routing to runLLMHTTP", () => {
    beforeEach(() => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter",
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "openai/gpt-4o",
      });
    });

    it("routes to runLLMHTTP for non-claude provider", async () => {
      mockRunLLMHTTP.mockResolvedValue({
        text: "GPT response",
        inputTokens: 50,
        outputTokens: 100,
        durationMs: 500,
        model: "openai/gpt-4o",
        provider: "openrouter",
      });

      const step = makeStep({ model: "openai/gpt-4o" });
      const result = await runStepWithRetry(step, "test prompt", noopChunk, "exec-1", noopLog);

      expect(result.stdout).toBe("GPT response");
      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(100);
      expect(mockRunLLMHTTP).toHaveBeenCalledOnce();
    });

    it("passes correct config to runLLMHTTP", async () => {
      mockRunLLMHTTP.mockResolvedValue({
        text: "ok",
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 100,
        model: "openai/gpt-4o",
        provider: "openrouter",
      });

      const step = makeStep({ model: "openai/gpt-4o" });
      await runStepWithRetry(step, "my prompt", noopChunk, "exec-2", noopLog);

      const callArgs = mockRunLLMHTTP.mock.calls[0][0];
      expect(callArgs.provider).toBe("openrouter");
      expect(callArgs.model).toBe("openai/gpt-4o");
      expect(callArgs.prompt).toBe("my prompt");
      expect(callArgs.stream).toBe(true);
    });

    it("logs the provider name", async () => {
      mockRunLLMHTTP.mockResolvedValue({
        text: "done",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 50,
        model: "gpt-4o",
        provider: "openrouter",
      });

      const step = makeStep({ model: "openai/gpt-4o" });
      await runStepWithRetry(step, "prompt", noopChunk, "exec-3", noopLog);

      expect(noopLog).toHaveBeenCalledWith(
        expect.stringContaining("OpenRouter"),
        "info",
      );
    });

    it("retries on failure with non-claude provider", async () => {
      mockRunLLMHTTP
        .mockRejectedValueOnce(new Error("rate limit"))
        .mockResolvedValueOnce({
          text: "retry success",
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 200,
          model: "gpt-4o",
          provider: "openrouter",
        });

      const step = makeStep({
        model: "openai/gpt-4o",
        retry: { max: 3, delay_ms: 10, backoff: 1 },
      });
      const result = await runStepWithRetry(step, "prompt", noopChunk, "exec-4", noopLog);

      expect(result.stdout).toBe("retry success");
      expect(mockRunLLMHTTP).toHaveBeenCalledTimes(2);
    });

    it("throws after all retries exhausted", async () => {
      mockRunLLMHTTP.mockRejectedValue(new Error("persistent failure"));

      const step = makeStep({
        model: "openai/gpt-4o",
        retry: { max: 2, delay_ms: 10, backoff: 1 },
      });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-5", noopLog),
      ).rejects.toThrow("persistent failure");

      expect(mockRunLLMHTTP).toHaveBeenCalledTimes(2);
    });

    it("logs each failed attempt", async () => {
      mockRunLLMHTTP.mockRejectedValue(new Error("fail"));

      const step = makeStep({
        model: "openai/gpt-4o",
        retry: { max: 3, delay_ms: 10, backoff: 1 },
      });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-6", noopLog),
      ).rejects.toThrow();

      const errorCalls = noopLog.mock.calls.filter(c => c[1] === "error");
      expect(errorCalls.length).toBe(3);
    });
  });

  describe("model fallback", () => {
    it("cycles through fallback_models", async () => {
      const modelsUsed: string[] = [];

      mockResolveProvider.mockImplementation((model: string) => ({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model,
      }));

      mockRunLLMHTTP.mockImplementation(async (config) => {
        modelsUsed.push(config.model);
        if (modelsUsed.length < 3) throw new Error("model overloaded");
        return {
          text: "success with fallback",
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 100,
          model: config.model,
          provider: "openrouter",
        };
      });

      const step = makeStep({
        model: "model-a",
        fallback_models: ["model-a", "model-b", "model-c"],
        retry: { max: 1, delay_ms: 10, backoff: 1 },
      });

      const result = await runStepWithRetry(step, "prompt", noopChunk, "exec-7", noopLog);
      expect(result.stdout).toBe("success with fallback");
      expect(modelsUsed).toContain("model-c");
    });

    it("exhausts all models and throws", async () => {
      mockResolveProvider.mockImplementation((model: string) => ({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model,
      }));

      mockRunLLMHTTP.mockRejectedValue(new Error("all models fail"));

      const step = makeStep({
        fallback_models: ["m1", "m2"],
        retry: { max: 1, delay_ms: 10, backoff: 1 },
      });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-8", noopLog),
      ).rejects.toThrow("all models fail");
    });
  });

  describe("exponential backoff", () => {
    it("delay increases between retries", async () => {
      const timestamps: number[] = [];

      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "test-model",
      });

      mockRunLLMHTTP.mockImplementation(async () => {
        timestamps.push(Date.now());
        if (timestamps.length < 3) throw new Error("retry me");
        return {
          text: "ok",
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 10,
          model: "test-model",
          provider: "openrouter",
        };
      });

      const step = makeStep({
        model: "test-model",
        retry: { max: 3, delay_ms: 50, backoff: 2 },
      });

      await runStepWithRetry(step, "prompt", noopChunk, "exec-9", noopLog);

      expect(timestamps.length).toBe(3);
      // Second delay should be longer than first (backoff=2)
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];
      // With backoff=2, delay2 should be roughly 2x delay1
      // Using generous bounds due to jitter (0.5-1.0 random multiplier)
      expect(delay2).toBeGreaterThan(delay1 * 0.8);
    });
  });

  describe("default retry behavior", () => {
    it("does not retry when retry config is absent (max=1)", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "test-model",
      });

      mockRunLLMHTTP.mockRejectedValue(new Error("single failure"));

      const step = makeStep({ model: "test-model" }); // no retry config

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-10", noopLog),
      ).rejects.toThrow("single failure");

      expect(mockRunLLMHTTP).toHaveBeenCalledTimes(1);
    });
  });

  describe("claude provider path", () => {
    it("falls through to runClaude when provider is claude type", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "claude",
          name: "Claude",
          type: "claude",
          apiKey: "",
          baseUrl: "",
          enabled: true,
          createdAt: "",
        },
        model: "claude-sonnet-4-6",
      });

      // runClaude will fail because claude binary isn't available in test,
      // but we verify it does NOT call runLLMHTTP
      const step = makeStep({ model: "claude-sonnet-4-6" });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-11", noopLog),
      ).rejects.toThrow(); // will fail to spawn

      expect(mockRunLLMHTTP).not.toHaveBeenCalled();
    });

    it("falls through to runClaude when resolveProvider returns null", async () => {
      mockResolveProvider.mockReturnValue(null);

      const step = makeStep({ model: "claude-sonnet-4-6" });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-12", noopLog),
      ).rejects.toThrow(); // will fail to spawn

      expect(mockRunLLMHTTP).not.toHaveBeenCalled();
    });
  });

  describe("non-Error exception handling", () => {
    it("wraps non-Error thrown values into Error objects", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "test-model",
      });

      // Throw a string instead of Error
      mockRunLLMHTTP.mockRejectedValue("string error value");

      const step = makeStep({ model: "test-model" });

      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-14", noopLog),
      ).rejects.toThrow("string error value");
    });
  });

  describe("provider without apiKey", () => {
    it("falls through to runClaude when provider has no apiKey", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "", // empty key
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "gpt-4o",
      });

      const step = makeStep({ model: "gpt-4o" });

      // Falls through to runClaude because apiKey is empty
      await expect(
        runStepWithRetry(step, "prompt", noopChunk, "exec-15", noopLog),
      ).rejects.toThrow(); // runClaude fails in test

      expect(mockRunLLMHTTP).not.toHaveBeenCalled();
    });
  });

  describe("step with explicit provider field", () => {
    it("passes provider field to resolveProvider", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "gpt-4o",
      });

      mockRunLLMHTTP.mockResolvedValue({
        text: "ok",
        inputTokens: 5,
        outputTokens: 10,
        durationMs: 50,
        model: "gpt-4o",
        provider: "openrouter",
      });

      const step = makeStep({ model: "gpt-4o" });
      (step as any).provider = "openrouter";
      await runStepWithRetry(step, "prompt", noopChunk, "exec-16", noopLog);

      // resolveProvider should have been called with the provider field
      expect(mockResolveProvider).toHaveBeenCalledWith("gpt-4o", "openrouter");
    });
  });

  describe("retry logging for model fallback", () => {
    it("logs attempt info when switching models", async () => {
      mockResolveProvider.mockImplementation((model: string) => ({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model,
      }));

      let callCount = 0;
      mockRunLLMHTTP.mockImplementation(async () => {
        callCount++;
        if (callCount < 2) throw new Error("overloaded");
        return {
          text: "ok",
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 10,
          model: "model-b",
          provider: "openrouter",
        };
      });

      const step = makeStep({
        model: "model-a",
        fallback_models: ["model-a", "model-b"],
        retry: { max: 1, delay_ms: 10, backoff: 1 },
      });

      await runStepWithRetry(step, "prompt", noopChunk, "exec-17", noopLog);

      // Should have a warn log about switching to model-b
      const warnCalls = noopLog.mock.calls.filter(c => c[1] === "warn");
      expect(warnCalls.length).toBeGreaterThan(0);
    });
  });

  describe("onChunk callback", () => {
    it("passes onChunk to runLLMHTTP", async () => {
      mockResolveProvider.mockReturnValue({
        provider: {
          id: "openrouter",
          name: "OpenRouter",
          type: "openrouter" as const,
          apiKey: "sk-test",
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          createdAt: "",
        },
        model: "gpt-4o",
      });

      mockRunLLMHTTP.mockResolvedValue({
        text: "streamed",
        inputTokens: 5,
        outputTokens: 10,
        durationMs: 50,
        model: "gpt-4o",
        provider: "openrouter",
      });

      const chunks: string[] = [];
      const onChunk = (c: string) => chunks.push(c);

      const step = makeStep({ model: "gpt-4o" });
      await runStepWithRetry(step, "prompt", onChunk, "exec-13", noopLog);

      // Verify the onChunk function was passed through
      const callArgs = mockRunLLMHTTP.mock.calls[0];
      expect(callArgs[1]).toBe(onChunk);
    });
  });
});

// ─── applyContextStrategy ───────────────────────────────────────────────────

describe("applyContextStrategy (extended)", () => {
  const onLog = vi.fn();

  beforeEach(() => {
    onLog.mockClear();
  });

  describe("full strategy", () => {
    it("returns the original value unchanged", async () => {
      const vars = { data: "important data here" };
      const result = await applyContextStrategy(vars, { data: "full" }, onLog);
      expect(result.data).toBe("important data here");
    });

    it("does not call onLog for full strategy", async () => {
      const vars = { data: "some content" };
      await applyContextStrategy(vars, { data: "full" }, onLog);
      expect(onLog).not.toHaveBeenCalled();
    });
  });

  describe("truncate strategy", () => {
    it("truncates to exact limit plus suffix", async () => {
      const longText = "a".repeat(500);
      const result = await applyContextStrategy(
        { text: longText },
        { text: "truncate:100" },
        onLog,
      );
      expect(result.text).toContain("a".repeat(100));
      expect(result.text).toContain("[truncated from 500 chars]");
    });

    it("leaves short text unchanged", async () => {
      const result = await applyContextStrategy(
        { text: "short" },
        { text: "truncate:100" },
        onLog,
      );
      expect(result.text).toBe("short");
    });

    it("handles truncate:0 (everything truncated)", async () => {
      const result = await applyContextStrategy(
        { text: "any content" },
        { text: "truncate:0" },
        onLog,
      );
      expect(result.text).toContain("[truncated");
    });

    it("handles exact boundary (length == limit)", async () => {
      const text = "x".repeat(100);
      const result = await applyContextStrategy(
        { text },
        { text: "truncate:100" },
        onLog,
      );
      // At exactly the limit, no truncation needed
      expect(result.text).toBe(text);
    });

    it("handles length just over limit", async () => {
      const text = "x".repeat(101);
      const result = await applyContextStrategy(
        { text },
        { text: "truncate:100" },
        onLog,
      );
      expect(result.text).toContain("[truncated from 101 chars]");
    });
  });

  describe("empty/missing values", () => {
    it("skips empty string value", async () => {
      const result = await applyContextStrategy(
        { text: "" },
        { text: "truncate:100" },
        onLog,
      );
      expect(result.text).toBe("");
    });

    it("skips missing variable", async () => {
      const result = await applyContextStrategy(
        { other: "value" },
        { missing_var: "truncate:100" },
        onLog,
      );
      expect(result.other).toBe("value");
      expect(result.missing_var).toBeUndefined();
    });
  });

  describe("unknown strategy", () => {
    it("leaves value unchanged for unknown action", async () => {
      const result = await applyContextStrategy(
        { data: "original" },
        { data: "compress_magic" },
        onLog,
      );
      // Unknown strategy is silently skipped, value preserved
      expect(result.data).toBe("original");
    });
  });

  describe("summarize strategy", () => {
    it("calls runClaude with haiku model for summarization (will fail in test)", async () => {
      // In test environment runClaude will fail because claude binary is unavailable.
      // applyContextStrategy catches the error and keeps original value.
      const vars = { text: "A very long document that needs summarizing..." };
      const result = await applyContextStrategy(
        vars,
        { text: "summarize" },
        onLog,
      );

      // Since runClaude fails, original value is preserved
      expect(result.text).toBe(vars.text);

      // A warning should be logged about the failure
      const warnCalls = onLog.mock.calls.filter(c => c[1] === "warn");
      expect(warnCalls.length).toBeGreaterThan(0);
      expect(warnCalls[0][0]).toContain("Failed to summarize text");
    });
  });

  describe("multiple strategies at once", () => {
    it("applies different strategies to different variables", async () => {
      const vars = {
        keep_full: "original content",
        needs_truncation: "x".repeat(5000),
        short_enough: "short",
      };
      const result = await applyContextStrategy(
        vars,
        {
          keep_full: "full",
          needs_truncation: "truncate:1000",
          short_enough: "truncate:2000",
        },
        onLog,
      );

      expect(result.keep_full).toBe("original content");
      expect(result.needs_truncation.length).toBeLessThan(1200);
      expect(result.needs_truncation).toContain("[truncated");
      expect(result.short_enough).toBe("short");
    });
  });

  describe("does not mutate input", () => {
    it("returns a new object, original vars untouched", async () => {
      const vars = { text: "x".repeat(500) };
      const originalText = vars.text;
      const result = await applyContextStrategy(
        vars,
        { text: "truncate:100" },
        onLog,
      );
      expect(vars.text).toBe(originalText); // not mutated
      expect(result).not.toBe(vars); // new object
    });
  });
});

// ─── runClaude with mocked spawn ────────────────────────────────────────────

describe("runClaude (mocked spawn)", () => {
  const mockSpawn = vi.mocked(spawn);
  const mockExecFileSync = vi.mocked(execFileSync);
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  /** Create a fake child process that acts like a ChildProcess */
  function createFakeChild() {
    const child = new EventEmitter() as any;
    child.pid = 12345;
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn(() => true);
    return child;
  }

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Ensure binary is considered validated
    mockExecFileSync
      .mockReturnValueOnce("/usr/local/bin/claude" as any)
      .mockReturnValueOnce("claude 1.0\n" as any);
    validateClaudeBinary();
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    mockSpawn.mockReset();
  });

  it("resolves with result text from stream-json events", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("test prompt", makeStep(), noopChunk);

    // Emit a result event then close
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Hello from Claude",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    child.stdout.push(resultEvent + "\n");
    child.stdout.push(null);
    child.stderr.push(null);

    // Emit close with code 0
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("Hello from Claude");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("collects text from content_block_delta events", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const chunks: string[] = [];
    const resultPromise = runClaude("prompt", makeStep(), (c) => chunks.push(c));

    const delta1 = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello " },
    });
    const delta2 = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "World" },
    });
    child.stdout.push(delta1 + "\n" + delta2 + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("Hello World");
    expect(chunks).toEqual(["Hello ", "World"]);
  });

  it("rejects on non-zero exit with no output", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    child.stdout.push(null);
    child.stderr.push(Buffer.from("some error output"));
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 1), 10);

    await expect(resultPromise).rejects.toThrow("claude exited with code 1");
  });

  it("resolves with output even on non-zero exit if text was produced", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    const delta = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "partial output" },
    });
    child.stdout.push(delta + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 1), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("partial output");
  });

  it("rejects on spawn error", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("error", new Error("ENOENT")), 10);

    await expect(resultPromise).rejects.toThrow("Failed to spawn claude");
  });

  it("adds --model flag when step has model", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep({ model: "claude-opus-4-6" }), noopChunk);

    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("claude-opus-4-6");
  });

  it("adds --allowedTools when step has tools", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const step = makeStep({ tools: ["bash", "read_file"] });
    const resultPromise = runClaude("prompt", step, noopChunk);

    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--allowedTools");
    expect(spawnArgs).toContain("bash");
    expect(spawnArgs).toContain("read_file");
  });

  it("uses stdin for long prompts (>65536 chars)", async () => {
    const child = createFakeChild();
    const stdinWriteSpy = vi.spyOn(child.stdin, "write");
    mockSpawn.mockReturnValue(child as any);

    const longPrompt = "x".repeat(70000);
    const resultPromise = runClaude(longPrompt, makeStep(), noopChunk);

    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;

    expect(stdinWriteSpy).toHaveBeenCalledWith(longPrompt, "utf-8");
  });

  it("handles assistant event with content blocks", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const chunks: string[] = [];
    const resultPromise = runClaude("prompt", makeStep(), (c) => chunks.push(c));

    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "assistant text" }],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });
    child.stdout.push(assistantEvent + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("assistant text");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(25);
    expect(chunks).toContain("assistant text");
  });

  it("handles message_delta event for output tokens", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    const delta = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "text" },
    });
    const msgDelta = JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 42 },
    });
    child.stdout.push(delta + "\n" + msgDelta + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.outputTokens).toBe(42);
  });

  it("handles message event type", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    const msgEvent = JSON.stringify({
      type: "message",
      message: {
        content: [{ type: "text", text: "message text" }],
        usage: { input_tokens: 30, output_tokens: 15 },
      },
    });
    child.stdout.push(msgEvent + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("message text");
    expect(result.inputTokens).toBe(30);
  });

  it("handles non-JSON lines as content (not error patterns)", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const chunks: string[] = [];
    const resultPromise = runClaude("prompt", makeStep(), (c) => chunks.push(c));

    // Push a non-JSON line that is not an error pattern
    child.stdout.push("This is plain text output\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toContain("This is plain text output");
  });

  it("filters error-pattern lines to stderr bucket", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const chunks: string[] = [];
    const resultPromise = runClaude("prompt", makeStep(), (c) => chunks.push(c));

    child.stdout.push("error: something went wrong\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;
    // Error lines should NOT appear in chunks
    expect(chunks.every(c => !c.startsWith("error:"))).toBe(true);
  });

  it("registers and unregisters with processTracker", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const tracker = {
      register: vi.fn(),
      unregister: vi.fn(),
    };

    const resultPromise = runClaude("prompt", makeStep(), noopChunk, "exec-id", undefined, tracker);

    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;

    expect(tracker.register).toHaveBeenCalledWith("exec-id", child);
    expect(tracker.unregister).toHaveBeenCalledWith("exec-id", child);
  });

  it("handles remaining buffer on close with result event", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    // Push a partial line (no trailing newline) that will remain in buffer
    const resultEvent = JSON.stringify({
      type: "result",
      result: "buffered result",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    child.stdout.push(resultEvent); // no newline!
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    const result = await resultPromise;
    expect(result.stdout).toBe("buffered result");
    expect(result.inputTokens).toBe(10);
  });

  it("unknown event type logs to stderr but does not crash", async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = runClaude("prompt", makeStep(), noopChunk);

    const unknownEvent = JSON.stringify({ type: "ping", data: "keepalive" });
    child.stdout.push(unknownEvent + "\n");
    child.stdout.push(null);
    child.stderr.push(null);
    setTimeout(() => child.emit("close", 0), 10);

    await resultPromise;

    const messages = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => m.includes("Unknown Claude event type"))).toBe(true);
  });
});
