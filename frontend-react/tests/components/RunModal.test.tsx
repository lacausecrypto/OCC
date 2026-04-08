import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/components/modals/Modal.module.css", () => ({
  default: {
    overlay: "overlay",
    modal: "modal",
    modalWide: "modalWide",
    header: "header",
    headerTitle: "headerTitle",
    closeBtn: "closeBtn",
    body: "body",
    footer: "footer",
    footerInfo: "footerInfo",
    btn: "btn",
    btnPrimary: "btnPrimary",
    badge: "badge",
    noInputs: "noInputs",
    field: "field",
    fieldLabel: "fieldLabel",
    fieldDesc: "fieldDesc",
    fieldError: "fieldError",
    input: "input",
    inputError: "inputError",
    textarea: "textarea",
    optional: "optional",
    required: "required",
    fileRow: "fileRow",
    fileBtn: "fileBtn",
    dryRunResult: "dryRunResult",
    stepOutput: "stepOutput",
  },
}));

const mockFetchChainJson = vi.fn();
const mockFetchPipelineJson = vi.fn();
const mockExecuteChain = vi.fn();
const mockExecutePipeline = vi.fn();
const mockApiPost = vi.fn();

vi.mock("../../src/api/chains", () => ({
  fetchChainJson: (...args: unknown[]) => mockFetchChainJson(...args),
}));

vi.mock("../../src/api/pipelines", () => ({
  fetchPipelineJson: (...args: unknown[]) => mockFetchPipelineJson(...args),
  executePipeline: (...args: unknown[]) => mockExecutePipeline(...args),
}));

vi.mock("../../src/api/executions", () => ({
  executeChain: (...args: unknown[]) => mockExecuteChain(...args),
}));

vi.mock("../../src/api/client", () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
}));

vi.mock("../../src/stores/server", () => ({
  useServerStore: () => ({ occServerUrl: "http://localhost:4242" }),
}));

