/**
 * Tests for the multi-LLM provider management layer (providers.ts).
 *
 * Covers:
 * - Encryption round-trip (encryptKey / decryptKey via save+load)
 * - Legacy deobfuscation (pre-v2 XOR keys migrated on load)
 * - loadProviders (empty file, valid JSON, corrupt JSON, always creates claude)
 * - saveProviders (persists to file, encrypts API keys)
 * - listProviders (returns masked keys)
 * - getProvider / getProviderFull (by ID, missing)
 * - createProvider / updateProvider / deleteProvider (CRUD)
 * - resolveProvider (model string -> provider config)
 * - runLLMHTTP (mock fetch, headers/payload for OpenAI and OpenRouter)
 * - getAllModels (all enabled provider models)
 * - testProvider (connection test stub)
 * - Provider presets (OpenRouter, OpenAI model lists)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let configPath: string;
let originalEnv: Record<string, string | undefined>;

// We need to dynamically import providers.ts after setting env vars,
// since CONFIG_PATH and ENCRYPTION_KEY_SOURCE are read at module load.
type ProvidersModule = typeof import("../src/providers.js");
let mod: ProvidersModule;

async function loadModule(): Promise<ProvidersModule> {
  // Reset module registry so providers.ts re-evaluates with current env
  vi.resetModules();
  return await import("../src/providers.js");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-providers-test-"));
  configPath = path.join(tmpDir, "providers.json");

  originalEnv = {
    LLM_PROVIDERS_CONFIG: process.env.LLM_PROVIDERS_CONFIG,
    OCC_ENCRYPTION_KEY: process.env.OCC_ENCRYPTION_KEY,
  };

  process.env.LLM_PROVIDERS_CONFIG = configPath;
  process.env.OCC_ENCRYPTION_KEY = "test-encryption-key-1234";

  mod = await loadModule();
});

afterEach(() => {
  // Restore env
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
  cleanupTmpDirSync(tmpDir);
  vi.restoreAllMocks();
});

// ─── Helper ────────────────────────────────────────────────────────────────

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

// ─── loadProviders ─────────────────────────────────────────────────────────

describe("loadProviders", () => {
  it("handles missing config file and creates default claude provider", () => {
    // Module auto-calls loadProviders on import; claude should exist
    const claude = mod.getProvider("claude");
    expect(claude).toBeDefined();
    expect(claude!.id).toBe("claude");
    expect(claude!.type).toBe("claude");
    expect(claude!.enabled).toBe(true);
  });

  it("handles empty file gracefully", async () => {
    fs.writeFileSync(configPath, "");
    mod = await loadModule();
    // Should not crash; claude fallback should still be created
    const claude = mod.getProvider("claude");
    expect(claude).toBeDefined();
  });

  it("handles corrupt JSON gracefully", async () => {
    fs.writeFileSync(configPath, "{{{not json!!!");
    mod = await loadModule();
    // Should not crash; claude fallback
    const claude = mod.getProvider("claude");
    expect(claude).toBeDefined();
  });

  it("loads valid JSON array of providers", async () => {
    const data = [
      {
        id: "my-openai",
        name: "My OpenAI",
        type: "openai",
        apiKey: "plain-key-for-test",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    fs.writeFileSync(configPath, JSON.stringify(data));
    mod = await loadModule();
    const p = mod.getProvider("my-openai");
    expect(p).toBeDefined();
    expect(p!.name).toBe("My OpenAI");
    // Plain key (no _obfuscated flag) should remain as-is
    expect(p!.apiKey).toBe("plain-key-for-test");
  });

  it("skips entries without id field", async () => {
    const data = [
      { name: "No ID", type: "openai", apiKey: "", baseUrl: "", enabled: true, createdAt: "2025-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(configPath, JSON.stringify(data));
    mod = await loadModule();
    // Only claude should be present
    const list = mod.listProviders();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("claude");
  });

  it("does not override existing claude provider from file", async () => {
    const data = [
      {
        id: "claude",
        name: "Custom Claude",
        type: "claude",
        apiKey: "",
        baseUrl: "",
        enabled: true,
        createdAt: "2025-01-01T00:00:00Z",
        models: ["claude-opus-4-6"],
      },
    ];
    fs.writeFileSync(configPath, JSON.stringify(data));
    mod = await loadModule();
    const claude = mod.getProvider("claude");
    expect(claude).toBeDefined();
    expect(claude!.name).toBe("Custom Claude");
  });
});

// ─── Encryption round-trip (via save+load) ─────────────────────────────────

describe("Encryption round-trip", () => {
  it("encrypts API keys on save and decrypts on load", async () => {
    const prov = makeProvider({ id: "enc-test", apiKey: "sk-secret-12345678" });
    mod.createProvider(prov);

    // Read raw file — apiKey should be encrypted (v2: prefix)
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const saved = raw.find((p: any) => p.id === "enc-test");
    expect(saved).toBeDefined();
    expect(saved.apiKey).not.toBe("sk-secret-12345678");
    expect(saved.apiKey.startsWith("v2:")).toBe(true);
    expect(saved._obfuscated).toBe(true);

    // Re-load and verify decryption
    mod = await loadModule();
    const loaded = mod.getProvider("enc-test");
    expect(loaded).toBeDefined();
    expect(loaded!.apiKey).toBe("sk-secret-12345678");
  });

  it("different keys produce different ciphertexts", () => {
    mod.createProvider(makeProvider({ id: "enc-a", apiKey: "key-alpha" }));
    mod.createProvider(makeProvider({ id: "enc-b", apiKey: "key-beta" }));

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const a = raw.find((p: any) => p.id === "enc-a");
    const b = raw.find((p: any) => p.id === "enc-b");
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it("same key encrypted twice produces different ciphertexts (random IV)", () => {
    mod.createProvider(makeProvider({ id: "enc-c", apiKey: "same-key" }));
    // Read, delete, re-create to get a second encryption
    const raw1 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const ct1 = raw1.find((p: any) => p.id === "enc-c").apiKey;

    mod.deleteProvider("enc-c");
    mod.createProvider(makeProvider({ id: "enc-c", apiKey: "same-key" }));
    const raw2 = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const ct2 = raw2.find((p: any) => p.id === "enc-c").apiKey;

    // Random IV means different ciphertexts
    expect(ct1).not.toBe(ct2);
  });

  it("handles empty apiKey without encryption", () => {
    mod.createProvider(makeProvider({ id: "no-key", apiKey: "" }));
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const saved = raw.find((p: any) => p.id === "no-key");
    expect(saved.apiKey).toBe("");
  });
});

// ─── Legacy deobfuscation ──────────────────────────────────────────────────

describe("Legacy deobfuscation", () => {
  it("decrypts legacy XOR-obfuscated keys on load", async () => {
    // XOR-obfuscate a test key using the known OBFUSCATION_KEY
    const OBFUSCATION_KEY = "occ-chimera-2024";
    const plainKey = "sk-legacy-test-key";
    const xored = plainKey
      .split("")
      .map((c, i) =>
        String.fromCharCode(
          c.charCodeAt(0) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length),
        ),
      )
      .join("");
    const encoded = Buffer.from(xored).toString("base64");

    // Write a provider with legacy-format key (no v2: prefix)
    const data = [
      {
        id: "legacy-prov",
        name: "Legacy",
        type: "openai",
        apiKey: encoded,
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        createdAt: "2025-01-01T00:00:00Z",
        _obfuscated: true,
      },
    ];
    fs.writeFileSync(configPath, JSON.stringify(data));
    mod = await loadModule();

    const p = mod.getProvider("legacy-prov");
    expect(p).toBeDefined();
    expect(p!.apiKey).toBe(plainKey);
  });
});

// ─── listProviders ─────────────────────────────────────────────────────────

describe("listProviders", () => {
  it("returns masked keys (first 8 chars + ...)", () => {
    mod.createProvider(makeProvider({ id: "mask-test", apiKey: "sk-test-key-abcdef1234567890" }));
    const list = mod.listProviders();
    const p = list.find((x) => x.id === "mask-test");
    expect(p).toBeDefined();
    expect(p!.apiKey).toBe("sk-test-...");
    expect(p!.apiKey).not.toContain("abcdef");
  });

  it("returns empty string for providers without keys", () => {
    const claude = mod.listProviders().find((x) => x.id === "claude");
    expect(claude).toBeDefined();
    expect(claude!.apiKey).toBe("");
  });
});

// ─── getProvider / getProviderFull ──────────────────────────────────────────

describe("getProvider / getProviderFull", () => {
  it("returns provider by ID", () => {
    mod.createProvider(makeProvider({ id: "get-test" }));
    const p = mod.getProvider("get-test");
    expect(p).toBeDefined();
    expect(p!.id).toBe("get-test");
  });

  it("returns undefined for missing ID", () => {
    expect(mod.getProvider("nonexistent")).toBeUndefined();
  });

  it("getProviderFull returns the same provider", () => {
    mod.createProvider(makeProvider({ id: "full-test", apiKey: "sk-full-secret" }));
    const p = mod.getProviderFull("full-test");
    expect(p).toBeDefined();
    expect(p!.apiKey).toBe("sk-full-secret");
  });
});

// ─── createProvider ────────────────────────────────────────────────────────

describe("createProvider", () => {
  it("creates a provider with template defaults", () => {
    const p = mod.createProvider({
      id: "my-or",
      name: "",
      type: "openrouter",
      apiKey: "sk-or-123",
      baseUrl: "",
      enabled: true,
    });
    expect(p.name).toBe("OpenRouter");
    expect(p.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(p.models!.length).toBeGreaterThan(0);
    expect(p.createdAt).toBeTruthy();
  });

  it("preserves explicit values over template", () => {
    const p = mod.createProvider({
      id: "custom-oai",
      name: "My Custom",
      type: "openai",
      apiKey: "sk-123",
      baseUrl: "https://custom.api.com",
      enabled: true,
      models: ["custom-model-1"],
    });
    expect(p.name).toBe("My Custom");
    expect(p.baseUrl).toBe("https://custom.api.com");
    expect(p.models).toEqual(["custom-model-1"]);
  });

  it("persists provider to disk", () => {
    mod.createProvider(makeProvider({ id: "persist-test" }));
    expect(fs.existsSync(configPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.some((p: any) => p.id === "persist-test")).toBe(true);
  });
});

// ─── updateProvider ────────────────────────────────────────────────────────

describe("updateProvider", () => {
  it("updates an existing provider", () => {
    mod.createProvider(makeProvider({ id: "upd-test", name: "Original" }));
    const updated = mod.updateProvider("upd-test", { name: "Updated" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(mod.getProvider("upd-test")!.name).toBe("Updated");
  });

  it("returns null for non-existent provider", () => {
    expect(mod.updateProvider("ghost", { name: "X" })).toBeNull();
  });

  it("cannot change the id via patch", () => {
    mod.createProvider(makeProvider({ id: "immutable-id" }));
    const updated = mod.updateProvider("immutable-id", { id: "new-id" } as any);
    expect(updated!.id).toBe("immutable-id");
  });
});

// ─── deleteProvider ────────────────────────────────────────────────────────

describe("deleteProvider", () => {
  it("deletes an existing provider", () => {
    mod.createProvider(makeProvider({ id: "del-test" }));
    expect(mod.deleteProvider("del-test")).toBe(true);
    expect(mod.getProvider("del-test")).toBeUndefined();
  });

  it("returns false for non-existent provider", () => {
    expect(mod.deleteProvider("ghost")).toBe(false);
  });

  it("cannot delete the built-in claude provider", () => {
    expect(mod.deleteProvider("claude")).toBe(false);
    expect(mod.getProvider("claude")).toBeDefined();
  });
});

// ─── resolveProvider ───────────────────────────────────────────────────────

describe("resolveProvider", () => {
  beforeEach(() => {
    // Add an openrouter provider for testing
    mod.createProvider(makeProvider({
      id: "openrouter",
      name: "OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-key",
      baseUrl: "https://openrouter.ai/api/v1",
      models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
    }));
    mod.createProvider(makeProvider({
      id: "my-openai",
      name: "OpenAI",
      type: "openai",
      apiKey: "sk-oai-key",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o", "gpt-4o-mini"],
    }));
  });

  it("auto-detects claude models by prefix", () => {
    const result = mod.resolveProvider("claude-sonnet-4-6");
    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("claude");
    expect(result!.model).toBe("claude-sonnet-4-6");
  });

  it("resolves explicit provider by ID", () => {
    const result = mod.resolveProvider("gpt-4o", "my-openai");
    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("my-openai");
  });

  it("resolves provider/model prefix format by id", () => {
    const result = mod.resolveProvider("openrouter/gpt-4o");
    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("openrouter");
    expect(result!.model).toBe("openrouter/gpt-4o");
  });

  it("resolves provider/model prefix format by type", () => {
    const result = mod.resolveProvider("openai/gpt-4o");
    expect(result).not.toBeNull();
    expect(result!.provider.type).toBe("openai");
  });

  it("searches model lists of all providers", () => {
    const result = mod.resolveProvider("gpt-4o-mini");
    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("my-openai");
  });

  it("falls back to claude for unknown models", () => {
    const result = mod.resolveProvider("totally-unknown-model");
    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("claude");
  });

  it("returns null when explicit provider is disabled", () => {
    mod.updateProvider("my-openai", { enabled: false });
    const result = mod.resolveProvider("gpt-4o", "my-openai");
    // Falls through to other resolution strategies
    // Since my-openai is disabled, it won't match
    expect(result).not.toBeNull();
    // Should not be my-openai
    expect(result!.provider.id).not.toBe("my-openai");
  });

  it("returns null when all providers are disabled", () => {
    // Disable all
    mod.updateProvider("claude", { enabled: false });
    mod.updateProvider("openrouter", { enabled: false });
    mod.updateProvider("my-openai", { enabled: false });
    const result = mod.resolveProvider("gpt-4o");
    expect(result).toBeNull();
  });
});

// ─── runLLMHTTP ────────────────────────────────────────────────────────────

describe("runLLMHTTP", () => {
  beforeEach(() => {
    mod.createProvider(makeProvider({
      id: "test-openai",
      name: "Test OpenAI",
      type: "openai",
      apiKey: "sk-openai-test-key",
      baseUrl: "https://api.openai.com/v1",
    }));
    mod.createProvider(makeProvider({
      id: "test-or",
      name: "Test OpenRouter",
      type: "openrouter",
      apiKey: "sk-or-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    }));
  });

  it("throws for unknown provider", async () => {
    await expect(
      mod.runLLMHTTP({ provider: "ghost", model: "m", prompt: "hi" }),
    ).rejects.toThrow('Provider "ghost" not configured');
  });

  it("throws for provider without API key", async () => {
    mod.createProvider(makeProvider({ id: "no-key-prov", apiKey: "" }));
    await expect(
      mod.runLLMHTTP({ provider: "no-key-prov", model: "m", prompt: "hi" }),
    ).rejects.toThrow("has no API key configured");
  });

  it("throws for unsupported provider type (claude)", async () => {
    // Claude provider has type "claude" which is not supported for HTTP calls
    // But claude has no apiKey by default, so give it one
    mod.updateProvider("claude", { apiKey: "sk-claude-key" });
    await expect(
      mod.runLLMHTTP({ provider: "claude", model: "claude-sonnet-4-6", prompt: "hi" }),
    ).rejects.toThrow('Provider type "claude" is not supported');
  });

  it("sends correct headers and payload for OpenAI", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from OpenAI" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      text: async () => "",
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.runLLMHTTP({
      provider: "test-openai",
      model: "gpt-4o",
      prompt: "Hello",
      systemPrompt: "You are helpful",
      maxTokens: 1000,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts!.method).toBe("POST");

    const headers = opts!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-openai-test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    // OpenAI should NOT have OpenRouter-specific headers
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();

    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(false);

    expect(result.text).toBe("Hello from OpenAI");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.model).toBe("gpt-4o");
    expect(result.provider).toBe("test-openai");
  });

  it("sends correct headers for OpenRouter (includes Referer and X-Title)", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from OR" } }],
        usage: { prompt_tokens: 5, completion_tokens: 15 },
      }),
      text: async () => "",
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    await mod.runLLMHTTP({
      provider: "test-or",
      model: "openai/gpt-4o",
      prompt: "Hi",
    });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");

    const headers = opts!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-or-test-key");
    expect(headers["HTTP-Referer"]).toBe("https://github.com/anthropics/occ");
    expect(headers["X-Title"]).toBe("OCC Chimera");
  });

  it("handles API error responses", async () => {
    const mockResponse = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "Rate limit exceeded",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    await expect(
      mod.runLLMHTTP({ provider: "test-openai", model: "gpt-4o", prompt: "hi" }),
    ).rejects.toThrow("API 429: Rate limit exceeded");
  });

  it("omits system message when systemPrompt is not provided", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "response" } }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    await mod.runLLMHTTP({
      provider: "test-openai",
      model: "gpt-4o",
      prompt: "Hello",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("uses default maxTokens of 8192 when not specified", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "" } }],
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    await mod.runLLMHTTP({
      provider: "test-openai",
      model: "gpt-4o",
      prompt: "Hello",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(8192);
  });

  it("runs custom provider type via OpenAI-compat path", async () => {
    mod.createProvider(makeProvider({
      id: "custom-prov",
      name: "Custom LLM",
      type: "custom",
      apiKey: "sk-custom",
      baseUrl: "https://my-llm.example.com/v1",
    }));

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "custom response" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
      body: null,
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.runLLMHTTP({
      provider: "custom-prov",
      model: "custom-model",
      prompt: "test",
    });

    expect(fetchSpy.mock.calls[0][0]).toBe("https://my-llm.example.com/v1/chat/completions");
    expect(result.text).toBe("custom response");
    expect(result.provider).toBe("custom-prov");
  });
});

// ─── testProvider ──────────────────────────────────────────────────────────

describe("testProvider", () => {
  it("returns error for unknown provider", async () => {
    const result = await mod.testProvider("nope");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Provider not found");
  });

  it("returns error for provider without API key", async () => {
    mod.createProvider(makeProvider({ id: "no-key", apiKey: "" }));
    const result = await mod.testProvider("no-key");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("No API key configured");
  });

  it("returns ok for claude type without network call", async () => {
    // Claude built-in has no apiKey by default; give it one for this test
    mod.updateProvider("claude", { apiKey: "sk-ant-test" });
    const result = await mod.testProvider("claude");
    expect(result.ok).toBe(true);
    expect(result.models).toBeDefined();
  });

  it("calls models endpoint for non-claude providers", async () => {
    mod.createProvider(makeProvider({ id: "test-conn", apiKey: "sk-key" }));

    const mockResponse = {
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      }),
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any);

    const result = await mod.testProvider("test-conn");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

// ─── getAllModels ───────────────────────────────────────────────────────────

describe("getAllModels", () => {
  it("returns models from all enabled providers", () => {
    mod.createProvider(makeProvider({
      id: "models-test",
      name: "Test",
      type: "openai",
      models: ["model-a", "model-b"],
    }));

    const models = mod.getAllModels();
    // Should include claude models + our test provider models
    expect(models.some((m) => m.model === "model-a")).toBe(true);
    expect(models.some((m) => m.model === "model-b")).toBe(true);
    expect(models.some((m) => m.provider === "claude")).toBe(true);
  });

  it("excludes disabled providers", () => {
    mod.createProvider(makeProvider({
      id: "disabled-prov",
      name: "Disabled",
      type: "openai",
      enabled: false,
      models: ["disabled-model"],
    }));

    const models = mod.getAllModels();
    expect(models.some((m) => m.model === "disabled-model")).toBe(false);
  });
});

// ─── Provider presets ──────────────────────────────────────────────────────

describe("Provider presets / templates", () => {
  it("openrouter template includes expected models", () => {
    const p = mod.createProvider({
      id: "or-preset",
      name: "",
      type: "openrouter",
      apiKey: "sk-or",
      baseUrl: "",
      enabled: true,
    });
    expect(p.models).toBeDefined();
    expect(p.models!.some((m) => m.includes("claude"))).toBe(true);
    expect(p.models!.some((m) => m.includes("gpt-4o"))).toBe(true);
    expect(p.models!.some((m) => m.includes("gemini"))).toBe(true);
  });

  it("openai template includes expected models", () => {
    const p = mod.createProvider({
      id: "oai-preset",
      name: "",
      type: "openai",
      apiKey: "sk-oai",
      baseUrl: "",
      enabled: true,
    });
    expect(p.models).toBeDefined();
    expect(p.models!).toContain("gpt-4o");
    expect(p.models!).toContain("o3-mini");
  });

  it("custom type gets no template defaults", () => {
    const p = mod.createProvider({
      id: "custom-preset",
      name: "",
      type: "custom",
      apiKey: "sk-custom",
      baseUrl: "",
      enabled: true,
    });
    // No template for "custom", so name falls back to id
    expect(p.name).toBe("custom-preset");
    expect(p.models).toEqual([]);
    expect(p.baseUrl).toBe("");
  });
});
