import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MainTabs } from "../../src/components/layout/MainTabs";

// Mock CSS modules
vi.mock("../../src/components/layout/AppLayout.module.css", () => ({
  default: {
    mainTabs: "mainTabs",
    mainTab: "mainTab",
    mainTabActive: "mainTabActive",
    tabBadgeExp: "tabBadgeExp",
    tabSessionName: "tabSessionName",
  },
}));

// Mock blob store
vi.mock("../../src/stores/blob", () => ({
  useBlobStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = { activeSessionId: null, sessions: [] };
    return selector(state);
  }),
}));

describe("MainTabs", () => {
  it("renders all 4 tabs", () => {
    render(<MainTabs activeTab="dashboard" onTabChange={vi.fn()} />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    // Blob tab shows "The Blob" when no session active
    expect(screen.getByText(/The Blob/)).toBeInTheDocument();
  });

  it("marks active tab", () => {
    render(<MainTabs activeTab="canvas" onTabChange={vi.fn()} />);
    const workflowBtn = screen.getByText("Workflow");
    expect(workflowBtn.className).toContain("mainTabActive");
  });

  it("calls onTabChange when tab is clicked", () => {
    const onChange = vi.fn();
    render(<MainTabs activeTab="dashboard" onTabChange={onChange} />);
    fireEvent.click(screen.getByText("Settings"));
    expect(onChange).toHaveBeenCalledWith("settings");
  });

  it("shows EXP badge on Blob tab", () => {
    render(<MainTabs activeTab="dashboard" onTabChange={vi.fn()} />);
    expect(screen.getByText("EXP")).toBeInTheDocument();
  });

  it("calls onTabChange with correct tab id", () => {
    const onChange = vi.fn();
    render(<MainTabs activeTab="dashboard" onTabChange={onChange} />);
    fireEvent.click(screen.getByText("Dashboard"));
    expect(onChange).toHaveBeenCalledWith("dashboard");
    fireEvent.click(screen.getByText("Workflow"));
    expect(onChange).toHaveBeenCalledWith("canvas");
  });
});
