/**
 * MCP Client — connect to external MCP servers and call their tools.
 *
 * Used by the `mcp_call` pre-tool type to consume external MCP servers
 * (GitHub, Slack, PostgreSQL, Brave Search, etc.) inside chain steps.
 *
 * Supports both:
 * - Global server config (via env or occ-mcp-servers.json)
 * - Per-chain server config (inline in pre-tool definition)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ─── Server registry ────────────────────────────────────────────────────────

const serverConfigs = new Map<string, McpServerConfig>();
const activeClients = new Map<string, Client>();
const serverTools = new Map<string, string[]>(); // server → tool names

/** Load global MCP server configs from occ-mcp-servers.json or env. */
export function loadMcpServers(): void {
  // Try loading from config file
  const configPaths = [
    process.env.MCP_SERVERS_CONFIG,
    path.join(process.env.CHAINS_DIR ?? "", "..", "occ-mcp-servers.json"),
    path.join(os.homedir(), ".occ", "mcp-servers.json"),
  ].filter(Boolean) as string[];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, McpServerConfig>;
        for (const [name, serverConfig] of Object.entries(config)) {
          serverConfigs.set(name, serverConfig);
        }
        process.stderr.write(`[occ-mcp] Loaded ${serverConfigs.size} MCP server(s) from ${configPath}\n`);
        return;
      } catch (err) {
        process.stderr.write(`[occ-mcp] WARNING: Failed to parse ${configPath}: ${err}\n`);
      }
    }
  }

  if (serverConfigs.size === 0) {
    process.stderr.write(`[occ-mcp] No external MCP servers configured. Create occ-mcp-servers.json to enable mcp_call pre-tool.\n`);
  }
}

/** Register a server config (can be called from chain-level config). */
export function registerMcpServer(name: string, config: McpServerConfig): void {
  serverConfigs.set(name, config);
}

// In-flight connection promises to prevent race conditions
const connectingClients = new Map<string, Promise<Client>>();

/** Connect to a server and return the client (cached, race-safe). */
async function getClient(serverName: string): Promise<Client> {
  // Fast path: already connected
  const existing = activeClients.get(serverName);
  if (existing) return existing;

  // Deduplicate: if a connection is already in-flight, reuse its promise
  const inFlight = connectingClients.get(serverName);
  if (inFlight) return inFlight;

  const config = serverConfigs.get(serverName);
  if (!config) {
    throw new Error(`MCP server "${serverName}" not configured. Add it to occ-mcp-servers.json or register it in the chain.`);
  }

  // Create connection promise and cache it to prevent duplicates
  const connectionPromise = (async (): Promise<Client> => {
    // Validate command against whitelist to prevent command injection
    const ALLOWED_COMMANDS = new Set(["node", "npx", "python", "python3", "uvx", "uv", "deno", "bun", "docker"]);
    const commandBase = path.basename(config.command);
    if (!ALLOWED_COMMANDS.has(commandBase)) {
      throw new Error(`MCP server "${serverName}" uses disallowed command "${config.command}". Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`);
    }

    // Sanitize env: filter out keys that could override critical env vars
    const BLOCKED_ENV_KEYS = new Set(["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"]);
    const safeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
        process.stderr.write(`[occ-mcp] WARNING: Ignoring blocked env var "${key}" for server "${serverName}"\n`);
        continue;
      }
      safeEnv[key] = value;
    }

    // Validate args: reject dangerous flags that could enable code execution
    const DANGEROUS_ARG_PATTERNS = [/^--eval\b/, /^-e$/, /^--exec\b/, /^-c$/, /^--import\b/];
    for (const arg of config.args ?? []) {
      if (DANGEROUS_ARG_PATTERNS.some(p => p.test(arg))) {
        throw new Error(`MCP server "${serverName}" uses dangerous arg "${arg}". Remove it from config.`);
      }
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...safeEnv } as Record<string, string>,
    });

    const client = new Client(
      { name: `occ-${serverName}`, version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (err) {
      // Clean up transport on connection failure to prevent process leak
      connectingClients.delete(serverName);
      try { await transport.close(); } catch { /* best-effort cleanup */ }
      throw err;
    }

    activeClients.set(serverName, client);
    connectingClients.delete(serverName);

    // Discover tools
    try {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);
      serverTools.set(serverName, toolNames);
      process.stderr.write(`[occ-mcp] Connected to "${serverName}" — ${toolNames.length} tools available\n`);
    } catch {
      process.stderr.write(`[occ-mcp] Connected to "${serverName}" — tool discovery failed\n`);
    }

    return client;
  })();

  connectingClients.set(serverName, connectionPromise);
  return connectionPromise;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Call a tool on an external MCP server. Auto-recovers from stale connections. */