import { RunModal } from "../../src/components/modals/RunModal";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RunModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no inputs
    mockFetchChainJson.mockResolvedValue({ inputs: [] });
    mockFetchPipelineJson.mockResolvedValue({ inputs: [] });
  });

  it("renders with chain name and RUN badge", async () => {
    render(<RunModal name="my-chain" type="chain" onClose={vi.fn()} />);
    expect(screen.getByText("my-chain")).toBeInTheDocument();
    expect(screen.getByText("RUN")).toBeInTheDocument();
  });

  it("renders with PIP badge for pipeline type", () => {
    render(<RunModal name="my-pipeline" type="pipeline" onClose={vi.fn()} />);
    expect(screen.getByText("PIP")).toBeInTheDocument();
  });

  it("shows 'No inputs required' when chain has no inputs", async () => {
    render(<RunModal name="simple" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<RunModal name="test" type="chain" onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00d7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("fetches chain inputs on mount for chain type", () => {
    render(<RunModal name="my-chain" type="chain" onClose={vi.fn()} />);
    expect(mockFetchChainJson).toHaveBeenCalledWith("my-chain", "http://localhost:4242");
  });

  it("fetches pipeline inputs on mount for pipeline type", () => {
    render(<RunModal name="my-pipe" type="pipeline" onClose={vi.fn()} />);
    expect(mockFetchPipelineJson).toHaveBeenCalledWith("my-pipe");
  });

  it("renders input fields from chain definition", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [
        { name: "topic", description: "The topic to research" },
        { name: "depth", description: "How deep", optional: true },
      ],
    });
    render(<RunModal name="research" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("topic")).toBeInTheDocument();
      expect(screen.getByText("depth")).toBeInTheDocument();
    });
    expect(screen.getByText("The topic to research")).toBeInTheDocument();
    expect(screen.getByText("(optional)")).toBeInTheDocument();
  });

  it("shows required count in footer", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [
        { name: "a" },
        { name: "b" },
        { name: "c", optional: true },
      ],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("2 required inputs")).toBeInTheDocument();
    });
  });

  it("shows '1 required input' (singular) when exactly one required", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "query" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("1 required input")).toBeInTheDocument();
    });
  });

  it("allows typing in input fields", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "topic" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("topic")).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText("topic");
    fireEvent.change(input, { target: { value: "AI safety" } });
    expect(input).toHaveValue("AI safety");
  });

  it("executes chain and calls onExecuted + onClose on success", async () => {
    mockFetchChainJson.mockResolvedValue({ inputs: [] });
    mockExecuteChain.mockResolvedValue({ executionId: "exec-123" });
    const onClose = vi.fn();
    const onExecuted = vi.fn();
    render(
      <RunModal name="test" type="chain" onClose={onClose} onExecuted={onExecuted} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(mockExecuteChain).toHaveBeenCalledWith("test", {});
      expect(onExecuted).toHaveBeenCalledWith("exec-123");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("executes pipeline when type is pipeline", async () => {
    mockFetchPipelineJson.mockResolvedValue({ inputs: [] });
    mockExecutePipeline.mockResolvedValue({ executionId: "pipe-456" });
    const onClose = vi.fn();
    const onExecuted = vi.fn();
    render(
      <RunModal name="test" type="pipeline" onClose={onClose} onExecuted={onExecuted} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(mockExecutePipeline).toHaveBeenCalledWith("test", {});
      expect(onExecuted).toHaveBeenCalledWith("pipe-456");
    });
  });

  it("shows execution error on failure", async () => {
    mockFetchChainJson.mockResolvedValue({ inputs: [] });
    mockExecuteChain.mockRejectedValue(new Error("Server down"));
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Server down")).toBeInTheDocument();
    });
  });

  it("validates required inputs before execution", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "query" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("query")).toBeInTheDocument();
    });
    // Click execute without filling required field
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Required")).toBeInTheDocument();
    });
    expect(mockExecuteChain).not.toHaveBeenCalled();
  });

  it("validates URL input type", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "website", type: "url", description: "The website" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("website")).toBeInTheDocument();
    });
    // placeholder falls back to description slice
    const input = screen.getByPlaceholderText("The website");
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Must be a valid URL")).toBeInTheDocument();
    });
  });

  it("renders number input with type=number", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "depth", type: "number" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("depth")).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText("depth");
    expect(input).toHaveAttribute("type", "number");
  });

  it("validates number min/max constraints", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "count", type: "number", min: 1, max: 10 }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("count")).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText("count");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Min: 1")).toBeInTheDocument();
    });
  });

  it("validates JSON input type", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "config", type: "json", description: "JSON config" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("config")).toBeInTheDocument();
    });
    // placeholder comes from description since it's shorter than 60 chars
    const textarea = screen.getByPlaceholderText("JSON config");
    fireEvent.change(textarea, { target: { value: "not json" } });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Invalid JSON")).toBeInTheDocument();
    });
  });

  it("renders enum input as select dropdown", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "lang", type: "enum", enum: ["en", "fr", "de"] }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("lang")).toBeInTheDocument();
    });
    expect(screen.getByText("Select...")).toBeInTheDocument();
    expect(screen.getByText("en")).toBeInTheDocument();
    expect(screen.getByText("fr")).toBeInTheDocument();
  });

  it("renders boolean input as toggle", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "verbose", type: "boolean", optional: true }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("verbose")).toBeInTheDocument();
    });
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("toggles boolean value on click", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "verbose", type: "boolean", optional: true }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("No")).toBeInTheDocument();
    });
    // The toggle button renders "No"/"Yes"
    fireEvent.click(screen.getByRole("button", { name: "" }));
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("renders text input as textarea", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "prompt", type: "text" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("prompt")).toBeInTheDocument();
    });
    const textarea = screen.getByPlaceholderText("prompt");
    expect(textarea.tagName).toBe("TEXTAREA");
  });

  it("shows dry-run button and triggers dry-run", async () => {
    mockFetchChainJson.mockResolvedValue({ inputs: [] });
    mockApiPost.mockResolvedValue({ merged: "test" });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Dry-run"));
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalled();
    });
  });

  it("uses default values from input definitions", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "model", default: "claude-3" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("claude-3")).toBeInTheDocument();
    });
  });

  it("shows examples when provided and clicking sets value", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "topic", examples: ["AI", "Robotics"] }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("AI")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("AI"));
    expect(screen.getByDisplayValue("AI")).toBeInTheDocument();
  });

  it("shows type badge for non-string types", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "count", type: "number" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("[number]")).toBeInTheDocument();
    });
  });

  it("shows 'Starting...' while executing", async () => {
    mockFetchChainJson.mockResolvedValue({ inputs: [] });
    // Never resolve to keep executing state
    mockExecuteChain.mockReturnValue(new Promise(() => {}));
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No inputs required/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Starting...")).toBeInTheDocument();
    });
  });

  it("clears field error when user types", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "query" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("query")).toBeInTheDocument();
    });
    // Trigger validation error
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Required")).toBeInTheDocument();
    });
    // Type in the field to clear error
    fireEvent.change(screen.getByPlaceholderText("query"), {
      target: { value: "hello" },
    });
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("validates pattern constraint", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "code", pattern: "^[A-Z]{3}$" }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("code")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText("code"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Does not match pattern")).toBeInTheDocument();
    });
  });

  it("validates min_length constraint", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "name", min_length: 3 }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("name")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "ab" },
    });
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Min 3 characters")).toBeInTheDocument();
    });
  });

  it("validates enum constraint", async () => {
    mockFetchChainJson.mockResolvedValue({
      inputs: [{ name: "lang", type: "enum", enum: ["en", "fr"] }],
    });
    render(<RunModal name="test" type="chain" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("lang")).toBeInTheDocument();
    });
    // enum with no selection => empty, but it's required => "Required"
    fireEvent.click(screen.getByText(/Execute/));
    await waitFor(() => {
      expect(screen.getByText("Required")).toBeInTheDocument();
    });
  });
});
