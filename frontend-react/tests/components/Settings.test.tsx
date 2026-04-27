import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Mock CSS modules
vi.mock("../../src/components/settings/Settings.module.css", () => ({
  default: new Proxy(
    {},
    { get: (_target, prop) => (typeof prop === "string" ? prop : "") },
  ),
}));

// Mock useServerStore
vi.mock("../../src/stores/server", () => ({
  useServerStore: vi.fn(() => ({
    occServerUrl: "http://localhost:4242",
    serverOnline: true,
    apiKey: null,
    setServerUrl: vi.fn(),
    setApiKey: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue(true),
  })),
}));

// Mock useShortcutStore
vi.mock("../../src/stores/shortcuts", () => ({
  useShortcutStore: vi.fn(() => ({
    shortcuts: [],
    getCombo: vi.fn(() => ({ key: "k", mod: true })),
    matches: vi.fn(),
    setCombo: vi.fn(),
    resetAll: vi.fn(),
  })),
  formatCombo: vi.fn(() => "Cmd+K"),
}));

// Mock createPortal since JSDOM doesn't fully support it
vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
Object.defineProperty(globalThis, "IntersectionObserver", { value: MockIntersectionObserver });

// Mock AbortSignal.timeout if missing
if (!AbortSignal.timeout) {
  AbortSignal.timeout = () => new AbortSignal();
}

// Mock ReadableStream for body.getReader() used in OllamaSection
class MockReadableStreamReader {
  private done = false;
  async read() {
    if (!this.done) {
      this.done = true;
      return { done: true, value: undefined };
    }
    return { done: true, value: undefined };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const mockHealthData = {
  ok: true,
  version: "3.0.0",
  uptime: 3600,
  runningExecutions: 0,
  queuedJobs: 0,
  chainsDir: "./chains",
  pipelinesDir: "./pipelines",
  workspaceDir: "./workspace",
  restPort: 4242,
  mcpServers: ["github", "filesystem"],
  claudeCli: "claude",
  nodeVersion: "v22.0.0",
  platform: "darwin",
  arch: "arm64",
  pid: 12345,
  memoryMB: 100,
  chainCount: 5,
  pipelineCount: 2,
};

const mockQueueStats = { queued: 0, running: 1, done: 10, errored: 0, workers: 5 };

const mockConfig = {
  chainsDir: "./chains",
  pipelinesDir: "./pipelines",
  workspaceDir: "./workspace",
  claudeTimeoutMs: "1800000",
  maxConcurrentExecutions: "5",
  corsOrigin: "*",
  logLevel: "info",
  claudeCli: "claude",
  occDb: "./occ.db",
  occQueueDb: "./occ-queue.db",
  occStateDb: "./occ-state.db",
  occVectorDb: "./occ-vector.db",
  occSemanticCacheDb: "./occ-semantic-cache.db",
  occGraphDb: "./occ-graph.db",
  logFormat: "text",
  blobDir: "./blob",
  blobPlanningModel: "haiku",
  blobChatModel: "haiku",
  blobStepModel: "haiku",
  blobAutoCheckSec: "300",
  workflowChatModel: "haiku",
  workflowPlannerModel: "haiku",
  rateLimitExec: "10",
  rateLimitGen: "10",
  executionMaxAgeDays: "7",
  publicHost: "",
  maxContextChars: "50000",
  maxChatContextChars: "8000",
  resendApiKey: "",
  resendFrom: "",
};

const mockProviders = [
  {
    id: "claude",
    name: "Anthropic (Claude CLI)",
    type: "claude",
    apiKey: "",
    baseUrl: "",
    defaultModel: "claude-sonnet-4-6",
    enabled: true,
    models: ["claude-opus-4-6", "claude-sonnet-4-6"],
    createdAt: "",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openrouter",
    apiKey: "sk-or-v1-test",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o",
    enabled: true,
    models: ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
    createdAt: "2024-01-01",
  },
];

const mockSchedules = [
  {
    id: "sched-1",
    label: "Daily Research",
    chainName: "deep-researcher",
    cron: "0 9 * * *",
    enabled: true,
    lastRunStatus: "success",
    lastRunAt: "2024-01-01T09:00:00Z",
  },
];

const mockChains = [
  { name: "deep-researcher", description: "Research chain", stepCount: 5 },
  { name: "code-review", description: "Code review", stepCount: 3 },
];

const mockPipelines = [
  { name: "my-pipeline", description: "A pipeline", chainCount: 2 },
];

const mockMcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "test" } },
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
};