export async function mcpCall(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  let client: Client;
  try {
    client = await getClient(serverName);
  } catch (err) {
    // Connection failed — clean up and re-throw
    activeClients.delete(serverName);
    connectingClients.delete(serverName);
    throw err;
  }

  try {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    // Extract text content from MCP result
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((c: any) => {
          if (c.type === "text") return c.text;
          if (c.type === "image") return `[image: ${c.mimeType}]`;
          return JSON.stringify(c);
        })
        .join("\n");
    }

    return JSON.stringify(result);
  } catch (err) {
    // Tool call failed — likely stale/crashed client. Remove from cache so next call reconnects.
    activeClients.delete(serverName);
    process.stderr.write(`[occ-mcp] Call to "${serverName}.${toolName}" failed, removing stale client: ${err instanceof Error ? err.message : String(err)}\n`);
    throw err;
  }
}

/** List all available tools across all configured servers. */
export async function discoverTools(): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};

  for (const [name] of serverConfigs) {
    try {
      const client = await getClient(name);
      const toolsResult = await client.listTools();
      result[name] = toolsResult.tools.map((t) => `${t.name}: ${t.description ?? ""}`);
    } catch (err) {
      result[name] = [`(error: ${err instanceof Error ? err.message : String(err)})`];
    }
  }

  return result;
}

/** Get list of configured server names. */
export function getConfiguredServers(): string[] {
  return [...serverConfigs.keys()];
}

/** Get the config file path (resolved, consistent). */
function getConfigFilePath(): string {
  if (process.env.MCP_SERVERS_CONFIG) return process.env.MCP_SERVERS_CONFIG;
  const chainsParent = path.join(process.env.CHAINS_DIR ?? ".", "..");
  return path.join(chainsParent, "occ-mcp-servers.json");
}

/** Get current MCP server configs as a plain object. */
export function getMcpConfig(): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of serverConfigs) result[name] = cfg;
  return result;
}

/** Save MCP server config to disk AND reload in-memory. */
export async function saveMcpConfig(config: Record<string, McpServerConfig>): Promise<void> {
  const configPath = getConfigFilePath();

  // Write to disk
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.stderr.write(`[occ-mcp] Saved ${Object.keys(config).length} MCP server(s) to ${configPath}\n`);

  // Close existing clients for removed servers
  for (const [name, client] of activeClients) {
    if (!config[name]) {
      try { await client.close(); } catch { /* ignore */ }
      activeClients.delete(name);
      connectingClients.delete(name);
      serverTools.delete(name);
    }
  }

  // Update in-memory registry
  serverConfigs.clear();
  for (const [name, cfg] of Object.entries(config)) {
    serverConfigs.set(name, cfg);
  }

  // Close clients whose config changed (force reconnect on next call)
  for (const [name] of activeClients) {
    const oldCfg = serverConfigs.get(name);
    const newCfg = config[name];
    if (oldCfg && newCfg && JSON.stringify(oldCfg) !== JSON.stringify(newCfg)) {
      try { const c = activeClients.get(name); if (c) await c.close(); } catch { /* ignore */ }
      activeClients.delete(name);
      connectingClients.delete(name);
      serverTools.delete(name);
    }
  }
}

/** Shutdown all active MCP clients. */
export async function closeMcpClients(): Promise<void> {
  for (const [name, client] of activeClients) {
    try {
      await client.close();
    } catch { /* ignore */ }
  }
  activeClients.clear();
}
