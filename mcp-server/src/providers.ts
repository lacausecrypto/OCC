/**
 * providers.ts — Multi-LLM provider management.
 * Stores provider configs (API keys, base URLs) in a local JSON file.
 * Provides an HTTP-based LLM runner for non-Claude providers (OpenRouter, OpenAI, etc.)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LLMProvider {
  id: string;
  name: string;
  type: "claude" | "openrouter" | "openai" | "ollama" | "custom";
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  enabled: boolean;
  models?: string[];
  createdAt: string;
}

export interface LLMRunConfig {
  provider: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  model: string;
  provider: string;
}

// ─── API key encryption (AES-256-GCM with scrypt key derivation) ───────────

const ENCRYPTION_KEY_SOURCE = process.env.OCC_ENCRYPTION_KEY ?? "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
if (IS_PRODUCTION && !ENCRYPTION_KEY_SOURCE) {
  process.stderr.write("[occ-providers] FATAL: OCC_ENCRYPTION_KEY is required in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n");
  process.exit(1);
}
if (!ENCRYPTION_KEY_SOURCE) {
  logger.warn("occ-providers", "No OCC_ENCRYPTION_KEY set — using ephemeral key (dev mode only). API keys will NOT survive restarts.");
}
// In dev mode without a key, generate a per-process ephemeral key so keys are never stored with a known default
const EFFECTIVE_KEY = ENCRYPTION_KEY_SOURCE || crypto.randomBytes(32).toString("hex");
const ALGORITHM = "aes-256-gcm";

function deriveKey(source: string): Buffer {
  // Use a unique salt derived from the key itself (not hardcoded)
  const salt = crypto.createHash("sha256").update("occ-salt-v3:" + source).digest().subarray(0, 16);
  return crypto.scryptSync(source, salt, 32);
}

function encryptKey(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = deriveKey(EFFECTIVE_KEY);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `v2:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decryptKey(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  // Handle legacy XOR-obfuscated keys (migrate on read)
  if (!ciphertext.startsWith("v2:")) {
    return legacyDeobfuscate(ciphertext);
  }
  const [, ivHex, authTagHex, encrypted] = ciphertext.split(":");
  const key = deriveKey(EFFECTIVE_KEY);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

// Legacy XOR deobfuscation for migration of pre-v2 keys
const OBFUSCATION_KEY = "occ-chimera-2024";

function legacyDeobfuscate(encoded: string): string {
  if (!encoded) return encoded;
  const decoded = Buffer.from(encoded, 'base64').toString();
  return decoded.split('').map((c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ OBFUSCATION_KEY.charCodeAt(i % OBFUSCATION_KEY.length))
  ).join('');
}

// ─── Default provider templates ─────────────────────────────────────────────

const PROVIDER_TEMPLATES: Record<string, Partial<LLMProvider>> = {
  claude: {
    name: "Anthropic (Claude)",
    type: "claude",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  openrouter: {
    name: "OpenRouter",
    type: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-sonnet-4", "anthropic/claude-haiku-4",
      "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3-mini",
      "google/gemini-2.5-pro", "google/gemini-2.5-flash",
      "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
      "deepseek/deepseek-r1", "deepseek/deepseek-chat",
      "mistralai/mistral-large", "mistralai/codestral",
      "qwen/qwen3-235b-a22b",
    ],
  },
  openai: {
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o4-mini"],
  },
  ollama: {
    name: "Ollama (Local)",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    models: [], // Auto-discovered via /api/tags
  },
};

// ─── Storage ────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.LLM_PROVIDERS_CONFIG
  ?? path.join(process.cwd(), "llm-providers.json");

let providers: Map<string, LLMProvider> = new Map();

export function loadProviders(): void {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (Array.isArray(raw)) {
        // Each provider entry has _obfuscated: true if its apiKey was obfuscated on save.
        // Providers without this flag have plaintext keys (pre-migration or no key).
        providers = new Map(raw.filter((p: any) => p.id).map((p: LLMProvider & { _obfuscated?: boolean }) => {
          // Deobfuscate API key if the file was saved with obfuscation
          if (p._obfuscated && p.apiKey) {
            p.apiKey = decryptKey(p.apiKey);
          }
          delete (p as any)._obfuscated;
          return [p.id, p];
        }));
      }
      logger.info("occ-providers", `Loaded ${providers.size} LLM providers from ${CONFIG_PATH}`);
    }
  } catch (err) {
    logger.error("occ-providers", `Failed to load LLM providers: ${err}`);
  }

  // Always ensure a "claude" provider exists (built-in, uses CLI)
  if (!providers.has("claude")) {
    providers.set("claude", {
      id: "claude",
      name: "Anthropic (Claude CLI)",
      type: "claude",
      apiKey: "",
      baseUrl: "",
      defaultModel: "claude-sonnet-4-6",
      enabled: true,
      models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      createdAt: new Date().toISOString(),
    });
  }
}

function saveProviders(): void {
  try {
    // Obfuscate API keys before writing to disk
    const arr = [...providers.values()].map(p => ({
      ...p,
      apiKey: p.apiKey ? encryptKey(p.apiKey) : "",
      _obfuscated: true,
    }));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(arr, null, 2));
  } catch (err) {
    logger.error("occ-providers", `Failed to save LLM providers: ${err}`);
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listProviders(): LLMProvider[] {
  return [...providers.values()].map((p) => ({
    ...p,
    apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}...` : "",
  }));
}

export function getProvider(id: string): LLMProvider | undefined {
  return providers.get(id);
}

export function getProviderFull(id: string): LLMProvider | undefined {
  return providers.get(id);
}

export function createProvider(p: Omit<LLMProvider, "createdAt">): LLMProvider {
  const template = PROVIDER_TEMPLATES[p.type];
  const provider: LLMProvider = {
    ...p,
    name: p.name || template?.name || p.id,
    baseUrl: p.baseUrl || template?.baseUrl || "",
    models: p.models ?? template?.models ?? [],
    createdAt: new Date().toISOString(),
  };
  providers.set(provider.id, provider);
  saveProviders();
  return provider;
}

export function updateProvider(id: string, patch: Partial<LLMProvider>): LLMProvider | null {
  const existing = providers.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id }; // id is immutable
  providers.set(id, updated);
  saveProviders();
  return updated;
}

export function deleteProvider(id: string): boolean {
  if (id === "claude") return false; // Can't delete built-in
  const deleted = providers.delete(id);
  if (deleted) saveProviders();
  return deleted;
}

// ─── Provider resolution for model strings ──────────────────────────────────

/**
 * Resolve a model string to a provider.
 * Supports formats:
 *   "claude-sonnet-4-6"         → auto-detect "claude"
 *   "openrouter/gpt-4o"         → explicit provider prefix
 *   "gpt-4o" + provider field   → use explicit provider
 */
