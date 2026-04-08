/**
 * Coverage-boost tests for mcp-client.ts.
 *
 * Covers uncovered lines 218-220, 232-262:
 * - Command whitelist validation (reject unknown commands)
 * - Env sanitization (block PATH, HOME, NODE_OPTIONS, LD_PRELOAD)
 * - Dangerous args validation (reject --eval, -e, -c)
 * - saveMcpConfig: write to disk, close removed servers, update registry
 * - getMcpConfig: return current configs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock MCP SDK
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockCallTool = vi.fn();
const mockListTools = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const MockClient = vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.callTool = mockCallTool;
    this.listTools = mockListTools;
  });
  return { Client: MockClient };
});

const mockTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const MockTransport = vi.fn(function (this: any) {
    this.close = mockTransportClose;
  });
  return { StdioClientTransport: MockTransport };
});

import {
  registerMcpServer,
  getConfiguredServers,
  closeMcpClients,
  mcpCall,
  getMcpConfig,
  saveMcpConfig,
} from "../src/mcp-client.js";

let tmpDir: string;
let originalConfig: string | undefined;
let originalChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-mcp-boost-"));
  originalConfig = process.env.MCP_SERVERS_CONFIG;
  originalChainsDir = process.env.CHAINS_DIR;
  mockConnect.mockReset();
  mockClose.mockReset();
  mockCallTool.mockReset();
  mockListTools.mockReset();
  mockTransportClose.mockReset();
});

afterEach(async () => {
  await closeMcpClients();
  if (originalConfig !== undefined) process.env.MCP_SERVERS_CONFIG = originalConfig;
  else delete process.env.MCP_SERVERS_CONFIG;
  if (originalChainsDir !== undefined) process.env.CHAINS_DIR = originalChainsDir;
  else delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ─── Command whitelist validation ────────────────────────────────────────────

describe("Command whitelist validation", () => {
  it("rejects disallowed command (bash)", async () => {
    registerMcpServer("bad-cmd-bash", { command: "bash", args: ["server.sh"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });

    await expect(mcpCall("bad-cmd-bash", "tool", {})).rejects.toThrow("disallowed command");
  });

  it("rejects disallowed command (sh)", async () => {
    registerMcpServer("bad-cmd-sh", { command: "sh", args: ["-c", "echo"] });

    await expect(mcpCall("bad-cmd-sh", "tool", {})).rejects.toThrow("disallowed command");
  });

  it("rejects disallowed command (curl)", async () => {
    registerMcpServer("bad-cmd-curl", { command: "curl", args: ["http://evil.com"] });

    await expect(mcpCall("bad-cmd-curl", "tool", {})).rejects.toThrow("disallowed command");
  });

  it("rejects command with path prefix (/usr/bin/bash)", async () => {
    registerMcpServer("bad-cmd-path", { command: "/usr/bin/bash", args: [] });

    await expect(mcpCall("bad-cmd-path", "tool", {})).rejects.toThrow("disallowed command");
  });

  it("allows node command", async () => {
    registerMcpServer("ok-node", { command: "node", args: ["server.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("ok-node", "tool", {});
    expect(result).toBe("ok");
  });

  it("allows npx command", async () => {
    registerMcpServer("ok-npx", { command: "npx", args: ["-y", "pkg"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("ok-npx", "tool", {});
    expect(result).toBe("ok");
  });

  it("allows python3 command", async () => {
    registerMcpServer("ok-py3", { command: "python3", args: ["server.py"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("ok-py3", "tool", {});
    expect(result).toBe("ok");
  });

  it("allows uvx command", async () => {
    registerMcpServer("ok-uvx", { command: "uvx", args: ["mcp-server"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("ok-uvx", "tool", {});
    expect(result).toBe("ok");
  });

  it("allows docker command", async () => {
    registerMcpServer("ok-docker", { command: "docker", args: ["run", "server"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("ok-docker", "tool", {});
    expect(result).toBe("ok");
  });

  it("error message includes list of allowed commands", async () => {
    registerMcpServer("bad-cmd-info", { command: "ruby", args: ["server.rb"] });

    try {
      await mcpCall("bad-cmd-info", "tool", {});
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("Allowed:");
      expect(err.message).toContain("node");
      expect(err.message).toContain("npx");
      expect(err.message).toContain("python");
    }
  });
});

// ─── Env sanitization ────────────────────────────────────────────────────────

describe("Env sanitization", () => {
  it("blocks PATH env var", async () => {
    registerMcpServer("env-path", {
      command: "node",
      args: ["s.js"],
      env: { PATH: "/evil/bin", SAFE_KEY: "safe" },
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-path", "tool", {});

    // The transport should have been created with SAFE_KEY but not the overridden PATH
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transportCall = (StdioClientTransport as any).mock.calls.at(-1)[0];
    expect(transportCall.env.SAFE_KEY).toBe("safe");
    // PATH should come from process.env, not from the config
    expect(transportCall.env.PATH).toBe(process.env.PATH);
  });

  it("blocks HOME env var", async () => {
    registerMcpServer("env-home", {
      command: "node",
      args: ["s.js"],
      env: { HOME: "/evil/home", LEGIT_VAR: "ok" },
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-home", "tool", {});

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transportCall = (StdioClientTransport as any).mock.calls.at(-1)[0];
    expect(transportCall.env.LEGIT_VAR).toBe("ok");
  });

  it("blocks NODE_OPTIONS env var", async () => {
    registerMcpServer("env-nodeopts", {
      command: "node",
      args: ["s.js"],
      env: { NODE_OPTIONS: "--require malicious.js", API_KEY: "safe" },
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-nodeopts", "tool", {});

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transportCall = (StdioClientTransport as any).mock.calls.at(-1)[0];
    expect(transportCall.env.API_KEY).toBe("safe");
  });

  it("blocks LD_PRELOAD env var", async () => {
    registerMcpServer("env-ldpreload", {
      command: "node",
      args: ["s.js"],
      env: { LD_PRELOAD: "/evil/lib.so", TOKEN: "abc" },
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-ldpreload", "tool", {});

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transportCall = (StdioClientTransport as any).mock.calls.at(-1)[0];
    expect(transportCall.env.TOKEN).toBe("abc");
  });

  it("blocks DYLD_INSERT_LIBRARIES env var", async () => {
    registerMcpServer("env-dyld", {
      command: "node",
      args: ["s.js"],
      env: { DYLD_INSERT_LIBRARIES: "/evil/lib.dylib", GOOD: "val" },
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-dyld", "tool", {});

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transportCall = (StdioClientTransport as any).mock.calls.at(-1)[0];
    expect(transportCall.env.GOOD).toBe("val");
  });
});

// ─── Dangerous args validation ───────────────────────────────────────────────

describe("Dangerous args validation", () => {
  it("rejects --eval arg", async () => {
    registerMcpServer("bad-eval", { command: "node", args: ["--eval", "process.exit(1)"] });
    await expect(mcpCall("bad-eval", "tool", {})).rejects.toThrow("dangerous arg");
  });

  it("rejects -e arg", async () => {
    registerMcpServer("bad-e", { command: "node", args: ["-e", "console.log(1)"] });
    await expect(mcpCall("bad-e", "tool", {})).rejects.toThrow("dangerous arg");
  });

  it("rejects -c arg", async () => {
    registerMcpServer("bad-c", { command: "python", args: ["-c", "import os"] });
    await expect(mcpCall("bad-c", "tool", {})).rejects.toThrow("dangerous arg");
  });

  it("rejects --exec arg", async () => {
    registerMcpServer("bad-exec", { command: "node", args: ["--exec", "malicious.js"] });
    await expect(mcpCall("bad-exec", "tool", {})).rejects.toThrow("dangerous arg");
  });

  it("rejects --import arg", async () => {
    registerMcpServer("bad-import", { command: "node", args: ["--import", "evil.mjs"] });
    await expect(mcpCall("bad-import", "tool", {})).rejects.toThrow("dangerous arg");
  });

  it("allows safe args", async () => {
    registerMcpServer("safe-args", {
      command: "node",
      args: ["--max-old-space-size=4096", "server.js", "--port", "3000"],
    });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("safe-args", "tool", {});
    expect(result).toBe("ok");
  });
});

// ─── getMcpConfig ────────────────────────────────────────────────────────────

describe("getMcpConfig", () => {
  it("returns currently registered servers as plain object", () => {
    registerMcpServer("cfg-a", { command: "node", args: ["a.js"] });
    registerMcpServer("cfg-b", { command: "npx", args: ["-y", "b"] });

    const config = getMcpConfig();
    expect(config["cfg-a"]).toBeDefined();
    expect(config["cfg-a"].command).toBe("node");
    expect(config["cfg-b"]).toBeDefined();
    expect(config["cfg-b"].command).toBe("npx");
  });
});

// ─── saveMcpConfig ───────────────────────────────────────────────────────────

describe("saveMcpConfig", () => {
  it("writes config to disk", async () => {
    const configPath = path.join(tmpDir, "occ-mcp-servers.json");
    process.env.MCP_SERVERS_CONFIG = configPath;

    await saveMcpConfig({
      "saved-srv": { command: "node", args: ["saved.js"] },
    });

    expect(fs.existsSync(configPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw["saved-srv"]).toBeDefined();
    expect(raw["saved-srv"].command).toBe("node");
  });

  it("updates in-memory registry after save", async () => {
    process.env.MCP_SERVERS_CONFIG = path.join(tmpDir, "occ-mcp-servers.json");

    await saveMcpConfig({
      "new-srv": { command: "npx", args: ["-y", "new-pkg"] },
    });

    expect(getConfiguredServers()).toContain("new-srv");
  });

  it("removes servers no longer in config", async () => {
    process.env.MCP_SERVERS_CONFIG = path.join(tmpDir, "occ-mcp-servers.json");

    registerMcpServer("old-srv", { command: "node", args: ["old.js"] });
    expect(getConfiguredServers()).toContain("old-srv");

    // Save config without old-srv
    await saveMcpConfig({
      "replacement-srv": { command: "node", args: ["new.js"] },
    });

    expect(getConfiguredServers()).toContain("replacement-srv");
    // old-srv should be gone from in-memory registry
    expect(getConfiguredServers()).not.toContain("old-srv");
  });

  it("closes active clients for removed servers", async () => {
    process.env.MCP_SERVERS_CONFIG = path.join(tmpDir, "occ-mcp-servers.json");

    // Register and connect a server
    registerMcpServer("to-remove", { command: "node", args: ["s.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await mcpCall("to-remove", "tool", {});

    // Now save config without this server
    mockClose.mockResolvedValue(undefined);
    await saveMcpConfig({
      "kept-srv": { command: "node", args: ["kept.js"] },
    });

    expect(mockClose).toHaveBeenCalled();
  });
});
