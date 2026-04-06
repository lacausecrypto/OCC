import { useRef, useCallback, useState, useEffect } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { useAnnotationStore } from "../../stores/annotations";
import { useAppStore } from "../../stores/app";
import { useServerStore } from "../../stores/server";
import { useBlueprintStore } from "../../stores/blueprints";
import { useChainsStore } from "../../stores/chains";
import { useCanvasRenderer } from "./useCanvasRenderer";
import { useCanvasInteractions } from "./useCanvasInteractions";
import { nodeAt, screenToCanvas } from "./canvasRenderer";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasZoom } from "./CanvasZoom";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { BlueprintPanel } from "./BlueprintPanel";
import { VersionPanel } from "./VersionPanel";
import { WorkflowChat } from "./WorkflowChat";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { RunModal, SaveChainModal } from "../modals";
import { StepEditModal } from "./StepEditModal";
import { STEP_TYPES } from "./pretoolFields";
import type { StepType } from "../../types/chain";
import styles from "./CanvasEditor.module.css";

export function CanvasEditor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);

  useCanvasRenderer(canvasRef, minimapRef);

  // ─── Paste image from clipboard (Ctrl+V / Cmd+V) ─────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (useAnnotationStore.getState().activeTool === "none") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const img = new Image();
            img.onload = () => {
              // Place image at center of current canvas view
              const cam = useCanvasStore.getState().camera;
              const canvas = canvasRef.current;
              const cw = canvas?.parentElement?.clientWidth ?? 800;
              const ch = canvas?.parentElement?.clientHeight ?? 600;
              const cx = (cw / 2 - cam.x) / cam.zoom;
              const cy = (ch / 2 - cam.y) / cam.zoom;
              // Scale image to reasonable size (max 400px wide)
              const scale = Math.min(1, 400 / img.width);
              useAnnotationStore.getState().addImage(dataUrl, cx - (img.width * scale) / 2, cy - (img.height * scale) / 2, img.width * scale, img.height * scale);
            };
            img.src = dataUrl;
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // ─── Drop image file onto canvas ──────────────────────────────
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (useAnnotationStore.getState().activeTool === "none") return;
    const files = e.dataTransfer.files;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const cam = useCanvasStore.getState().camera;
          const p = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, cam);
          const dataUrl = reader.result as string;
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, 400 / img.width);
            useAnnotationStore.getState().addImage(dataUrl, p.x, p.y, img.width * scale, img.height * scale);
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, []);

  // ─── Delete selected annotation with Delete key ───────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ann = useAnnotationStore.getState();
      if (ann.activeTool === "none") return;
      if (ann.selectedId && (e.key === "Delete" || e.key === "Backspace")) {
        // Don't delete if focused on an input
        if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
        ann.deleteSelected();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWheel,
    zoomIn,
    zoomOut,
    zoomToFit,
  } = useCanvasInteractions(canvasRef);

  const [editNodeId, setEditNodeId] = useState<string | null>(null);
  const [runModal, setRunModal] = useState<{ name: string; type: "chain" | "pipeline" } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: (ContextMenuItem | "---")[];
  } | null>(null);
  const [bpPanelOpen, setBpPanelOpen] = useState(false);
  const [wfChatOpen, setWfChatOpen] = useState(false);
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const [saveModal, setSaveModal] = useState(false);

  // ─── Save selection as blueprint ─────────────────────────────
  const saveSelectionAsBlueprint = useCallback(() => {
    const state = useCanvasStore.getState();
    const selectedNodes = [...state.selection]
      .map((id) => state.nodes.get(id))
      .filter(Boolean) as import("../../types/canvas").CanvasNode[];
    if (selectedNodes.length === 0) return;

    const name = window.prompt(
      `Save ${selectedNodes.length} step${selectedNodes.length > 1 ? "s" : ""} as Blueprint:`,
      `Blueprint ${useBlueprintStore.getState().blueprints.length + 1}`,
    );
    if (!name) return;

    useBlueprintStore.getState().saveBlueprint(name, selectedNodes, [...state.edges.values()]);
  }, []);

  // ─── Paste a blueprint at cursor position ────────────────────
  const pasteBlueprintAtCursor = useCallback(
    (bpId: string, screenX: number, screenY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cam = useCanvasStore.getState().camera;
      const p = screenToCanvas(screenX - rect.left, screenY - rect.top, cam);

      const state = useCanvasStore.getState();
      state.pushUndo();

      const result = useBlueprintStore.getState().pasteBlueprint(bpId, p.x, p.y);
      if (!result) return;

      for (const node of result.nodes) state.addNode(node);
      for (const edge of result.edges) state.addEdge(edge);
      useCanvasStore.setState({ selection: new Set(result.nodes.map((n) => n.id)) });
    },
    [],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const state = useCanvasStore.getState();
      const hit = nodeAt(sx, sy, state.camera, state.nodes);
      const serverOnline = useServerStore.getState().serverOnline;
      const pipelineName = useAppStore.getState().pipelineName;
      const selCount = state.selection.size;
      const blueprints = useBlueprintStore.getState().blueprints;

      if (hit) {
        // ─── Right-click on a node ───
        const node = state.nodes.get(hit);
        const items: (ContextMenuItem | "---")[] = [
          // Run
          { icon: "\u25B6", label: "Run this chain", disabled: !serverOnline, action: () => {
            const chainName = node?.stepId || node?.label || "";
            if (chainName) setRunModal({ name: chainName, type: "chain" });
          }},
          "---",
          // Edit
          { icon: "\u270E", label: "Edit Step", action: () => setEditNodeId(hit) },
          { icon: "\u2702", label: "Duplicate", action: () => {
            if (!node) return;
            state.pushUndo();
            const newId = `s${Date.now()}`;
            state.addNode({ ...node, id: newId, x: node.x + 30, y: node.y + 30, stepId: newId, outputVar: newId + "_out" });
          }},
          "---",
          // Blueprint — save selection or single node
          { icon: "\u{1F4CB}", label: selCount > 1 ? `Save ${selCount} steps as Blueprint` : "Save as Blueprint", action: saveSelectionAsBlueprint },
          "---",
          // Connect
          { icon: "\u2192", label: "Connect from here", action: () => useCanvasStore.setState({ activeTool: "connect" }) },
          "---",
          // Delete
          { icon: "\u2716", label: "Delete", action: () => state.removeSelected() },
        ];

        // If multiple selected, add group actions
        if (selCount > 1) {
          items.splice(2, 0,
            { icon: "\u25B6", label: `Run selection (${selCount} steps)`, disabled: !serverOnline, action: () => {
              if (pipelineName) setRunModal({ name: pipelineName, type: "pipeline" });
            }},
          );
        }

        setCtxMenu({ x: e.clientX, y: e.clientY, items });
      } else {
        // ─── Right-click on empty canvas ───
        const addStepSub: ContextMenuItem[] = STEP_TYPES.map((t) => ({
          label: t.charAt(0).toUpperCase() + t.slice(1),
          icon: "",
          action: () => {
            const cx = (sx - state.camera.x) / state.camera.zoom;
            const cy = (sy - state.camera.y) / state.camera.zoom;
            state.pushUndo();
            const newId = `s${Date.now()}`;
            state.addNode({ id: newId, x: cx, y: cy, w: 220, h: 64, type: t as StepType, label: t.charAt(0).toUpperCase() + t.slice(1), preTools: [], tools: [], outputVar: newId + "_out", stepId: newId, prompt: "" });
          },
        }));

        // Blueprint paste submenu
        const bpPasteSub: ContextMenuItem[] = blueprints.length > 0
          ? blueprints.map((bp) => ({
              label: `${bp.name} (${bp.nodes.length} steps)`,
              icon: "",
              action: () => pasteBlueprintAtCursor(bp.id, e.clientX, e.clientY),
            }))
          : [{ label: "No blueprints saved", icon: "", disabled: true }];

        const items: (ContextMenuItem | "---")[] = [
          // Run
          { icon: "\u25B6", label: pipelineName ? `Run pipeline: ${pipelineName}` : "Run chain", disabled: !serverOnline || state.nodes.size === 0, action: () => {
            if (pipelineName) { setRunModal({ name: pipelineName, type: "pipeline" }); }
            else {
              const firstNode = [...state.nodes.values()][0];
              if (firstNode) setRunModal({ name: firstNode.stepId || firstNode.label, type: "chain" });
            }
          }},
          "---",
          // Add step (submenu)
          { icon: "\u2795", label: "Add Step", sub: addStepSub },
          // Paste blueprint (submenu)
          { icon: "\u{1F4CB}", label: "Paste Blueprint", sub: bpPasteSub },
          "---",
          // Selection
          { icon: "\u2610", label: "Select All", action: () => useCanvasStore.setState({ selection: new Set([...state.nodes.keys()]) }) },
          "---",
          // View
          { icon: "\u2302", label: "Reset View", action: () => useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } }) },
          { icon: "\u2922", label: "Zoom to Fit", action: zoomToFit },
          "---",
          // Layout
          { icon: "\u2637", label: "Auto Layout", action: () => {
            useAppStore.getState().autoLayout();
          }},
          "---",
          // Save
          { icon: "\uD83D\uDCBE", label: "Save Chain", disabled: state.nodes.size === 0 || !serverOnline, action: () => setSaveModal(true) },
        ];
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
      }
    },
    [zoomToFit, saveSelectionAsBlueprint, pasteBlueprintAtCursor],
  );

  const bpCount = useBlueprintStore((s) => s.blueprints.length);

  // ─── Ctrl+S save shortcut ───────────────────────────────────
  useEffect(() => {
    const onSaveEvent = () => {
      if (useCanvasStore.getState().nodes.size > 0) {
        setSaveModal(true);
      }
    };
    window.addEventListener("occ-canvas-save", onSaveEvent);
    return () => window.removeEventListener("occ-canvas-save", onSaveEvent);
  }, []);

  return (
    <div className={styles.canvasWrap} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          const ann = useAnnotationStore.getState();
          if (ann.activeTool !== "none") {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cam = useCanvasStore.getState().camera;
            const p = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, cam);

            if (ann.activeTool === "eraser") {
              ann.eraseAt(p, 20);
            } else if (ann.activeTool === "select") {
              const hitId = ann.selectAt(p);
              if (hitId) ann.startMove(p);
              else ann.deselect();
            } else {
              ann.startDraw(p);
            }
            return;
          }
          onPointerDown(e);
        }}
        onPointerMove={(e) => {
          const ann = useAnnotationStore.getState();
          if (ann.activeTool !== "none") {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cam = useCanvasStore.getState().camera;
            const p = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, cam);

            if (ann.activeTool === "eraser" && e.buttons > 0) {
              ann.eraseAt(p, 20);
            } else if (ann.activeTool === "select" && e.buttons > 0) {
              if (ann.resizeHandle) ann.continueResize(p);
              else if (ann.dragOffset) ann.continueMove(p);
            } else {
              ann.continueDraw(p);
            }
            return;
          }
          onPointerMove(e);
        }}
        onPointerUp={(e) => {
          const ann = useAnnotationStore.getState();
          if (ann.activeTool !== "none") {
            if (ann.activeTool === "select") {
              ann.finishMoveResize();
            } else if (ann.activeTool === "text") {
              const text = window.prompt("Enter text:");
              ann.finishDraw(text ?? undefined);
            } else {
              ann.finishDraw();
            }
            return;
          }
          onPointerUp(e);
        }}
        onPointerCancel={onPointerCancel}
        onWheel={onWheel}
        onDoubleClick={(e) => {
          // Double-click on sticky note → edit text
          const ann = useAnnotationStore.getState();
          if (ann.activeTool !== "none" && ann.selectedId) {
            const selected = ann.annotations.find((a) => a.id === ann.selectedId);
            if (selected?.stickyColor) {
              const text = window.prompt("Edit sticky note:", selected.text ?? "");
              if (text !== null) ann.updateText(text);
              return;
            }
          }
          if (ann.activeTool !== "none") return;
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const hit = nodeAt(e.clientX - rect.left, e.clientY - rect.top, useCanvasStore.getState().camera, useCanvasStore.getState().nodes);
          if (hit) setEditNodeId(hit);
        }}
        onContextMenu={onContextMenu}
        style={{
          cursor: useAnnotationStore.getState().activeTool !== "none"
            ? useAnnotationStore.getState().activeTool === "eraser" ? "crosshair" : "crosshair"
            : useCanvasStore.getState().activeTool === "pan" ? "grab" : "default"
        }}
      />

      {/* Glass overlays — inside canvasWrap with position:absolute */}
      <div className={styles.toolbar}>
        <CanvasToolbar
          onRun={() => {
            const state = useCanvasStore.getState();
            const pName = useAppStore.getState().pipelineName;
            if (pName) {
              setRunModal({ name: pName, type: "pipeline" });
            } else {
              const first = [...state.nodes.values()][0];
              if (first) setRunModal({ name: first.stepId || first.label, type: "chain" });
            }
          }}
          onNew={() => {
            useAppStore.getState().createNewChain();
          }}
          onSave={() => setSaveModal(true)}
          onHistory={() => setVersionPanelOpen((v) => !v)}
          historyActive={versionPanelOpen}
        />
      </div>

      <div className={styles.zoomControls}>
        <CanvasZoom onZoomIn={zoomIn} onZoomOut={zoomOut} onZoomFit={zoomToFit} />
      </div>

      <div className={styles.minimap}>
        <canvas ref={minimapRef} width={160} height={110} />
      </div>

      {/* Annotation toolbar + Blueprint toggle + Workflow Chat toggle */}
      <AnnotationToolbar
        onBlueprintToggle={() => setBpPanelOpen((v) => !v)}
        blueprintActive={bpPanelOpen}
        blueprintCount={bpCount}
        onChatToggle={() => setWfChatOpen((v) => !v)}
        chatActive={wfChatOpen}
      />

      {/* Blueprint panel — shifts left when chat is also open */}
      {bpPanelOpen && (
        <BlueprintPanel
          onClose={() => setBpPanelOpen(false)}
          canvasRef={canvasRef}
          align={wfChatOpen ? "left" : "center"}
        />
      )}

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}

      {editNodeId && <StepEditModal nodeId={editNodeId} onClose={() => setEditNodeId(null)} />}

      {runModal && (
        <RunModal
          name={runModal.name}
          type={runModal.type}
          onClose={() => setRunModal(null)}
          onExecuted={(execId) => {
            useAppStore.getState().startExecution(execId, runModal.name, runModal.type);
          }}
        />
      )}

      {saveModal && (
        <SaveChainModal
          onClose={() => setSaveModal(false)}
          onSaved={() => {
            // Refresh chains in dashboard after save
            void useChainsStore.getState().fetchChains();
          }}
        />
      )}

      {/* Version history panel — right side glass overlay */}
      {versionPanelOpen && (
        <VersionPanel
          onClose={() => setVersionPanelOpen(false)}
          onRestored={() => {
            const chainName = useAppStore.getState().canvasChainName;
            const pipeName = useAppStore.getState().pipelineName;
            if (pipeName) {
              void useAppStore.getState().loadPipelineToCanvas(pipeName);
            } else if (chainName) {
              void useAppStore.getState().loadChainToCanvas(chainName);
            }
            setVersionPanelOpen(false);
          }}
        />
      )}

      {/* Workflow Chat — glass popover, shifts right when blueprint is also open */}
      {wfChatOpen && (
        <div style={{
          position: "absolute",
          bottom: 58,
          ...(bpPanelOpen
            ? { right: 16 }
            : { left: "50%", transform: "translateX(-50%)" }
          ),
          width: bpPanelOpen ? "min(380px, calc(100% - 360px))" : "min(380px, calc(100% - 32px))",
          height: "min(460px, calc(100vh - 200px))",
          background: "var(--glass-bg, rgba(20,20,20,0.82))",
          backdropFilter: "var(--glass-blur, blur(24px))",
          WebkitBackdropFilter: "var(--glass-blur, blur(24px))",
          border: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
          borderRadius: "var(--m-radius, 14px)",
          boxShadow: "var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.5))",
          zIndex: 20,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Tail arrow */}
          {!bpPanelOpen && (
            <div style={{
              position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%) rotate(45deg)",
              width: 11, height: 11,
              background: "var(--glass-bg, rgba(20,20,20,0.82))",
              borderRight: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
              borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
              zIndex: -1,
            }} />
          )}
          <WorkflowChat onClose={() => setWfChatOpen(false)} />
        </div>
      )}
    </div>
  );
}