export function resolveProvider(model: string, explicitProvider?: string): { provider: LLMProvider; model: string } | null {
  // Check explicit provider
  if (explicitProvider) {
    const p = providers.get(explicitProvider);
    if (p?.enabled) return { provider: p, model };
  }

  // Check for prefix format: "provider/model"
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    const modelName = model.slice(slashIdx + 1);
    // Try matching by id
    const p = providers.get(prefix);
    if (p?.enabled) return { provider: p, model: model }; // Keep full model string for OpenRouter
    // Try matching by type
    for (const prov of providers.values()) {
      if (prov.type === prefix && prov.enabled) return { provider: prov, model: model };
    }
  }

  // Auto-detect: Claude models
  if (model.startsWith("claude-")) {
    const p = providers.get("claude");
    if (p?.enabled) return { provider: p, model };
  }

  // Auto-detect: search all providers' model lists
  for (const p of providers.values()) {
    if (!p.enabled) continue;
    if (p.models?.some((m) => m === model || m.endsWith(`/${model}`))) {
      return { provider: p, model };
    }
  }

  // Default to claude
  const claude = providers.get("claude");
  if (claude?.enabled) return { provider: claude, model };
  return null;
}

// ─── HTTP LLM runner (for non-Claude providers) ─────────────────────────────

