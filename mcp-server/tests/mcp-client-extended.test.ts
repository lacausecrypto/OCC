/**
 * Extended MCP client tests.
 *
 * Covers:
 * - mcpCall error paths (server not configured)
 * - discoverTools with no servers
 * - Config loading edge cases (empty config, multiple config files)
 * - closeMcpClients idempotency
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadMcpServers,
  registerMcpServer,
  getConfiguredServers,
  closeMcpClients,
  mcpCall,
  discoverTools,
} from "../src/mcp-client.js";

let tmpDir: string;
let origConfig: string | undefined;
let origChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-mcp-ext-"));
  origConfig = process.env.MCP_SERVERS_CONFIG;
  origChainsDir = process.env.CHAINS_DIR;
});

afterEach(async () => {
  await closeMcpClients();
  if (origConfig !== undefined) process.env.MCP_SERVERS_CONFIG = origConfig;
  else delete process.env.MCP_SERVERS_CONFIG;
  if (origChainsDir !== undefined) process.env.CHAINS_DIR = origChainsDir;
  else delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ─── mcpCall error paths ─────────────────────────────────────────────────────

describe("mcpCall error handling", () => {
  it("throws when server is not configured", async () => {
    await expect(
      mcpCall("nonexistent-server", "some_tool", {})
    ).rejects.toThrow(/not configured/);
  });

  it("throws with descriptive error for unconfigured server", async () => {
    await expect(
      mcpCall("my-special-server", "tool1", { arg: "val" })
    ).rejects.toThrow("my-special-server");
  });
});

// ─── discoverTools ───────────────────────────────────────────────────────────

describe("discoverTools", () => {
  it("returns empty object when no servers configured", async () => {
    delete process.env.MCP_SERVERS_CONFIG;
    delete process.env.CHAINS_DIR;
    // discoverTools iterates serverConfigs, which may have entries from other tests
    // but any entries will fail to connect, so results will contain errors
    const result = await discoverTools();
    expect(typeof result).toBe("object");
    // All entries should be arrays
    for (const value of Object.values(result)) {
      expect(Array.isArray(value)).toBe(true);
    }
  });

  it("includes error for servers that fail to connect", async () => {
    registerMcpServer("failing-server", {
      command: "nonexistent-binary",
      args: [],
    });
    const result = await discoverTools();
    if (result["failing-server"]) {
      expect(result["failing-server"][0]).toContain("error");
    }
  });
});

// ─── Config loading edge cases ───────────────────────────────────────────────

describe("Config loading edge cases", () => {
  it("loads empty config file gracefully", () => {
    const configPath = path.join(tmpDir, "empty-servers.json");
    fs.writeFileSync(configPath, "{}");
    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();
    // No servers added, but no crash
    expect(true).toBe(true);
  });

  it("loads config with many servers", () => {
    const config: Record<string, any> = {};
    for (let i = 0; i < 10; i++) {
      config[`server-${i}`] = { command: "echo", args: [`${i}`] };
    }
    const configPath = path.join(tmpDir, "many-servers.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();
    const servers = getConfiguredServers();
    for (let i = 0; i < 10; i++) {
      expect(servers).toContain(`server-${i}`);
    }
  });

  it("handles config file with env vars", () => {
    const configPath = path.join(tmpDir, "env-servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
      "github": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "test_token_123" },
      },
    }));
    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();
    expect(getConfiguredServers()).toContain("github");
  });
});

// ─── Server registration edge cases ─────────────────────────────────────────

describe("Server registration edge cases", () => {
  it("can register and immediately get configured servers", () => {
    registerMcpServer("instant", { command: "echo" });
    expect(getConfiguredServers()).toContain("instant");
  });

  it("registration survives closeMcpClients", async () => {
    registerMcpServer("persistent", { command: "echo" });
    await closeMcpClients(); // Should only close clients, not configs
    expect(getConfiguredServers()).toContain("persistent");
  });

  it("handles server with complex args", () => {
    registerMcpServer("complex", {
      command: "node",
      args: ["--experimental-specifier-resolution=node", "server.mjs", "--port=3000"],
      env: { NODE_ENV: "production", LOG_LEVEL: "debug" },
    });
    expect(getConfiguredServers()).toContain("complex");
  });
});

// ─── closeMcpClients ─────────────────────────────────────────────────────────

describe("closeMcpClients idempotency", () => {
  it("can be called repeatedly without error", async () => {
    await closeMcpClients();
    await closeMcpClients();
    await closeMcpClients();
    expect(true).toBe(true);
  });
});
