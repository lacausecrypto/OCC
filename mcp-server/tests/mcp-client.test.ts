/**
 * Tests for the MCP Client module (mcp-client.ts).
 *
 * Tests server config loading, registration, caching logic,
 * and error recovery. Does NOT spawn real MCP servers
 * (would require external dependencies).
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
} from "../src/mcp-client.js";

let tmpDir: string;
let originalConfig: string | undefined;
let originalChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-mcp-test-"));
  originalConfig = process.env.MCP_SERVERS_CONFIG;
  originalChainsDir = process.env.CHAINS_DIR;
});

afterEach(async () => {
  await closeMcpClients();
  if (originalConfig !== undefined) process.env.MCP_SERVERS_CONFIG = originalConfig;
  else delete process.env.MCP_SERVERS_CONFIG;
  if (originalChainsDir !== undefined) process.env.CHAINS_DIR = originalChainsDir;
  else delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ─── Config loading ─────────────────────────────────────────────────────────

describe("MCP server config loading", () => {
  it("loads servers from custom config path", () => {
    const configPath = path.join(tmpDir, "servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
      "test-github": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "ghp_test" },
      },
      "test-fs": {
        command: "node",
        args: ["fs-server.js"],
      },
    }));

    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();

    const servers = getConfiguredServers();
    expect(servers).toContain("test-github");
    expect(servers).toContain("test-fs");
  });

  it("handles missing config file gracefully", () => {
    process.env.MCP_SERVERS_CONFIG = path.join(tmpDir, "nonexistent.json");
    delete process.env.CHAINS_DIR;
    expect(() => loadMcpServers()).not.toThrow();
  });

  it("handles malformed JSON gracefully", () => {
    const configPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(configPath, "not valid json {{{");
    process.env.MCP_SERVERS_CONFIG = configPath;
    expect(() => loadMcpServers()).not.toThrow();
  });

  it("loads from CHAINS_DIR/../occ-mcp-servers.json", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(chainsDir);
    const configPath = path.join(tmpDir, "occ-mcp-servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
      "chain-dir-server": { command: "echo", args: ["hello"] },
    }));

    delete process.env.MCP_SERVERS_CONFIG;
    process.env.CHAINS_DIR = chainsDir;
    loadMcpServers();

    expect(getConfiguredServers()).toContain("chain-dir-server");
  });
});

// ─── Server registration ────────────────────────────────────────────────────

describe("MCP server registration", () => {
  it("registers a server programmatically", () => {
    registerMcpServer("dynamic-server", {
      command: "node",
      args: ["server.js"],
    });

    expect(getConfiguredServers()).toContain("dynamic-server");
  });

  it("overwrites existing server config", () => {
    registerMcpServer("s1", { command: "old" });
    registerMcpServer("s1", { command: "new" });

    // Still only one entry
    const count = getConfiguredServers().filter((s) => s === "s1").length;
    expect(count).toBe(1);
  });
});

// ─── Empty state ────────────────────────────────────────────────────────────

describe("Empty state handling", () => {
  it("returns empty array when no servers configured", () => {
    delete process.env.MCP_SERVERS_CONFIG;
    delete process.env.CHAINS_DIR;
    // Don't call loadMcpServers — fresh state
    // getConfiguredServers should not crash
    expect(Array.isArray(getConfiguredServers())).toBe(true);
  });

  it("closeMcpClients works even with no active clients", async () => {
    await expect(closeMcpClients()).resolves.not.toThrow();
  });
});
