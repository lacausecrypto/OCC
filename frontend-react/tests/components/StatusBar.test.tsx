import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusBar } from "../../src/components/dashboard/StatusBar";
import { useServerStore } from "../../src/stores/server";

vi.mock("../../src/components/dashboard/Dashboard.module.css", () => ({
  default: {
    statusBar: "statusBar", statusDot: "statusDot", online: "online",
    statusText: "statusText", statusUrlInput: "statusUrlInput",
    btn: "btn", btnSmall: "btnSmall",
  },
}));

describe("StatusBar", () => {
  beforeEach(() => {
    useServerStore.setState({
      occServerUrl: "http://localhost:4242",
      serverOnline: true,
    });
  });

  it("shows connected status when online", () => {
    render(<StatusBar onRefresh={vi.fn()} />);
    expect(screen.getByText(/connected/)).toBeInTheDocument();
  });

  it("shows offline status when server down", () => {
    useServerStore.setState({ serverOnline: false });
    render(<StatusBar onRefresh={vi.fn()} />);
    expect(screen.getByText("OCC server offline")).toBeInTheDocument();
  });

  it("renders URL input with current server URL", () => {
    render(<StatusBar onRefresh={vi.fn()} />);
    const input = screen.getByPlaceholderText("http://localhost:4242");
    expect(input).toHaveValue("http://localhost:4242");
  });

  it("calls onRefresh when Refresh button clicked", () => {
    const onRefresh = vi.fn();
    render(<StatusBar onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("Refresh"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("updates URL on Enter key in input", () => {
    const onRefresh = vi.fn();
    render(<StatusBar onRefresh={onRefresh} />);
    const input = screen.getByPlaceholderText("http://localhost:4242");
    fireEvent.change(input, { target: { value: "http://custom:9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(useServerStore.getState().occServerUrl).toBe("http://custom:9999");
  });

  it("strips trailing slashes from URL", () => {
    render(<StatusBar onRefresh={vi.fn()} />);
    const input = screen.getByPlaceholderText("http://localhost:4242");
    fireEvent.change(input, { target: { value: "http://example.com///" } });
    fireEvent.click(screen.getByText("Refresh"));
    expect(useServerStore.getState().occServerUrl).toBe("http://example.com");
  });
});