export async function runLLMHTTP(
  config: LLMRunConfig,
  onChunk?: (chunk: string) => void,
): Promise<LLMResult> {
  const provider = providers.get(config.provider);
  if (!provider) throw new Error(`Provider "${config.provider}" not configured`);
  // Ollama doesn't need an API key (local server)
  if (provider.type !== "ollama" && !provider.apiKey) throw new Error(`Provider "${config.provider}" has no API key configured`);

  const startTime = Date.now();

  if (provider.type === "openrouter") {
    return runOpenRouter(provider, config, onChunk, startTime);
  } else if (provider.type === "openai") {
    return runOpenAICompat(provider, config, onChunk, startTime);
  } else if (provider.type === "ollama") {
    // Ollama is OpenAI-compatible at /v1/chat/completions
    const ollamaProvider = { ...provider, baseUrl: provider.baseUrl + "/v1" };
    return runOpenAICompat(ollamaProvider, config, onChunk, startTime);
  } else if (provider.type === "custom") {
    return runOpenAICompat(provider, config, onChunk, startTime);
  }

  throw new Error(`Provider type "${provider.type}" is not supported for HTTP calls`);
}

async function runOpenRouter(
  provider: LLMProvider,
  config: LLMRunConfig,
  onChunk: ((chunk: string) => void) | undefined,
  startTime: number,
): Promise<LLMResult> {
  const body = {
    model: config.model,
    messages: [
      ...(config.systemPrompt ? [{ role: "system" as const, content: config.systemPrompt }] : []),
      { role: "user" as const, content: config.prompt },
    ],
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onChunk,
  };

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
      "HTTP-Referer": "https://github.com/anthropics/occ",
      "X-Title": "OCC Chimera",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenRouter API ${res.status}: ${errText}`);
  }

  if (onChunk && body.stream && res.body) {
    return streamOpenAIResponse(res, provider, config.model, onChunk, startTime);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - startTime,
    model: config.model,
    provider: provider.id,
  };
}

async function runOpenAICompat(
  provider: LLMProvider,
  config: LLMRunConfig,
  onChunk: ((chunk: string) => void) | undefined,
  startTime: number,
): Promise<LLMResult> {
  const body = {
    model: config.model,
    messages: [
      ...(config.systemPrompt ? [{ role: "system" as const, content: config.systemPrompt }] : []),
      { role: "user" as const, content: config.prompt },
    ],
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onChunk,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${provider.apiKey}`,
  };

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`${provider.name} API ${res.status}: ${errText}`);
  }

  if (onChunk && body.stream && res.body) {
    return streamOpenAIResponse(res, provider, config.model, onChunk, startTime);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - startTime,
    model: config.model,
    provider: provider.id,
  };
}

async function streamOpenAIResponse(
  res: globalThis.Response,
  provider: LLMProvider,
  model: string,
  onChunk: (chunk: string) => void,
  startTime: number,
): Promise<LLMResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          fullText += content;
          onChunk(content);
        }
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
          outputTokens = parsed.usage.completion_tokens ?? outputTokens;
        }
      } catch { /* skip malformed */ }
    }
  }

  return {
    text: fullText,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - startTime,
    model,
    provider: provider.id,
  };
}

// ─── Test provider connection ───────────────────────────────────────────────

export async function testProvider(id: string): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const provider = providers.get(id);
  if (!provider) return { ok: false, error: "Provider not found" };
  if (provider.type !== "ollama" && !provider.apiKey) return { ok: false, error: "No API key configured" };

  if (provider.type === "claude") {
    return { ok: true, models: provider.models };
  }

  // Ollama: use /api/tags to discover models
  if (provider.type === "ollama") {
    try {
      const res = await fetch(`${provider.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, error: `Ollama ${res.status}: ${res.statusText}` };
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = data.models?.map((m) => m.name) ?? [];
      // Auto-update provider's model list
      if (models.length > 0) {
        const existing = providers.get(id);
        if (existing) { existing.models = models; saveProviders(); }
      }
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: `Cannot connect to Ollama at ${provider.baseUrl}: ${(err as Error).message}` };
    }
  }

  try {
    // For OpenAI-compat providers, try listing models
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { ok: false, error: `API ${res.status}: ${await res.text().catch(() => res.statusText)}` };
    }
    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = data.data?.map((m) => m.id).slice(0, 50) ?? [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Get all available models across all enabled providers ──────────────────

export function getAllModels(): Array<{ provider: string; providerName: string; model: string }> {
  const result: Array<{ provider: string; providerName: string; model: string }> = [];
  for (const p of providers.values()) {
    if (!p.enabled) continue;
    for (const m of p.models ?? []) {
      result.push({ provider: p.id, providerName: p.name, model: m });
    }
  }
  return result;
}

// ─── Init ───────────────────────────────────────────────────────────────────

loadProviders();
