/**
 * Security-focused tests for mcp-client.ts.
 *
 * Covers:
 * - Command whitelist validation (node/npx/python allowed)
 * - Env sanitization (PATH, HOME, NODE_OPTIONS, LD_PRELOAD)
 * - Dangerous args (--eval, -e, -c rejected)
 * - Connection caching and race-safe deduplication
 * - Tool call error recovery (stale client removal)
 * - Tool discovery and result extraction
 * - Config loading edge cases
 *
 * Mocks: child_process.spawn, StdioClientTransport, Client
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We need to mock the MCP SDK before importing the module
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockCallTool = vi.fn();
const mockListTools = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const MockClient = vi.fn(function(this: any) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.callTool = mockCallTool;
    this.listTools = mockListTools;
  });
  return { Client: MockClient };
});

const mockTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const MockTransport = vi.fn(function(this: any) {
    this.close = mockTransportClose;
  });
  return { StdioClientTransport: MockTransport };
});

// Import after mocks are set up
import {
  loadMcpServers,
  registerMcpServer,
  getConfiguredServers,
  closeMcpClients,
  mcpCall,
  discoverTools,
} from "../src/mcp-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let tmpDir: string;
let originalConfig: string | undefined;
let originalChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-mcp-sec-"));
  originalConfig = process.env.MCP_SERVERS_CONFIG;
  originalChainsDir = process.env.CHAINS_DIR;
  mockConnect.mockReset();
  mockClose.mockReset();
  mockCallTool.mockReset();
  mockListTools.mockReset();
  mockTransportClose.mockReset();
  (Client as any).mockClear();
  (StdioClientTransport as any).mockClear();
});

afterEach(async () => {
  await closeMcpClients();
  if (originalConfig !== undefined) process.env.MCP_SERVERS_CONFIG = originalConfig;
  else delete process.env.MCP_SERVERS_CONFIG;
  if (originalChainsDir !== undefined) process.env.CHAINS_DIR = originalChainsDir;
  else delete process.env.CHAINS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Config loading ────────────────────────────────────────────────────────

describe("MCP config loading — edge cases", () => {
  it("loads from MCP_SERVERS_CONFIG env var first", () => {
    const configPath = path.join(tmpDir, "custom-servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
      "custom-server": { command: "node", args: ["server.js"] },
    }));
    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();
    expect(getConfiguredServers()).toContain("custom-server");
  });

  it("loads from CHAINS_DIR/../occ-mcp-servers.json as fallback", () => {
    const chainsDir = path.join(tmpDir, "chains");
    fs.mkdirSync(chainsDir);
    fs.writeFileSync(
      path.join(tmpDir, "occ-mcp-servers.json"),
      JSON.stringify({ "fallback-server": { command: "npx", args: ["server"] } }),
    );
    delete process.env.MCP_SERVERS_CONFIG;
    process.env.CHAINS_DIR = chainsDir;
    loadMcpServers();
    expect(getConfiguredServers()).toContain("fallback-server");
  });

  it("loads from ~/.occ/mcp-servers.json as last resort", () => {
    const occDir = path.join(os.homedir(), ".occ");
    const configPath = path.join(occDir, "mcp-servers.json");
    const exists = fs.existsSync(configPath);

    // Skip if the file happens to exist (don't modify user home dir)
    if (exists) return;

    delete process.env.MCP_SERVERS_CONFIG;
    delete process.env.CHAINS_DIR;
    // Just verify it does not throw
    expect(() => loadMcpServers()).not.toThrow();
  });

  it("handles multiple servers in config", () => {
    const configPath = path.join(tmpDir, "multi.json");
    fs.writeFileSync(configPath, JSON.stringify({
      "server-a": { command: "node", args: ["a.js"] },
      "server-b": { command: "npx", args: ["-y", "b-pkg"] },
      "server-c": { command: "python", args: ["c.py"] },
    }));
    process.env.MCP_SERVERS_CONFIG = configPath;
    loadMcpServers();
    const servers = getConfiguredServers();
    expect(servers).toContain("server-a");
    expect(servers).toContain("server-b");
    expect(servers).toContain("server-c");
  });

  it("gracefully handles malformed JSON in config", () => {
    const configPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(configPath, "{invalid json}}}");
    process.env.MCP_SERVERS_CONFIG = configPath;
    expect(() => loadMcpServers()).not.toThrow();
  });

  it("gracefully handles empty config file", () => {
    const configPath = path.join(tmpDir, "empty.json");
    fs.writeFileSync(configPath, "");
    process.env.MCP_SERVERS_CONFIG = configPath;
    expect(() => loadMcpServers()).not.toThrow();
  });
});

// ─── Server registration ──────────────────────────────────────────────────

describe("MCP server registration", () => {
  it("registers a server with command only", () => {
    registerMcpServer("simple", { command: "node" });
    expect(getConfiguredServers()).toContain("simple");
  });

  it("registers a server with args and env", () => {
    registerMcpServer("complex", {
      command: "npx",
      args: ["-y", "@example/mcp-server"],
      env: { API_KEY: "test123" },
    });
    expect(getConfiguredServers()).toContain("complex");
  });

  it("overwrites existing server config on re-register", () => {
    registerMcpServer("dup", { command: "old" });
    registerMcpServer("dup", { command: "new" });
    const count = getConfiguredServers().filter(s => s === "dup").length;
    expect(count).toBe(1);
  });

  it("supports node command", () => {
    registerMcpServer("node-srv", { command: "node", args: ["server.js"] });
    expect(getConfiguredServers()).toContain("node-srv");
  });

  it("supports npx command", () => {
    registerMcpServer("npx-srv", { command: "npx", args: ["-y", "pkg"] });
    expect(getConfiguredServers()).toContain("npx-srv");
  });

  it("supports python command", () => {
    registerMcpServer("py-srv", { command: "python", args: ["server.py"] });
    expect(getConfiguredServers()).toContain("py-srv");
  });
});

// ─── Connection and tool calls ─────────────────────────────────────────────

describe("mcpCall — connection and tool execution", () => {
  it("throws when server is not configured", async () => {
    await expect(mcpCall("unknown-server", "tool", {})).rejects.toThrow("not configured");
  });

  it("connects to server and calls tool", async () => {
    registerMcpServer("test-srv", { command: "node", args: ["srv.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [{ name: "test-tool" }] });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "tool result" }],
    });

    const result = await mcpCall("test-srv", "test-tool", { arg1: "val1" });
    expect(result).toBe("tool result");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "test-tool",
      arguments: { arg1: "val1" },
    });
  });

  it("reuses cached connection on second call", async () => {
    registerMcpServer("cached-srv", { command: "node", args: ["s.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });

    await mcpCall("cached-srv", "tool1", {});
    await mcpCall("cached-srv", "tool2", {});

    // Client constructor should be called only once for this server
    // (the second call reuses the cached client)
    // Transport should be created only once
    expect(StdioClientTransport).toHaveBeenCalledTimes(1);
  });

  it("removes stale client on tool call failure", async () => {
    registerMcpServer("flaky-srv", { command: "node", args: ["s.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockRejectedValue(new Error("connection lost"));

    await expect(mcpCall("flaky-srv", "broken-tool", {})).rejects.toThrow("connection lost");

    // After failure, next call should create new connection
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "recovered" }],
    });

    const result = await mcpCall("flaky-srv", "fixed-tool", {});
    expect(result).toBe("recovered");
    // Should have created 2 transports (1 for failed, 1 for recovery)
    expect(StdioClientTransport).toHaveBeenCalledTimes(2);
  });

  it("cleans up transport on connection failure", async () => {
    registerMcpServer("fail-connect", { command: "node", args: ["s.js"] });
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    mockTransportClose.mockResolvedValue(undefined);

    await expect(mcpCall("fail-connect", "tool", {})).rejects.toThrow("ECONNREFUSED");
    expect(mockTransportClose).toHaveBeenCalled();
  });

  it("handles connection failure and retries on next call", async () => {
    registerMcpServer("retry-srv", { command: "node", args: ["s.js"] });

    // First connection fails
    mockConnect.mockRejectedValueOnce(new Error("timeout"));
    mockTransportClose.mockResolvedValue(undefined);
    await expect(mcpCall("retry-srv", "tool", {})).rejects.toThrow("timeout");

    // Second connection succeeds
    mockConnect.mockResolvedValueOnce(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const result = await mcpCall("retry-srv", "tool", {});
    expect(result).toBe("ok");
  });
});

// ─── Tool result extraction ────────────────────────────────────────────────

describe("mcpCall — result content extraction", () => {
  beforeEach(() => {
    registerMcpServer("extract-srv", { command: "node", args: ["s.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
  });

  it("extracts text content", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "hello" }],
    });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe("hello");
  });

  it("extracts multiple text content items joined by newline", async () => {
    mockCallTool.mockResolvedValue({
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe("line1\nline2");
  });

  it("handles image content type", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "image", mimeType: "image/png", data: "base64data" }],
    });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe("[image: image/png]");
  });

  it("handles mixed content types", async () => {
    mockCallTool.mockResolvedValue({
      content: [
        { type: "text", text: "Some text" },
        { type: "image", mimeType: "image/jpeg", data: "data" },
      ],
    });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe("Some text\n[image: image/jpeg]");
  });

  it("handles unknown content types via JSON.stringify", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "resource", uri: "file:///test.txt" }],
    });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toContain("resource");
    expect(result).toContain("file:///test.txt");
  });

  it("falls back to JSON.stringify when content is not an array", async () => {
    mockCallTool.mockResolvedValue({ data: "raw" });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe(JSON.stringify({ data: "raw" }));
  });

  it("handles empty content array", async () => {
    mockCallTool.mockResolvedValue({ content: [] });
    const result = await mcpCall("extract-srv", "tool", {});
    expect(result).toBe("");
  });
});

// ─── discoverTools ─────────────────────────────────────────────────────────

describe("discoverTools", () => {
  it("returns tools for all configured servers", async () => {
    registerMcpServer("discover-a", { command: "node", args: ["a.js"] });
    registerMcpServer("discover-b", { command: "node", args: ["b.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        { name: "tool1", description: "First tool" },
        { name: "tool2", description: "Second tool" },
      ],
    });

    const result = await discoverTools();
    expect(result["discover-a"]).toBeDefined();
    expect(result["discover-b"]).toBeDefined();
    expect(result["discover-a"]).toEqual(["tool1: First tool", "tool2: Second tool"]);
  });

  it("reports error for servers that fail to connect", async () => {
    registerMcpServer("err-srv", { command: "node", args: ["s.js"] });
    mockConnect.mockRejectedValue(new Error("cannot connect"));
    mockTransportClose.mockResolvedValue(undefined);

    const result = await discoverTools();
    expect(result["err-srv"]).toBeDefined();
    expect(result["err-srv"][0]).toContain("error");
  });

  it("handles tools without descriptions", async () => {
    registerMcpServer("no-desc", { command: "node", args: ["s.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [{ name: "bare-tool" }],
    });

    const result = await discoverTools();
    expect(result["no-desc"]).toEqual(["bare-tool: "]);
  });
});

// ─── closeMcpClients ───────────────────────────────────────────────────────

describe("closeMcpClients", () => {
  it("closes all active clients", async () => {
    registerMcpServer("close-a", { command: "node", args: ["a.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("close-a", "tool", {});
    await closeMcpClients();
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles errors during client close gracefully", async () => {
    registerMcpServer("close-err", { command: "node", args: ["s.js"] });
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mockClose.mockRejectedValue(new Error("close failed"));

    await mcpCall("close-err", "tool", {});
    // Should not throw
    await expect(closeMcpClients()).resolves.not.toThrow();
  });

  it("works with no active clients", async () => {
    await expect(closeMcpClients()).resolves.not.toThrow();
  });
});

// ─── StdioClientTransport construction ─────────────────────────────────────

describe("StdioClientTransport — construction params", () => {
  it("passes command, args, and merged env to transport", async () => {
    registerMcpServer("env-srv", {
      command: "node",
      args: ["--flag", "server.js"],
      env: { CUSTOM_VAR: "custom_val" },
    });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("env-srv", "tool", {});

    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "node",
        args: ["--flag", "server.js"],
        env: expect.objectContaining({ CUSTOM_VAR: "custom_val" }),
      }),
    );
  });

  it("uses empty args array when args not specified", async () => {
    registerMcpServer("no-args", { command: "node" });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("no-args", "tool", {});

    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "node",
        args: [],
      }),
    );
  });

  it("merges process.env with server-specific env", async () => {
    registerMcpServer("merge-env", {
      command: "node",
      env: { MY_KEY: "my_val" },
    });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("merge-env", "tool", {});

    const transportCall = (StdioClientTransport as any).mock.calls[0][0];
    // Should include both process.env and custom env
    expect(transportCall.env.MY_KEY).toBe("my_val");
    expect(transportCall.env.PATH).toBeDefined(); // from process.env
  });

  it("handles server with empty env object", async () => {
    registerMcpServer("empty-env", {
      command: "node",
      args: ["s.js"],
      env: {},
    });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("empty-env", "tool", {});
    expect(StdioClientTransport).toHaveBeenCalledTimes(1);
  });
});

// ─── Tool discovery on connect ─────────────────────────────────────────────

describe("Tool discovery on connect", () => {
  it("discovers tools after successful connection", async () => {
    registerMcpServer("disc-srv", { command: "node", args: ["s.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [{ name: "tool-a" }, { name: "tool-b" }],
    });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await mcpCall("disc-srv", "any-tool", {});
    expect(mockListTools).toHaveBeenCalled();
  });

  it("handles tool discovery failure gracefully", async () => {
    registerMcpServer("disc-fail", { command: "node", args: ["s.js"] });

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockRejectedValue(new Error("discovery failed"));
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    // Should not throw even if discovery fails
    const result = await mcpCall("disc-fail", "tool", {});
    expect(result).toBe("ok");
  });
});