const mockExecutions = [
  { id: "exec-1", chainName: "deep-researcher", status: "completed", startedAt: "2024-01-01T09:00:00Z", durationMs: 5000 },
];

const mockTokenUsage = {
  days: 30,
  totals: { input: 50000, output: 30000, executions: 20 },
  daily: [
    {
      date: "2024-01-01",
      chains: { input: 5000, output: 3000, count: 2 },
      pipelines: { input: 1000, output: 500, count: 1 },
      blob: { input: 500, output: 200, count: 1 },
      workflowChat: { input: 300, output: 100, count: 1 },
      // Settings.SOURCES now includes "agentChat" — TokenDashboard reads
      // d[src].input/output for every source, so missing keys crash the chart.
      agentChat: { input: 200, output: 50, count: 1 },
    },
  ],
  topChains: [
    { name: "deep-researcher", input: 10000, output: 5000, count: 5, total: 15000 },
  ],
};

const mockProviderModels = [
  { provider: "claude", providerName: "Anthropic", model: "claude-sonnet-4-6" },
  { provider: "openrouter", providerName: "OpenRouter", model: "openai/gpt-4o" },
];

function setupFetchMock(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    "/health": mockHealthData,
    "/queue": mockQueueStats,
    "/config": mockConfig,
    "/providers": mockProviders,
    "/providers/models": mockProviderModels,
    "/schedules": mockSchedules,
    "/chains": mockChains,
    "/pipelines": mockPipelines,
    "/mcp-servers": mockMcpServers,
    "/executions?limit=200": mockExecutions,
    "/executions/token-usage-detailed?days=30": mockTokenUsage,
    "/ollama/status": { online: false, models: 0, host: "http://localhost:11434" },
    "/ollama/models": [],
  };

  const responses = { ...defaults, ...overrides };

  (globalThis.fetch as Mock).mockImplementation(async (url: string, opts?: RequestInit) => {
    // Extract path from URL
    const path = typeof url === "string" ? url.split("?")[0] : "";
    const fullPath = typeof url === "string" ? url : "";

    // Check full path first (for query string matches), then base path
    const data = responses[fullPath] ?? responses[path];

    if (data !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
        body: {
          getReader: () => new MockReadableStreamReader(),
        },
      };
    }

    // Default: return 404
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "Not Found",
    };
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.fetch = vi.fn();
  globalThis.confirm = vi.fn(() => true);
  localStorage.clear();
});

import { Settings } from "../../src/components/settings/Settings";
import { ProviderSection } from "../../src/components/settings/ProviderSection";
import { McpSection } from "../../src/components/settings/McpSection";
import { ScheduleSection } from "../../src/components/settings/ScheduleSection";
import { OllamaSection } from "../../src/components/settings/OllamaSection";
import { ItemListManager } from "../../src/components/settings/ItemListManager";

// ═══════════════════════════════════════════════════════════════════════════
// Settings (main)
// ═══════════════════════════════════════════════════════════════════════════

