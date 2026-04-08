/**
 * Additional coverage tests for providers.ts
 *
 * Targets uncovered lines: filterToolsByPermissions, mapToolsToOAI dedup,
 * getModelDeniedSet, testProvider (Ollama, error paths), getAllModels (disabled skip),
 * encryptKey/decryptKey round-trip, streamOpenAIResponse SSE parsing,
 * runOpenAICompat agent loop with tool_calls, OpenRouter streaming path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let configPath: string;
let originalEnv: Record<string, string | undefined>;

type ProvidersModule = typeof import("../src/providers.js");
let mod: ProvidersModule;

async function loadModule(): Promise<ProvidersModule> {
  vi.resetModules();
  return await import("../src/providers.js");
}

function makeProvider(overrides: Partial<import("../src/providers.js").LLMProvider> = {}) {
  return {
    id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Provider",
    type: "openai" as const,
    apiKey: "sk-test-key-abcdef1234567890",
    baseUrl: "https://api.openai.com/v1",
    enabled: true,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-providers-boost-"));
  configPath = path.join(tmpDir, "providers.json");

  originalEnv = {
    LLM_PROVIDERS_CONFIG: process.env.LLM_PROVIDERS_CONFIG,
    OCC_ENCRYPTION_KEY: process.env.OCC_ENCRYPTION_KEY,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.LLM_PROVIDERS_CONFIG = configPath;
  process.env.OCC_ENCRYPTION_KEY = "test-encryption-key-boost-1234";
  delete process.env.NODE_ENV; // avoid production guard

  mod = await loadModule();
});

afterEach(() => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
  cleanupTmpDirSync(tmpDir);
  vi.restoreAllMocks();
});

// ─── encryptKey / decryptKey round-trip (via create + getProviderFull) ──────

describe("encryptKey / decryptKey edge cases", () => {
  it("empty string passthrough", () => {
    const p = mod.createProvider(makeProvider({ id: "empty-key", apiKey: "" }));
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const saved = raw.find((r: any) => r.id === "empty-key");
    expect(saved.apiKey).toBe("");
  });

  it("round-trips unicode API key", async () => {
    mod.createProvider(makeProvider({ id: "unicode-key", apiKey: "sk-ünïcödé-🔑-key" }));
    mod = await loadModule();
    const loaded = mod.getProviderFull("unicode-key");
    expect(loaded).toBeDefined();
    expect(loaded!.apiKey).toBe("sk-ünïcödé-🔑-key");
  });

  it("round-trips very long API key", async () => {
    const longKey = "sk-" + "a".repeat(500);
    mod.createProvider(makeProvider({ id: "long-key", apiKey: longKey }));
    mod = await loadModule();
    expect(mod.getProviderFull("long-key")!.apiKey).toBe(longKey);
  });
});

// ─── getModelDeniedSet ─────────────────────────────────────────────────────

describe("getModelDeniedSet", () => {
  it("returns empty set when provider has no toolPermissions", () => {
    mod.createProvider(makeProvider({ id: "no-perms", models: ["test-model"] }));
    const denied = mod.getModelDeniedSet("test-model");
    // Will resolve via model list search to "no-perms" provider
    expect(denied).toBeDefined();
    expect(denied.size).toBe(0);
  });

  it("returns deniedTools from provider-level toolPermissions", () => {
    mod.createProvider(makeProvider({
      id: "with-denied",
      models: ["my-model"],
      toolPermissions: { deniedTools: ["bash", "write_file"] },
    }));
    const denied = mod.getModelDeniedSet("my-model");
    expect(denied.has("bash")).toBe(true);
    expect(denied.has("write_file")).toBe(true);
    expect(denied.size).toBe(2);
  });

  it("merges per-model overrides on top of provider defaults", () => {
    mod.createProvider(makeProvider({
      id: "per-model",
      models: ["gpt-x"],
      toolPermissions: { deniedTools: ["bash"] },
      perModelPermissions: { "gpt-x": { deniedTools: ["bash", "web_search", "mcp:sports-hub"] } },
    }));
    const denied = mod.getModelDeniedSet("gpt-x");
    expect(denied.has("bash")).toBe(true);
    expect(denied.has("web_search")).toBe(true);
    expect(denied.has("mcp:sports-hub")).toBe(true);
  });

  it("returns wildcard set when toolsEnabled=false on per-model override", () => {
    mod.createProvider(makeProvider({
      id: "disabled-model",
      models: ["gpt-no-tools"],
      toolPermissions: { deniedTools: ["bash"] },
      perModelPermissions: { "gpt-no-tools": { toolsEnabled: false } },
    }));
    const denied = mod.getModelDeniedSet("gpt-no-tools");
    expect(denied.has("*")).toBe(true);
  });

  it("returns wildcard when provider-level toolsEnabled is false", () => {
    mod.createProvider(makeProvider({
      id: "all-disabled",
      models: ["model-z"],
      toolPermissions: { toolsEnabled: false },
    }));
    const denied = mod.getModelDeniedSet("model-z");
    expect(denied.has("*")).toBe(true);
  });

  it("returns empty set for unknown model (no resolved provider)", () => {
    // Disable claude so resolveProvider returns null
    mod.updateProvider("claude", { enabled: false });
    const denied = mod.getModelDeniedSet("completely-unknown-xyz-model");
    expect(denied.size).toBe(0);
  });
});

// ─── testProvider — Ollama model discovery ─────────────────────────────────

describe("testProvider — Ollama", () => {
  beforeEach(() => {
    mod.createProvider(makeProvider({
      id: "test-ollama",
      name: "Local Ollama",
      type: "ollama",
      apiKey: "",
      baseUrl: "http://localhost:11434",
      models: [],
    }));
  });

  it("discovers models from Ollama /api/tags endpoint", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        models: [
          { name: "llama3:latest" },
          { name: "codellama:7b" },
          { name: "mistral:latest" },
        ],
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("test-ollama");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["llama3:latest", "codellama:7b", "mistral:latest"]);

    // Check that provider's models were auto-updated
    const prov = mod.getProvider("test-ollama");
    expect(prov!.models).toEqual(["llama3:latest", "codellama:7b", "mistral:latest"]);
  });

  it("handles empty model list from Ollama", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ models: [] }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("test-ollama");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });

  it("handles Ollama connection failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await mod.testProvider("test-ollama");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cannot connect to Ollama");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("handles Ollama HTTP error", async () => {
    const mockResponse = { ok: false, status: 500, statusText: "Internal Server Error" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("test-ollama");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Ollama 500");
  });

  it("handles missing models field in Ollama response", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({}), // no models field
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("test-ollama");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });
});

// ─── testProvider — OpenAI-compat model listing ────────────────────────────

describe("testProvider — OpenAI-compat error paths", () => {
  it("handles API error from models endpoint", async () => {
    mod.createProvider(makeProvider({ id: "err-prov", apiKey: "sk-key" }));
    const mockResponse = {
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("err-prov");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("API 401");
  });

  it("handles fetch exception for OpenAI-compat providers", async () => {
    mod.createProvider(makeProvider({ id: "exc-prov", apiKey: "sk-key" }));
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const result = await mod.testProvider("exc-prov");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("handles missing data field in models response", async () => {
    mod.createProvider(makeProvider({ id: "nodata-prov", apiKey: "sk-key" }));
    const mockResponse = {
      ok: true,
      json: async () => ({}), // no data field
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("nodata-prov");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });
});

// ─── testProvider — huggingface (no apiKey required) ───────────────────────

describe("testProvider — HuggingFace", () => {
  it("allows testing without apiKey (huggingface type)", async () => {
    mod.createProvider(makeProvider({
      id: "hf-prov",
      type: "huggingface",
      apiKey: "",
      baseUrl: "https://router.huggingface.co/v1",
    }));
    const mockResponse = {
      ok: true,
      json: async () => ({ data: [{ id: "Qwen/Qwen3-8B" }] }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("hf-prov");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["Qwen/Qwen3-8B"]);
  });
});

// ─── getAllModels — skip disabled ──────────────────────────────────────────

describe("getAllModels — skip disabled providers", () => {
  it("skips providers with enabled=false", () => {
    mod.createProvider(makeProvider({
      id: "enabled-p",
      name: "Enabled",
      enabled: true,
      models: ["model-a"],
    }));
    mod.createProvider(makeProvider({
      id: "disabled-p",
      name: "Disabled",
      enabled: false,
      models: ["model-b"],
    }));

    const models = mod.getAllModels();
    expect(models.some(m => m.model === "model-a")).toBe(true);
    expect(models.some(m => m.model === "model-b")).toBe(false);
  });

  it("handles providers with no models array", () => {
    mod.createProvider(makeProvider({ id: "no-models", models: undefined as any }));
    // Should not throw — may or may not include the provider depending on defaults
    const models = mod.getAllModels();
    expect(Array.isArray(models)).toBe(true);
  });
});

// ─── runLLMHTTP — Ollama uses /v1 suffix ───────────────────────────────────

describe("runLLMHTTP — Ollama routing", () => {
  it("appends /v1 to Ollama baseUrl", async () => {
    mod.createProvider(makeProvider({
      id: "ollama-run",
      name: "Ollama",
      type: "ollama",
      apiKey: "",
      baseUrl: "http://localhost:11434",
    }));

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from ollama" } }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.runLLMHTTP({
      provider: "ollama-run",
      model: "llama3",
      prompt: "test",
    });

    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(result.text).toBe("hello from ollama");
  });
});

// ─── runLLMHTTP — HuggingFace routing ──────────────────────────────────────

describe("runLLMHTTP — HuggingFace routing", () => {
  it("routes HuggingFace via OpenAI-compat", async () => {
    mod.createProvider(makeProvider({
      id: "hf-run",
      name: "HF",
      type: "huggingface",
      apiKey: "hf-test-key",
      baseUrl: "https://router.huggingface.co/v1",
    }));

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from hf" } }],
        usage: { prompt_tokens: 3, completion_tokens: 7 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.runLLMHTTP({
      provider: "hf-run",
      model: "Qwen/Qwen3-8B",
      prompt: "test",
    });

    expect(fetchSpy.mock.calls[0][0]).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(result.text).toBe("hello from hf");
  });
});

// ─── runLLMHTTP — OpenRouter streaming ─────────────────────────────────────

describe("runLLMHTTP — OpenRouter streaming", () => {
  it("streams response via SSE for OpenRouter with onChunk", async () => {
    mod.createProvider(makeProvider({
      id: "or-stream",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-stream",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].join("");

    const encoder = new TextEncoder();
    let readerDone = false;

    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: encoder.encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    };

    const mockResponse = {
      ok: true,
      body: mockBody,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      { provider: "or-stream", model: "openai/gpt-4o", prompt: "hi" },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("Hello world!");
    expect(chunks).toEqual(["Hello", " world", "!"]);
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(3);
  });
});

// ─── streamOpenAIResponse — SSE parsing edge cases ─────────────────────────

describe("runLLMHTTP — SSE parsing edge cases", () => {
  it("handles malformed SSE lines gracefully", async () => {
    mod.createProvider(makeProvider({
      id: "sse-malformed",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-mal",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    const sseData = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      'data: {MALFORMED_JSON}\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n',
      'data: [DONE]\n',
      '',
    ].join("\n");

    const encoder = new TextEncoder();
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: encoder.encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    } as any);

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      { provider: "sse-malformed", model: "m", prompt: "hi" },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("ok!");
    expect(chunks).toContain("ok");
    expect(chunks).toContain("!");
  });

  it("handles SSE lines without data: prefix", async () => {
    mod.createProvider(makeProvider({
      id: "sse-noprefix",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-np",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    const sseData = [
      ': comment line\n',
      'event: message\n',
      'data: {"choices":[{"delta":{"content":"test"}}]}\n',
      '\n',
      'data: [DONE]\n',
    ].join("");

    const encoder = new TextEncoder();
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: encoder.encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    } as any);

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      { provider: "sse-noprefix", model: "m", prompt: "hi" },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("test");
  });
});

// ─── runOpenAICompat — agent loop with tool_calls ──────────────────────────

describe("runLLMHTTP — OpenAI agent loop with tool_calls", () => {
  beforeEach(() => {
    mod.createProvider(makeProvider({
      id: "tool-agent",
      name: "OpenAI Tool Agent",
      type: "openai",
      apiKey: "sk-tool-key",
      baseUrl: "https://api.openai.com/v1",
    }));
  });

  it("executes tool_calls then produces final text", async () => {
    // First call: model wants to call a tool
    const firstResponse = {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: '{"command":"echo hello"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      body: null,
    };

    // Second call: model produces final text
    const secondResponse = {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: "The result is: hello" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }),
      body: null,
    };

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(firstResponse as any)
      .mockResolvedValueOnce(secondResponse as any);

    // Mock pretool-executor
    vi.doMock("../src/pretool-executor.js", () => ({
      executeSinglePreTool: vi.fn(async () => "hello"),
    }));

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      {
        provider: "tool-agent",
        model: "gpt-4o",
        prompt: "run echo hello",
        tools: ["Bash"],
      },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("The result is: hello");
    expect(result.inputTokens).toBe(30); // 10 + 20
    expect(result.outputTokens).toBe(15); // 5 + 10
  });

  it("handles no tool_calls in response (direct text)", async () => {
    const response = {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: "Direct answer" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      {
        provider: "tool-agent",
        model: "gpt-4o",
        prompt: "what is 2+2?",
        tools: ["Bash"],
      },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("Direct answer");
    expect(chunks).toContain("Direct answer");
  });

  it("handles empty choices array", async () => {
    const response = {
      ok: true,
      json: async () => ({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      }),
      body: null,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    const result = await mod.runLLMHTTP({
      provider: "tool-agent",
      model: "gpt-4o",
      prompt: "test",
    });

    expect(result.text).toBe("");
  });

  it("handles tool_calls with malformed JSON arguments", async () => {
    const firstResponse = {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_bad",
              type: "function",
              function: { name: "bash", arguments: "NOT_VALID_JSON" },
            }],
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const secondResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      body: null,
    };

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(firstResponse as any)
      .mockResolvedValueOnce(secondResponse as any);

    vi.doMock("../src/pretool-executor.js", () => ({
      executeSinglePreTool: vi.fn(async () => "executed with empty args"),
    }));

    const result = await mod.runLLMHTTP({
      provider: "tool-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash"],
    });

    expect(result.text).toBe("done");
  });

  it("applies toolPermissions to filter tools", async () => {
    // Create provider with toolPermissions that block bash
    mod.createProvider(makeProvider({
      id: "filtered-agent",
      name: "Filtered",
      type: "openai",
      apiKey: "sk-filt",
      baseUrl: "https://api.openai.com/v1",
      toolPermissions: { deniedTools: ["bash"] },
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "no tools used" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "filtered-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash", "Read", "Write"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    // bash should be filtered out, but read_file and write_file should be present
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    expect(toolNames).not.toContain("bash");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
  });

  it("toolsEnabled=false removes all tools", async () => {
    mod.createProvider(makeProvider({
      id: "no-tools-agent",
      name: "No Tools",
      type: "openai",
      apiKey: "sk-notools",
      baseUrl: "https://api.openai.com/v1",
      toolPermissions: { toolsEnabled: false },
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "answer" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "no-tools-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash", "Read"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.tools).toBeUndefined();
  });

  it("allowedTools whitelist only allows specified tools", async () => {
    mod.createProvider(makeProvider({
      id: "whitelist-agent",
      name: "Whitelist",
      type: "openai",
      apiKey: "sk-wl",
      baseUrl: "https://api.openai.com/v1",
      toolPermissions: { allowedTools: ["read_file"] },
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "whitelist-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash", "Read", "Write"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    expect(toolNames).toEqual(["read_file"]);
  });
});

// ─── mapToolsToOAI dedup ───────────────────────────────────────────────────

describe("runLLMHTTP — mapToolsToOAI dedup", () => {
  it("deduplicates tools with same underlying function name (Bash, Glob, Grep all map to bash)", async () => {
    mod.createProvider(makeProvider({
      id: "dedup-agent",
      name: "Dedup",
      type: "openai",
      apiKey: "sk-dedup",
      baseUrl: "https://api.openai.com/v1",
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "dedup-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    // bash, Glob->bash, Grep->bash should be deduped to one "bash"
    // Read->read_file, Write->write_file, Edit->write_file should be deduped
    expect(toolNames.filter((n: string) => n === "bash").length).toBe(1);
    expect(toolNames.filter((n: string) => n === "write_file").length).toBe(1);
    expect(toolNames.filter((n: string) => n === "read_file").length).toBe(1);
  });

  it("handles parenthesized tool patterns like Bash(npm *)", async () => {
    mod.createProvider(makeProvider({
      id: "paren-agent",
      name: "Paren",
      type: "openai",
      apiKey: "sk-paren",
      baseUrl: "https://api.openai.com/v1",
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "paren-agent",
      model: "gpt-4o",
      prompt: "test",
      tools: ["Bash(npm *)", "Read"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("read_file");
  });
});

// ─── runLLMHTTP — OpenRouter non-streaming ─────────────────────────────────

describe("runLLMHTTP — OpenRouter non-streaming (no onChunk)", () => {
  it("returns parsed JSON response when no onChunk callback", async () => {
    mod.createProvider(makeProvider({
      id: "or-nostre",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-ns",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Non-streamed response" } }],
        usage: { prompt_tokens: 8, completion_tokens: 12 },
      }),
      body: null,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.runLLMHTTP({
      provider: "or-nostre",
      model: "openai/gpt-4o",
      prompt: "hi",
    });

    expect(result.text).toBe("Non-streamed response");
    expect(result.inputTokens).toBe(8);
    expect(result.outputTokens).toBe(12);
    expect(result.provider).toBe("or-nostre");
  });
});

// ─── runLLMHTTP — OpenRouter error ─────────────────────────────────────────

describe("runLLMHTTP — OpenRouter error handling", () => {
  it("throws with OpenRouter API prefix for error", async () => {
    mod.createProvider(makeProvider({
      id: "or-err",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-err",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => "Payment Required",
    } as any);

    await expect(
      mod.runLLMHTTP({ provider: "or-err", model: "m", prompt: "hi" }),
    ).rejects.toThrow("OpenRouter API 402: Payment Required");
  });

  it("handles text() failure on error response", async () => {
    mod.createProvider(makeProvider({
      id: "or-err2",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-err2",
      baseUrl: "https://openrouter.ai/api/v1",
    }));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => { throw new Error("read error"); },
    } as any);

    await expect(
      mod.runLLMHTTP({ provider: "or-err2", model: "m", prompt: "hi" }),
    ).rejects.toThrow("OpenRouter API 500: Internal Server Error");
  });
});

// ─── runLLMHTTP — perModelPermissions override ─────────────────────────────

describe("runLLMHTTP — per-model permission overrides", () => {
  it("applies per-model toolPermissions overriding provider defaults", async () => {
    mod.createProvider(makeProvider({
      id: "per-model-run",
      name: "PerModel",
      type: "openai",
      apiKey: "sk-pm",
      baseUrl: "https://api.openai.com/v1",
      toolPermissions: { allowedTools: ["bash", "read_file", "write_file"] },
      perModelPermissions: {
        "gpt-restricted": { allowedTools: ["read_file"] },
      },
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "per-model-run",
      model: "gpt-restricted",
      prompt: "test",
      tools: ["Bash", "Read", "Write"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    // Per-model override: only read_file allowed
    expect(toolNames).toEqual(["read_file"]);
  });
});

// ─── OpenAI-compat streaming final response ────────────────────────────────

describe("runLLMHTTP — OpenAI-compat streaming final response", () => {
  it("streams final text response for OpenAI provider", async () => {
    mod.createProvider(makeProvider({
      id: "oai-stream",
      name: "OpenAI",
      type: "openai",
      apiKey: "sk-oai-stream",
      baseUrl: "https://api.openai.com/v1",
    }));

    const sseData = [
      'data: {"choices":[{"delta":{"content":"streamed"}}]}\n',
      'data: {"choices":[{"delta":{"content":" text"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
      'data: [DONE]\n',
      '',
    ].join("\n");

    const encoder = new TextEncoder();
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: encoder.encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    } as any);

    const chunks: string[] = [];
    const result = await mod.runLLMHTTP(
      { provider: "oai-stream", model: "gpt-4o", prompt: "hi" },
      (chunk) => chunks.push(chunk),
    );

    expect(result.text).toBe("streamed text");
    expect(chunks).toEqual(["streamed", " text"]);
  });
});

// ─── OpenAI-compat — error text fallback ────────────────────────────────────

describe("runLLMHTTP — OpenAI-compat error", () => {
  it("throws with provider name in error message", async () => {
    mod.createProvider(makeProvider({
      id: "oai-err",
      name: "MyOpenAI",
      type: "openai",
      apiKey: "sk-oai-err",
      baseUrl: "https://api.openai.com/v1",
    }));

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid model",
    } as any);

    await expect(
      mod.runLLMHTTP({ provider: "oai-err", model: "bad-model", prompt: "hi" }),
    ).rejects.toThrow("MyOpenAI API 400: invalid model");
  });
});

// ─── WebSearch / WebFetch tool mappings ────────────────────────────────────

describe("runLLMHTTP — WebSearch and WebFetch tool mappings", () => {
  it("includes web_search and http_fetch in tool definitions", async () => {
    mod.createProvider(makeProvider({
      id: "web-tools",
      name: "WebTools",
      type: "openai",
      apiKey: "sk-web",
      baseUrl: "https://api.openai.com/v1",
    }));

    const response = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as any);

    await mod.runLLMHTTP({
      provider: "web-tools",
      model: "gpt-4o",
      prompt: "test",
      tools: ["WebSearch", "WebFetch"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const toolNames = body.tools?.map((t: any) => t.function.name) ?? [];
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("http_fetch");
  });
});
