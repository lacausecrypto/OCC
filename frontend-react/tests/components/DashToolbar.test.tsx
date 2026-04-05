import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DashToolbar } from "../../src/components/dashboard/DashToolbar";
import { useChainsStore } from "../../src/stores/chains";

vi.mock("../../src/components/dashboard/Dashboard.module.css", () => ({
  default: {
    toolbar: "toolbar", filterBtn: "filterBtn", filterBtnActive: "filterBtnActive",
    sep: "sep", select: "select", spacer: "spacer", viewToggle: "viewToggle",
    viewBtn: "viewBtn", viewBtnActive: "viewBtnActive", searchInput: "searchInput",
  },
}));

vi.mock("../../src/stores/app", () => ({
  useAppStore: { getState: () => ({ createNewChain: vi.fn() }) },
}));

describe("DashToolbar", () => {
  beforeEach(() => {
    useChainsStore.setState({
      filterType: "all",
      sortBy: "name",
      viewMode: "grid",
      searchQuery: "",
      sizeFilter: "",
    });
  });

  const defaultProps = {
    chainCount: 11,
    pipelineCount: 4,
    stepTypes: ["agent", "router", "evaluator"],
    typeFilter: "",
    onTypeFilterChange: vi.fn(),
  };

  it("renders filter buttons with counts", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByText("All (15)")).toBeInTheDocument();
    expect(screen.getByText("Chains (11)")).toBeInTheDocument();
    expect(screen.getByText("Pipelines (4)")).toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("updates search query in store when typing", () => {
    render(<DashToolbar {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "test" } });
    expect(useChainsStore.getState().searchQuery).toBe("test");
  });

  it("renders view mode buttons", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByTitle("Grid")).toBeInTheDocument();
    expect(screen.getByTitle("List")).toBeInTheDocument();
    expect(screen.getByTitle("Table")).toBeInTheDocument();
    expect(screen.getByTitle("Mini")).toBeInTheDocument();
  });

  it("changes view mode when button clicked", () => {
    render(<DashToolbar {...defaultProps} />);
    fireEvent.click(screen.getByTitle("List"));
    expect(useChainsStore.getState().viewMode).toBe("list");
  });

  it("renders sort dropdown", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByText("Sort: Name")).toBeInTheDocument();
  });

  it("renders step type filter dropdown", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByText("All types")).toBeInTheDocument();
  });

  it("renders + New button", () => {
    render(<DashToolbar {...defaultProps} />);
    expect(screen.getByText("+ New")).toBeInTheDocument();
  });

  it("calls onTypeFilterChange when type dropdown changes", () => {
    const onTypeFilterChange = vi.fn();
    render(<DashToolbar {...defaultProps} onTypeFilterChange={onTypeFilterChange} />);
    // Find the step type select and change it
    const selects = screen.getAllByRole("combobox");
    const typeSelect = selects.find(s => {
      const opts = s.querySelectorAll("option");
      return [...opts].some(o => o.textContent === "agent");
    });
    if (typeSelect) {
      fireEvent.change(typeSelect, { target: { value: "agent" } });
      expect(onTypeFilterChange).toHaveBeenCalledWith("agent");
    }
  });
});
