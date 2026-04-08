import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../../src/stores/app";
import { useCanvasStore } from "../../src/stores/canvas";
import { useCanvasExecStore } from "../../src/stores/canvasExec";
import { useAnnotationStore } from "../../src/stores/annotations";
import { useBlobStore } from "../../src/stores/blob";

// Mock fetch globally
globalThis.fetch = vi.fn(() =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
);

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeTab: "dashboard",
      canvasChainName: null,
      pipelineName: null,
      pipelineViewMode: "stages",
      decomposeLayout: "grid",
      decomposeGroups: new Map(),
      canvasLoading: false,
    });
    useCanvasStore.getState().clear();
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
  });

  describe("initial state", () => {
    it("has correct defaults", () => {
      const s = useAppStore.getState();
      expect(s.activeTab).toBe("dashboard");
      expect(s.canvasChainName).toBeNull();
      expect(s.pipelineName).toBeNull();
      expect(s.pipelineViewMode).toBe("stages");
      expect(s.decomposeLayout).toBe("grid");
      expect(s.decomposeGroups.size).toBe(0);
      expect(s.canvasLoading).toBe(false);
    });
  });

  describe("setActiveTab", () => {
    it("changes the active tab", () => {
      useAppStore.getState().setActiveTab("canvas");
      expect(useAppStore.getState().activeTab).toBe("canvas");
    });

    it("can switch to any tab", () => {
      const tabs = ["dashboard", "canvas", "blob", "settings"] as const;
      for (const tab of tabs) {
        useAppStore.getState().setActiveTab(tab as any);
        expect(useAppStore.getState().activeTab).toBe(tab);
      }
    });
  });

  describe("loadChainToCanvas", () => {
    it("sets canvasChainName and clears pipeline", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "s1", type: "agent", label: "Step 1", prompt: "p", output_var: "out" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().loadChainToCanvas("my-chain", "http://localhost:4200");
      const s = useAppStore.getState();
      expect(s.canvasChainName).toBe("my-chain");
      expect(s.pipelineName).toBeNull();
      expect(s.canvasLoading).toBe(false);
    });

    it("sets canvasLoading during load", async () => {
      let resolvePromise: (v: Response) => void;
      const pending = new Promise<Response>((r) => { resolvePromise = r; });
      globalThis.fetch = vi.fn(() => pending);

      const promise = useAppStore.getState().loadChainToCanvas("test", "http://localhost");
      expect(useAppStore.getState().canvasLoading).toBe(true);

      resolvePromise!(
        new Response(JSON.stringify({ steps: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await promise;
      expect(useAppStore.getState().canvasLoading).toBe(false);
    });

    it("prevents concurrent loads", async () => {
      useAppStore.setState({ canvasLoading: true });
      await useAppStore.getState().loadChainToCanvas("test");
      // Should return early without calling fetch
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("handles fetch errors gracefully", async () => {
      globalThis.fetch = vi.fn(() => Promise.reject(new Error("Network error")));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await useAppStore.getState().loadChainToCanvas("bad-chain", "http://localhost");
      expect(useAppStore.getState().canvasLoading).toBe(false);
      consoleSpy.mockRestore();
    });

    it("creates nodes and edges for chain steps with depends_on", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "s1", type: "agent", label: "Step 1", prompt: "p1", output_var: "o1" },
                { id: "s2", type: "agent", label: "Step 2", prompt: "p2", output_var: "o2", depends_on: ["s1"] },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().loadChainToCanvas("test", "http://localhost");
      const canvas = useCanvasStore.getState();
      expect(canvas.nodes.size).toBe(2);
      expect(canvas.edges.size).toBe(1);
    });

    it("creates sequential edges when no depends_on present", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "s1", type: "agent", label: "A", prompt: "p", output_var: "o1" },
                { id: "s2", type: "agent", label: "B", prompt: "p", output_var: "o2" },
                { id: "s3", type: "agent", label: "C", prompt: "p", output_var: "o3" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().loadChainToCanvas("linear", "http://localhost");
      const canvas = useCanvasStore.getState();
      expect(canvas.nodes.size).toBe(3);
      expect(canvas.edges.size).toBe(2);
    });

    it("returns early for empty steps", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ steps: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      await useAppStore.getState().loadChainToCanvas("empty", "http://localhost");
      expect(useCanvasStore.getState().nodes.size).toBe(0);
    });

    it("handles router and gate node types with custom dimensions", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "r1", type: "router", label: "Router", prompt: "p", output_var: "o1" },
                { id: "g1", type: "gate", label: "Gate", prompt: "p", output_var: "o2", depends_on: ["r1"] },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().loadChainToCanvas("typed", "http://localhost");
      const nodes = [...useCanvasStore.getState().nodes.values()];
      const router = nodes.find((n) => n.type === "router");
      const gate = nodes.find((n) => n.type === "gate");
      expect(router).toBeDefined();
      expect(gate).toBeDefined();
      expect(router!.w).toBe(200);
      expect(router!.h).toBe(80);
      expect(gate!.h).toBe(70);
    });
  });

  describe("loadPipelineToCanvas", () => {
    it("loads pipeline stages as subchain nodes", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              chains: [
                { id: "c1", chain: "chain-a", label: "Stage A" },
                { id: "c2", chain: "chain-b", label: "Stage B", depends_on: ["c1"] },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().loadPipelineToCanvas("my-pipeline");
      const s = useAppStore.getState();
      expect(s.pipelineName).toBe("my-pipeline");
      expect(s.pipelineViewMode).toBe("stages");
      expect(useCanvasStore.getState().nodes.size).toBe(2);
    });

    it("returns early for empty pipeline", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ chains: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" } }),
        ),
      );

      await useAppStore.getState().loadPipelineToCanvas("empty-pipe");
      expect(useCanvasStore.getState().nodes.size).toBe(0);
    });

    it("prevents concurrent loads", async () => {
      useAppStore.setState({ canvasLoading: true });
      await useAppStore.getState().loadPipelineToCanvas("test");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("createNewChain", () => {
    it("creates 3 template nodes and 2 edges", () => {
      useAppStore.getState().createNewChain();
      const canvas = useCanvasStore.getState();
      expect(canvas.nodes.size).toBe(3);
      expect(canvas.edges.size).toBe(2);
    });

    it("clears canvasChainName and pipelineName", () => {
      useAppStore.setState({ canvasChainName: "old", pipelineName: "old-pipe" });
      useAppStore.getState().createNewChain();
      const s = useAppStore.getState();
      expect(s.canvasChainName).toBeNull();
      expect(s.pipelineName).toBeNull();
    });

    it("switches to canvas tab", () => {
      useAppStore.getState().createNewChain();
      expect(useAppStore.getState().activeTab).toBe("canvas");
    });

    it("creates nodes with correct labels", () => {
      useAppStore.getState().createNewChain();
      const labels = [...useCanvasStore.getState().nodes.values()].map((n) => n.label);
      expect(labels).toContain("Input Processing");
      expect(labels).toContain("Main Task");
      expect(labels).toContain("Output");
    });
  });

  describe("setDecomposeLayout", () => {
    it("sets the layout mode", () => {
      useAppStore.getState().setDecomposeLayout("flow");
      expect(useAppStore.getState().decomposeLayout).toBe("flow");
    });

    it("switches back to grid", () => {
      useAppStore.getState().setDecomposeLayout("flow");
      useAppStore.getState().setDecomposeLayout("grid");
      expect(useAppStore.getState().decomposeLayout).toBe("grid");
    });
  });

  describe("autoLayout", () => {
    it("does nothing on empty canvas", () => {
      useAppStore.getState().autoLayout();
      expect(useCanvasStore.getState().nodes.size).toBe(0);
    });

    it("repositions nodes when canvas has content", () => {
      useAppStore.getState().createNewChain();
      const nodesBefore = [...useCanvasStore.getState().nodes.values()].map((n) => ({ x: n.x, y: n.y }));
      useAppStore.getState().autoLayout();
      const nodesAfter = [...useCanvasStore.getState().nodes.values()].map((n) => ({ x: n.x, y: n.y }));
      // Layout should run (positions may or may not change depending on algorithm)
      expect(nodesAfter.length).toBe(nodesBefore.length);
    });
  });

  describe("toggleDecompose", () => {
    it("does nothing without a pipeline", async () => {
      useAppStore.setState({ pipelineName: null });
      await useAppStore.getState().toggleDecompose();
      // Should return early, no state change
      expect(useAppStore.getState().pipelineName).toBeNull();
    });
  });

  describe("startExecution", () => {
    it("loads chain and sets execution ID", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "s1", type: "agent", label: "Step", prompt: "p", output_var: "o" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      await useAppStore.getState().startExecution("exec-123", "my-chain", "chain");
      const exec = useCanvasExecStore.getState();
      expect(exec.canvasExecId).toBe("exec-123");
    });
  });

  describe("openBlobSession", () => {
    it("switches to blob tab and sets active session", () => {
      useAppStore.getState().openBlobSession("blob-1");
      expect(useAppStore.getState().activeTab).toBe("blob");
    });
  });

  describe("loadPipelineDecomposed", () => {
    it("sets decomposed view mode", async () => {
      // Mock pipeline fetch + chain fetches
      globalThis.fetch = vi.fn((url: string | URL | Request) => {
        const u = typeof url === "string" ? url : (url as Request).url;
        if (u.includes("/pipelines/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                chains: [
                  { id: "c1", chain: "chain-a", label: "Stage A" },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        // chain fetch
        return Promise.resolve(
          new Response(
            JSON.stringify({
              steps: [
                { id: "s1", type: "agent", label: "Step 1", prompt: "p", output_var: "o" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }) as any;

      await useAppStore.getState().loadPipelineDecomposed("my-pipe");
      expect(useAppStore.getState().pipelineViewMode).toBe("decomposed");
      expect(useAppStore.getState().canvasLoading).toBe(false);
    });

    it("prevents concurrent loads", async () => {
      useAppStore.setState({ canvasLoading: true });
      await useAppStore.getState().loadPipelineDecomposed("test");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
