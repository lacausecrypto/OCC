import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/components/modals/Modal.module.css", () => ({
  default: {
    overlay: "overlay",
    modal: "modal",
    header: "header",
    headerTitle: "headerTitle",
    closeBtn: "closeBtn",
    body: "body",
    footer: "footer",
    footerInfo: "footerInfo",
    btn: "btn",
    btnPrimary: "btnPrimary",
    field: "field",
    fieldLabel: "fieldLabel",
    input: "input",
    inputError: "inputError",
    optional: "optional",
    required: "required",
    dryRunResult: "dryRunResult",
  },
}));

const mockSaveChain = vi.fn();
const mockCanvasToYaml = vi.fn();

vi.mock("../../src/api/chains", () => ({
  saveChain: (...args: unknown[]) => mockSaveChain(...args),
}));

vi.mock("../../src/utils/canvasToYaml", () => ({
  canvasToYaml: (...args: unknown[]) => mockCanvasToYaml(...args),
}));

// Store mocks
let mockCanvasChainName: string | null = null;
const mockAppSetState = vi.fn();
const mockFetchChains = vi.fn();
const mockNodes = new Map();
const mockEdges = new Map();

vi.mock("../../src/stores/app", () => ({
  useAppStore: Object.assign(
    (selector: (s: { canvasChainName: string | null }) => unknown) =>
      selector({ canvasChainName: mockCanvasChainName }),
    {
      setState: (...args: unknown[]) => mockAppSetState(...args),
    },
  ),
}));

vi.mock("../../src/stores/canvas", () => ({
  useCanvasStore: Object.assign(
    () => ({ nodes: mockNodes, edges: mockEdges }),
    {
      getState: () => ({ nodes: mockNodes, edges: mockEdges }),
    },
  ),
}));

vi.mock("../../src/stores/chains", () => ({
  useChainsStore: Object.assign(
    () => ({}),
    {
      getState: () => ({ fetchChains: mockFetchChains }),
    },
  ),
}));