describe("Settings", () => {
  it("renders the page title", async () => {
    setupFetchMock();
    render(<Settings />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders TOC sidebar with section links", async () => {
    setupFetchMock();
    render(<Settings />);
    // TOC uses nav element — check links within it
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Server")).toBeInTheDocument();
    expect(within(nav).getByText("Execution")).toBeInTheDocument();
    expect(within(nav).getByText("Providers")).toBeInTheDocument();
    expect(within(nav).getByText("Ollama")).toBeInTheDocument();
    expect(within(nav).getByText("HuggingFace")).toBeInTheDocument();
    expect(within(nav).getByText("Queue")).toBeInTheDocument();
    expect(within(nav).getByText("Schedules")).toBeInTheDocument();
    expect(within(nav).getByText("MCP Servers")).toBeInTheDocument();
    expect(within(nav).getByText("Interface")).toBeInTheDocument();
    expect(within(nav).getByText("About")).toBeInTheDocument();
    expect(within(nav).getByText("Token Usage")).toBeInTheDocument();
    expect(within(nav).getByText("Shortcuts")).toBeInTheDocument();
  });

  it("renders Server Connection section", async () => {
    setupFetchMock();
    render(<Settings />);
    expect(screen.getByText("Server Connection")).toBeInTheDocument();
  });

  it("shows server status as Online when connected", async () => {
    setupFetchMock();
    render(<Settings />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("renders Execution section title", async () => {
    setupFetchMock();
    render(<Settings />);
    // Multiple "Execution" texts (TOC + section title) — just check at least one exists
    const matches = screen.getAllByText("Execution");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders LLM Providers section with count", async () => {
    setupFetchMock();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/LLM Providers/)).toBeInTheDocument();
    });
  });

  it("fetches health, config, providers on mount", async () => {
    setupFetchMock();
    render(<Settings />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/health"),
        expect.anything(),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/config"),
        expect.anything(),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/providers"),
        expect.anything(),
      );
    });
  });

  it("renders the server URL input with default value", async () => {
    setupFetchMock();
    render(<Settings />);
    const urlInput = screen.getByPlaceholderText("http://localhost:4242");
    expect(urlInput).toBeInTheDocument();
    expect(urlInput).toHaveValue("http://localhost:4242");
  });

  it("renders Test button for connection testing", async () => {
    setupFetchMock();
    render(<Settings />);
    // There are multiple "Test" buttons (one for connection, one per provider)
    const testButtons = screen.getAllByText("Test");
    expect(testButtons.length).toBeGreaterThan(0);
  });

  it("renders execution config fields after loading", async () => {
    setupFetchMock();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Max Concurrent Executions")).toBeInTheDocument();
      expect(screen.getByText("Claude Timeout (ms)")).toBeInTheDocument();
      expect(screen.getByText("Log Level")).toBeInTheDocument();
    });
  });

  it("renders Ollama section title", async () => {
    setupFetchMock();
    render(<Settings />);
    const matches = screen.getAllByText(/Ollama/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders HuggingFace section title", async () => {
    setupFetchMock();
    render(<Settings />);
    const matches = screen.getAllByText(/HuggingFace/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the Auto-connect SSE toggle", async () => {
    setupFetchMock();
    render(<Settings />);
    expect(screen.getByText("Auto-connect SSE")).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProviderSection
// ═══════════════════════════════════════════════════════════════════════════

describe("ProviderSection", () => {
  it("renders provider list after loading", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText(/LLM Providers/)).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    setupFetchMock();
    render(<ProviderSection />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders installed providers with their names", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("Anthropic (Claude CLI)")).toBeInTheDocument();
      expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    });
  });

  it("shows Built-in badge for Claude provider", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("Built-in")).toBeInTheDocument();
    });
  });

  it("shows provider metadata (type, key status, model count)", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText(/claude.*CLI.*2 models/)).toBeInTheDocument();
      expect(screen.getByText(/openrouter.*Key set.*2 models/)).toBeInTheDocument();
    });
  });

  it("renders Test button for each provider", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      const testButtons = screen.getAllByText("Test");
      expect(testButtons.length).toBe(2);
    });
  });

  it("shows + Add Provider button", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("+ Add Provider")).toBeInTheDocument();
    });
  });

  it("clicking + Add Provider shows presets", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("+ Add Provider")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("+ Add Provider"));
    // OpenAI, Groq, Together, Mistral should appear (OpenRouter is already installed)
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
      expect(screen.getByText("Groq")).toBeInTheDocument();
    });
  });

  it("clicking Set Up shows API key input for preset", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => expect(screen.getByText("+ Add Provider")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ Add Provider"));
    await waitFor(() => expect(screen.getAllByText("Set Up").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Set Up")[0]);
    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });
  });

  it("handles provider test flow", async () => {
    setupFetchMock({
      "/providers/claude/test": { ok: true, models: ["claude-sonnet-4-6"] },
    });
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getAllByText("Test").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText("Test")[0]);
    await waitFor(() => {
      expect(screen.getByText("Testing...")).toBeInTheDocument();
    });
  });

  it("clicking edit button opens edit form", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      // edit buttons are the pencil icons
      expect(screen.getAllByText("\u270E").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText("\u270E")[0]);
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });
  });

  it("does not show delete button for built-in Claude provider", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("Anthropic (Claude CLI)")).toBeInTheDocument();
    });
    // The delete button (✖) should appear for OpenRouter but not Claude
    const deleteButtons = screen.getAllByText("\u2716");
    // Only 1 delete button (for OpenRouter), not 2
    expect(deleteButtons.length).toBe(1);
  });

  it("shows provider models when enabled", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      // Model pills show short names (after /)
      expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
      expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    });
  });

  it("renders Provider Presets item list manager", async () => {
    setupFetchMock();
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("Provider Presets")).toBeInTheDocument();
      expect(screen.getByText("Group providers into switchable configurations")).toBeInTheDocument();
    });
  });

  it("shows fallback Claude provider when fetch returns empty", async () => {
    setupFetchMock({ "/providers": [] });
    render(<ProviderSection />);
    await waitFor(() => {
      expect(screen.getByText("Anthropic (Claude CLI)")).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// McpSection
// ═══════════════════════════════════════════════════════════════════════════

describe("McpSection", () => {
  it("renders MCP Servers title with count", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText(/MCP Servers/)).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    setupFetchMock();
    render(<McpSection />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders installed servers after loading", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText("github")).toBeInTheDocument();
      expect(screen.getByText("filesystem")).toBeInTheDocument();
    });
  });

  it("shows server commands in metadata", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText(/npx -y @modelcontextprotocol\/server-github/)).toBeInTheDocument();
    });
  });

  it("shows env var count for servers with env", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText(/1 env vars/)).toBeInTheDocument();
    });
  });

  it("shows Marketplace button", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText("Marketplace")).toBeInTheDocument();
    });
  });

  it("shows + Custom button", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText("+ Custom")).toBeInTheDocument();
    });
  });

  it("clicking + Custom shows custom add form", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText("+ Custom")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ Custom"));
    await waitFor(() => {
      expect(screen.getByText("Add Custom MCP Server")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("my-server")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("npx")).toBeInTheDocument();
    });
  });

  it("shows remove button for each installed server", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      // ✖ buttons for remove
      const removeButtons = screen.getAllByTitle("Remove");
      expect(removeButtons.length).toBe(2);
    });
  });

  it("shows configure button for each installed server", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      const configButtons = screen.getAllByTitle("Configure");
      expect(configButtons.length).toBe(2);
    });
  });

  it("clicking configure shows edit form", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => expect(screen.getAllByTitle("Configure").length).toBe(2));
    fireEvent.click(screen.getAllByTitle("Configure")[0]);
    await waitFor(() => {
      expect(screen.getByText(/Configure: github/)).toBeInTheDocument();
    });
  });

  it("shows empty state when no servers installed", async () => {
    setupFetchMock({ "/mcp-servers": {} });
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText("No MCP servers installed")).toBeInTheDocument();
      expect(screen.getByText("Browse the marketplace to add tools")).toBeInTheDocument();
    });
  });

  it("renders Server Presets item list manager", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => {
      expect(screen.getByText("Server Presets")).toBeInTheDocument();
    });
  });

  it("handles server removal with confirmation", async () => {
    setupFetchMock();
    render(<McpSection />);
    await waitFor(() => expect(screen.getAllByTitle("Remove").length).toBe(2));
    fireEvent.click(screen.getAllByTitle("Remove")[0]);
    expect(globalThis.confirm).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ScheduleSection
// ═══════════════════════════════════════════════════════════════════════════

describe("ScheduleSection", () => {
  it("renders Scheduled Jobs title with count", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText(/Scheduled Jobs/)).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    setupFetchMock();
    render(<ScheduleSection />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders schedules after loading", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText("Daily Research")).toBeInTheDocument();
    });
  });

  it("shows schedule metadata (chain name, cron description)", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText(/deep-researcher/)).toBeInTheDocument();
      expect(screen.getByText("Every day at 9am")).toBeInTheDocument();
    });
  });

  it("shows + New Schedule button", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText("+ New Schedule")).toBeInTheDocument();
    });
  });

  it("clicking + New Schedule shows form", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => expect(screen.getByText("+ New Schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ New Schedule"));
    await waitFor(() => {
      expect(screen.getByText("New Schedule")).toBeInTheDocument();
      expect(screen.getByText("Chain / Pipeline")).toBeInTheDocument();
      expect(screen.getByText("Frequency")).toBeInTheDocument();
    });
  });

  it("shows cron presets in the schedule form", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => expect(screen.getByText("+ New Schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ New Schedule"));
    await waitFor(() => {
      expect(screen.getByText("Every hour")).toBeInTheDocument();
      expect(screen.getByText("Mon-Fri at 9am")).toBeInTheDocument();
      expect(screen.getByText("Every 15 min")).toBeInTheDocument();
      expect(screen.getByText("Custom")).toBeInTheDocument();
    });
  });

  it("shows chain/pipeline selector in form", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => expect(screen.getByText("+ New Schedule")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ New Schedule"));
    await waitFor(() => {
      // The select should have chain names as options
      const select = screen.getByRole("combobox");
      expect(select).toBeInTheDocument();
    });
  });

  it("shows run now button for each schedule", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      const runButtons = screen.getAllByTitle("Run now");
      expect(runButtons.length).toBe(1);
    });
  });

  it("shows edit button for each schedule", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      const editButtons = screen.getAllByTitle("Edit");
      expect(editButtons.length).toBe(1);
    });
  });

  it("shows delete button for each schedule", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      const deleteButtons = screen.getAllByTitle("Delete");
      expect(deleteButtons.length).toBe(1);
    });
  });

  it("shows empty state when no schedules", async () => {
    setupFetchMock({ "/schedules": [] });
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText("No scheduled jobs yet")).toBeInTheDocument();
    });
  });

  it("has toggle button for enabling/disabling schedule", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      const pauseButtons = screen.getAllByTitle("Pause");
      expect(pauseButtons.length).toBe(1);
    });
  });

  it("renders Schedule Presets item list manager", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => {
      expect(screen.getByText("Schedule Presets")).toBeInTheDocument();
    });
  });

  it("clicking edit opens the schedule form with data populated", async () => {
    setupFetchMock();
    render(<ScheduleSection />);
    await waitFor(() => expect(screen.getAllByTitle("Edit").length).toBe(1));
    fireEvent.click(screen.getAllByTitle("Edit")[0]);
    await waitFor(() => {
      expect(screen.getByText("Edit Schedule")).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OllamaSection
// ═══════════════════════════════════════════════════════════════════════════

describe("OllamaSection", () => {
  it("renders Ollama status", async () => {
    setupFetchMock();
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Ollama/)).toBeInTheDocument();
    });
  });

  it("shows offline status when Ollama is not running", async () => {
    setupFetchMock({ "/ollama/status": { online: false, models: 0, host: "http://localhost:11434" } });
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Offline/)).toBeInTheDocument();
      expect(screen.getByText(/ollama serve/)).toBeInTheDocument();
    });
  });

  it("shows connected status when Ollama is running", async () => {
    setupFetchMock({
      "/ollama/status": { online: true, models: 3, host: "http://localhost:11434" },
    });
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Connected/)).toBeInTheDocument();
      expect(screen.getByText(/3 models installed/)).toBeInTheDocument();
    });
  });

  it("shows Use in chains button when online", async () => {
    setupFetchMock({
      "/ollama/status": { online: true, models: 1, host: "http://localhost:11434" },
    });
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Use in chains/)).toBeInTheDocument();
    });
  });

  it("renders installed models list", async () => {
    setupFetchMock({
      "/ollama/status": { online: true, models: 1, host: "http://localhost:11434" },
      "/ollama/models": [
        { name: "llama3.2:latest", model: "llama3.2", size: 2_000_000_000, details: { parameter_size: "2B", family: "llama" } },
      ],
    });
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText("llama3.2:latest")).toBeInTheDocument();
      expect(screen.getByText("2B")).toBeInTheDocument();
    });
  });

  it("shows Browse Model Library button", async () => {
    setupFetchMock();
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Browse Model Library/)).toBeInTheDocument();
    });
  });

  it("shows Remove button for installed models", async () => {
    setupFetchMock({
      "/ollama/status": { online: true, models: 1, host: "http://localhost:11434" },
      "/ollama/models": [
        { name: "llama3.2:latest", model: "llama3.2", size: 2_000_000_000 },
      ],
    });
    render(<OllamaSection />);
    await waitFor(() => {
      expect(screen.getByText(/Remove/)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ItemListManager
// ═══════════════════════════════════════════════════════════════════════════

describe("ItemListManager", () => {
  const defaultProps = {
    storageKey: "test-lists",
    allItemIds: ["item-a", "item-b", "item-c"],
    label: "Test Lists",
    description: "Manage test items",
  };

  it("renders label and description", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    expect(screen.getByText("Test Lists")).toBeInTheDocument();
    expect(screen.getByText("Manage test items")).toBeInTheDocument();
  });

  it("shows + New List button", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    expect(screen.getByText("+ New List")).toBeInTheDocument();
  });

  it("clicking + New List shows create form", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    expect(screen.getByPlaceholderText("List name...")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("creates a new list with all items", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    const input = screen.getByPlaceholderText("List name...");
    fireEvent.change(input, { target: { value: "My List" } });
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByText("My List")).toBeInTheDocument();
    // Shows item count
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not create a list with empty name", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.click(screen.getByText("Create"));
    // No list should appear
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("uses itemLabel function for display", () => {
    setupFetchMock();
    const itemLabel = (id: string) => `Label for ${id}`;
    render(<ItemListManager {...defaultProps} itemLabel={itemLabel} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.change(screen.getByPlaceholderText("List name..."), { target: { value: "Labeled List" } });
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByText("Label for item-a")).toBeInTheDocument();
    expect(screen.getByText("Label for item-b")).toBeInTheDocument();
    expect(screen.getByText("Label for item-c")).toBeInTheDocument();
  });

  it("can delete a list after confirmation", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.change(screen.getByPlaceholderText("List name..."), { target: { value: "Deletable" } });
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByText("Deletable")).toBeInTheDocument();
    // Click delete button (✖)
    const deleteBtn = screen.getByTitle("Delete");
    fireEvent.click(deleteBtn);
    expect(globalThis.confirm).toHaveBeenCalled();
    expect(screen.queryByText("Deletable")).not.toBeInTheDocument();
  });

  it("can cancel list creation", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    expect(screen.getByPlaceholderText("List name...")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByPlaceholderText("List name...")).not.toBeInTheDocument();
  });

  it("creates list via Enter key", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    const input = screen.getByPlaceholderText("List name...");
    fireEvent.change(input, { target: { value: "Enter List" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Enter List")).toBeInTheDocument();
  });

  it("shows rename button for existing lists", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.change(screen.getByPlaceholderText("List name..."), { target: { value: "Rename Me" } });
    fireEvent.click(screen.getByText("Create"));
    const renameBtn = screen.getByTitle("Rename");
    expect(renameBtn).toBeInTheDocument();
  });

  it("persists lists to localStorage", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.change(screen.getByPlaceholderText("List name..."), { target: { value: "Persisted" } });
    fireEvent.click(screen.getByText("Create"));
    const stored = localStorage.getItem("test-lists");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Persisted");
    expect(parsed[0].items).toEqual(["item-a", "item-b", "item-c"]);
  });

  it("can remove an item from a list", () => {
    setupFetchMock();
    render(<ItemListManager {...defaultProps} />);
    fireEvent.click(screen.getByText("+ New List"));
    fireEvent.change(screen.getByPlaceholderText("List name..."), { target: { value: "Remove Test" } });
    fireEvent.click(screen.getByText("Create"));
    // Remove item-a by clicking the x button
    const removeButtons = screen.getAllByText("\u00D7");
    expect(removeButtons.length).toBe(3);
    fireEvent.click(removeButtons[0]);
    // Now count should be 2
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