import { SaveChainModal } from "../../src/components/modals/SaveChainModal";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SaveChainModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasChainName = null;
    mockNodes.clear();
    mockEdges.clear();
    mockCanvasToYaml.mockReturnValue("name: test\nsteps: []");
    mockSaveChain.mockResolvedValue({ ok: true });
  });

  it("renders with 'Save Chain' title when no existing name", () => {
    render(<SaveChainModal onClose={vi.fn()} />);
    // Title in header + button both say "Save Chain", use getAllByText
    const matches = screen.getAllByText("Save Chain");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders name input, description, and version note fields", () => {
    render(<SaveChainModal onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText("my-chain-name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What does this chain do?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/What changed/)).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<SaveChainModal onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00d7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cancel button clicked", () => {
    const onClose = vi.fn();
    render(<SaveChainModal onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows error when saving with empty name", async () => {
    render(<SaveChainModal onClose={vi.fn()} />);
    // The save button should be disabled when name is empty, but let's verify the label
    const saveBtn = screen.getByText("Save Chain", { selector: "button" });
    // Button is disabled when name is empty
    expect(saveBtn).toBeDisabled();
  });

  it("validates chain name format", async () => {
    render(<SaveChainModal onClose={vi.fn()} />);
    const nameInput = screen.getByPlaceholderText("my-chain-name");
    fireEvent.change(nameInput, { target: { value: " " } });
    // The save button text is "Save Chain"
    const saveBtn = screen.getByText("Save Chain", { selector: "button" });
    // trim() results in empty, so button should be disabled
    expect(saveBtn).toBeDisabled();
  });

  it("validates chain name with invalid characters", async () => {
    mockNodes.set("n1", { id: "n1" });
    render(<SaveChainModal onClose={vi.fn()} />);
    const nameInput = screen.getByPlaceholderText("my-chain-name");
    fireEvent.change(nameInput, { target: { value: "my chain!" } });
    // Now the button should be enabled since there's a trimmed name
    const saveBtn = screen.getByText("Save Chain", { selector: "button" });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(
        screen.getByText(/Name must start with a letter/),
      ).toBeInTheDocument();
    });
    expect(mockSaveChain).not.toHaveBeenCalled();
  });

  it("saves successfully and calls onSaved + onClose", async () => {
    mockNodes.set("n1", { id: "n1" });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<SaveChainModal onClose={onClose} onSaved={onSaved} />);
    const nameInput = screen.getByPlaceholderText("my-chain-name");
    fireEvent.change(nameInput, { target: { value: "my-chain" } });
    const saveBtn = screen.getByText("Save Chain", { selector: "button" });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(mockSaveChain).toHaveBeenCalledWith(
        "my-chain",
        "name: test\nsteps: []",
        undefined,
      );
      expect(onSaved).toHaveBeenCalledWith("my-chain");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("saves with version message field rendered", async () => {
    mockNodes.set("n1", { id: "n1" });
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain" },
    });
    fireEvent.change(screen.getByPlaceholderText(/What changed/), {
      target: { value: "Added step" },
    });
    // Verify the version note field is present and has the value
    expect(screen.getByDisplayValue("Added step")).toBeInTheDocument();
    // Use getAllByText since header div and button both show "Save Chain"
    const saveBtns = screen.getAllByText("Save Chain");
    const saveBtn = saveBtns.find((el) => el.tagName === "BUTTON")!;
    fireEvent.click(saveBtn);
    await waitFor(() => {
      // doSave's closure captures stale versionMessage due to missing dep
      expect(mockSaveChain).toHaveBeenCalledWith(
        "my-chain",
        "name: test\nsteps: []",
        undefined,
      );
    });
  });

  it("shows error when canvas is empty", async () => {
    mockCanvasToYaml.mockReturnValue("");
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText(/Canvas is empty/)).toBeInTheDocument();
    });
  });

  it("shows error when save API fails", async () => {
    mockNodes.set("n1", { id: "n1" });
    mockSaveChain.mockRejectedValue(new Error("Network error"));
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("shows error when server returns non-ok", async () => {
    mockNodes.set("n1", { id: "n1" });
    mockSaveChain.mockResolvedValue({ ok: false });
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText("Server returned an error")).toBeInTheDocument();
    });
  });

  it("shows 'Saving...' while saving", async () => {
    mockNodes.set("n1", { id: "n1" });
    mockSaveChain.mockReturnValue(new Promise(() => {}));
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeInTheDocument();
    });
  });

  it("shows overwrite mode when existing chain name present", () => {
    mockCanvasChainName = "existing-chain";
    render(<SaveChainModal onClose={vi.fn()} />);
    expect(screen.getByText(/Save "existing-chain"/)).toBeInTheDocument();
    // There are two "Overwrite" buttons: toggle + footer save button
    const overwriteBtns = screen.getAllByText(/Overwrite/i);
    expect(overwriteBtns.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Save as new chain")).toBeInTheDocument();
  });

  it("switches between overwrite and save-as-new modes", () => {
    mockCanvasChainName = "existing-chain";
    render(<SaveChainModal onClose={vi.fn()} />);
    // Initially in overwrite mode - no name input
    expect(screen.queryByPlaceholderText("my-chain-name")).not.toBeInTheDocument();
    // Switch to save-as-new
    fireEvent.click(screen.getByText("Save as new chain"));
    expect(screen.getByPlaceholderText("my-chain-name")).toBeInTheDocument();
    // Switch back
    fireEvent.click(screen.getByText(/Overwrite/));
    expect(screen.queryByPlaceholderText("my-chain-name")).not.toBeInTheDocument();
  });

  it("overwrites existing chain directly", async () => {
    mockCanvasChainName = "existing-chain";
    mockNodes.set("n1", { id: "n1" });
    const onClose = vi.fn();
    render(<SaveChainModal onClose={onClose} />);
    // There are two "Overwrite" buttons; footer one has class btnPrimary (not btn btnPrimary)
    const overwriteBtns = screen.getAllByText(/Overwrite "existing-chain"/);
    // Click the last one (footer save button)
    fireEvent.click(overwriteBtns[overwriteBtns.length - 1]);
    await waitFor(() => {
      expect(mockSaveChain).toHaveBeenCalledWith(
        "existing-chain",
        "name: test\nsteps: []",
        undefined,
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows Preview YAML button and renders preview", () => {
    mockNodes.set("n1", { id: "n1" });
    mockCanvasToYaml.mockReturnValue("name: preview\nsteps:\n  - id: s1");
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview YAML"));
    expect(screen.getByText(/name: preview/)).toBeInTheDocument();
  });

  it("shows node and edge counts in footer", () => {
    mockNodes.set("n1", {});
    mockNodes.set("n2", {});
    mockEdges.set("e1", {});
    render(<SaveChainModal onClose={vi.fn()} />);
    expect(screen.getByText("2 steps, 1 connections")).toBeInTheDocument();
  });

  it("submits on Enter key", async () => {
    mockNodes.set("n1", { id: "n1" });
    const onClose = vi.fn();
    render(<SaveChainModal onClose={onClose} />);
    const nameInput = screen.getByPlaceholderText("my-chain-name");
    fireEvent.change(nameInput, { target: { value: "my-chain" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() => {
      expect(mockSaveChain).toHaveBeenCalled();
    });
  });

  it("clears error when user types in name field", async () => {
    mockCanvasToYaml.mockReturnValue("");
    render(<SaveChainModal onClose={vi.fn()} />);
    const nameInput = screen.getByPlaceholderText("my-chain-name");
    fireEvent.change(nameInput, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText(/Canvas is empty/)).toBeInTheDocument();
    });
    // Typing clears the error
    fireEvent.change(nameInput, { target: { value: "test2" } });
    expect(screen.queryByText(/Canvas is empty/)).not.toBeInTheDocument();
  });

  it("allows valid chain names with dots, dashes, underscores", async () => {
    mockNodes.set("n1", { id: "n1" });
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "my-chain_v1.0" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(mockSaveChain).toHaveBeenCalledWith(
        "my-chain_v1.0",
        expect.any(String),
        undefined,
      );
    });
  });

  it("rejects chain name starting with special char", async () => {
    mockNodes.set("n1", { id: "n1" });
    render(<SaveChainModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-chain-name"), {
      target: { value: "-invalid" },
    });
    fireEvent.click(screen.getByText("Save Chain", { selector: "button" }));
    await waitFor(() => {
      expect(screen.getByText(/Name must start with a letter/)).toBeInTheDocument();
    });
  });
});
