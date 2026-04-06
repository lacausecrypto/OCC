/**
 * BlobCanvas — the organic conversational graph canvas.
 * Central chat terminal + growing node graph.
 */
import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useBlobStore } from "../../stores/blob";
import { renderBlobCanvas, blobNodeAt, tickPhysics } from "./blobRenderer";
import type { BlobNode } from "../../types/blob";
import { BlobSessionManager } from "./BlobSessionManager";
import { KnowledgePanel } from "./KnowledgePanel";
import { GitGraph } from "./GitGraph";
import { NodeInfoPanel } from "./NodeInfoPanel";
import { GraphView } from "./GraphView";
import styles from "./Blob.module.css";

// ─── Animated thinking indicator ────────────────────────────────────────────

// ─── Unicode animation spinners ─────────────────────────────────────────────

const SPINNERS = {
  dots:     ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  snake:    ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  pulse:    ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  bounce:   ["⠁", "⠂", "⠄", "⡀", "⡀", "⠄", "⠂", "⠁"],
  grow:     ["⠀", "⠁", "⠃", "⠇", "⡇", "⣇", "⣧", "⣷", "⣿", "⣷", "⣧", "⣇", "⡇", "⠇", "⠃", "⠁"],
  wave:     ["⠈⠁", "⠐⠂", "⠠⠄", "⢀⡀", "⠠⠄", "⠐⠂", "⠈⠁"],
  crawl:    ["⢄", "⢂", "⢁", "⡁", "⡈", "⡐", "⡠", "⣀", "⢠", "⢐", "⢈", "⢁"],
  fill:     ["⣀⣀", "⣤⣀", "⣤⣤", "⣶⣤", "⣶⣶", "⣿⣶", "⣿⣿", "⣶⣿", "⣶⣶", "⣤⣶", "⣤⣤", "⣀⣤", "⣀⣀"],
  orbit:    ["⠋⠀", "⠙⠀", "⠸⠀", "⠴⠀", "⠦⠀", "⠇⠀", "⠀⠋", "⠀⠙", "⠀⠸", "⠀⠴", "⠀⠦", "⠀⠇"],
  breathe:  ["⠀", "⠄", "⠆", "⠇", "⡇", "⣇", "⣧", "⣿", "⣧", "⣇", "⡇", "⠇", "⠆", "⠄"],
};

interface ThinkingPhrase {
  text: string;
  spinner: keyof typeof SPINNERS;
  speed: number;
}

const THINKING_PHASES: ThinkingPhrase[] = [
  { text: "Analyzing your request",    spinner: "dots",    speed: 80  },
  { text: "Growing new branches",      spinner: "grow",    speed: 90  },
  { text: "Connecting concepts",       spinner: "snake",   speed: 80  },
  { text: "Mapping knowledge graph",   spinner: "crawl",   speed: 70  },
  { text: "Building the workflow",     spinner: "fill",    speed: 100 },
  { text: "Exploring possibilities",   spinner: "orbit",   speed: 80  },
  { text: "Synthesizing ideas",        spinner: "pulse",   speed: 90  },
  { text: "Branching out",             spinner: "wave",    speed: 100 },
  { text: "Weaving connections",       spinner: "breathe", speed: 70  },
  { text: "Expanding the organism",    spinner: "bounce",  speed: 80  },
];

function BlobThinking() {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const phase = THINKING_PHASES[phaseIdx % THINKING_PHASES.length];
  const spinnerFrames = SPINNERS[phase.spinner];

  // Spinner frame ticker
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % spinnerFrames.length), phase.speed);
    return () => clearInterval(timer);
  }, [spinnerFrames.length, phase.speed]);

  // Phase rotation
  useEffect(() => {
    const timer = setInterval(() => setPhaseIdx((i) => (i + 1) % THINKING_PHASES.length), 3000);
    return () => clearInterval(timer);
  }, []);

  // Elapsed timer
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={`${styles.chatMsg} ${styles.chatMsg_assistant}`}>
      <div className={styles.chatMsgContent}>
        <div className={styles.thinkingWrap}>
          <span className={styles.thinkingSpinner}>{spinnerFrames[frame % spinnerFrames.length]}</span>
          <span className={styles.thinkingText}>{phase.text}</span>
          <span className={styles.thinkingElapsed}>{elapsed}s</span>
        </div>
      </div>
    </div>
  );
}

// ─── Mini spinner for collapsed chat ─────────────────────────────────────────

function MiniSpinner() {
  const [frame, setFrame] = useState(0);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phase = THINKING_PHASES[phaseIdx % THINKING_PHASES.length];
  const frames = SPINNERS[phase.spinner];

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), phase.speed);
    return () => clearInterval(t);
  }, [frames.length, phase.speed]);

  useEffect(() => {
    const t = setInterval(() => setPhaseIdx((i) => (i + 1) % THINKING_PHASES.length), 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <span className={styles.toggleSpinner}>
      {frames[frame % frames.length]} {phase.text}
    </span>
  );
}

// ─── Metrics overlay ────────────────────────────────────────────────────────

function BlobMetrics({ nodes, messages }: {
  nodes: Map<string, import("../../types/blob").BlobNode>;
  messages: import("../../types/blob").BlobMessage[];
}) {
  const knowledge = useBlobStore((s) => s.knowledge);

  const metrics = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let branchCount = 0;
    let stepCount = 0;
    let doneSteps = 0;
    let errorSteps = 0;
    let runningSteps = 0;
    let forkCount = 0;
    let memoryNodes = 0;
    let totalDurationMs = 0;

    for (const [, node] of nodes) {
      switch (node.type) {
        case "branch": branchCount++; break;
        case "fork": forkCount++; break;
        case "memory": memoryNodes++; break;
        case "step":
          stepCount++;
          if (node.status === "done") doneSteps++;
          if (node.status === "error") errorSteps++;
          if (node.status === "running") runningSteps++;
          if (node.data.kind === "step") {
            inputTokens += node.data.inputTokens ?? 0;
            outputTokens += node.data.outputTokens ?? 0;
            totalDurationMs += node.data.durationMs ?? 0;
          }
          break;
      }
    }

    // Also count tokens from chat messages
    for (const msg of messages) {
      inputTokens += msg.inputTokens ?? 0;
      outputTokens += msg.outputTokens ?? 0;
    }

    const totalTokens = inputTokens + outputTokens;
    const formatTok = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const formatDur = (ms: number) => ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

    return { inputTokens, outputTokens, totalTokens, branchCount, stepCount, doneSteps, errorSteps, runningSteps, forkCount, memoryNodes, totalDurationMs, formatTok, formatDur };
  }, [nodes, messages, knowledge]);

  return (
    <div className={styles.blobMetrics}>
      <div className={styles.metricsRow}>
        <span className={styles.metricItem} title="Branches">
          <span className={styles.metricIcon} style={{ color: "var(--icon-green)" }}>{"\u{1F33F}"}</span>
          {metrics.branchCount}
        </span>
        <span className={styles.metricItem} title="Steps (done/total)">
          <span className={styles.metricIcon} style={{ color: "var(--icon-purple)" }}>{"\u25B8"}</span>
          {metrics.doneSteps}/{metrics.stepCount}
          {metrics.errorSteps > 0 && <span style={{ color: "var(--c-error)" }}> ({metrics.errorSteps} err)</span>}
          {metrics.runningSteps > 0 && <span style={{ color: "var(--m-accent)" }}> ({metrics.runningSteps} run)</span>}
        </span>
        <span className={styles.metricItem} title="Forks">
          <span className={styles.metricIcon} style={{ color: "var(--icon-red)" }}>{"\u2934"}</span>
          {metrics.forkCount}
        </span>
        <span className={styles.metricDivider} />
        <span className={styles.metricItem} title="Knowledge concepts">
          <span className={styles.metricIcon} style={{ color: "var(--icon-orange)" }}>{"\u{1F9E0}"}</span>
          {knowledge.length}
        </span>
        <span className={styles.metricItem} title="Messages">
          <span className={styles.metricIcon} style={{ color: "var(--icon-cyan)" }}>{"\u{1F4AC}"}</span>
          {messages.length}
        </span>
        <span className={styles.metricDivider} />
        <span className={styles.metricItem} title={`Input: ${metrics.formatTok(metrics.inputTokens)} · Output: ${metrics.formatTok(metrics.outputTokens)}`}>
          <span className={styles.metricIcon} style={{ color: "var(--m-accent)" }}>{"\u{1F4CA}"}</span>
          {metrics.formatTok(metrics.inputTokens)} in · {metrics.formatTok(metrics.outputTokens)} out
        </span>
        {metrics.totalDurationMs > 0 && (
          <span className={styles.metricItem} title="Total execution time">
            <span className={styles.metricIcon}>{"\u23F1"}</span>
            {metrics.formatDur(metrics.totalDurationMs)}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function BlobCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const physicsNodesRef = useRef<Map<string, BlobNode>>(new Map());
  const lastSyncRef = useRef(0);

  const nodes = useBlobStore((s) => s.nodes);
  const camera = useBlobStore((s) => s.camera);
  const setCamera = useBlobStore((s) => s.setCamera);
  const activeSessionId = useBlobStore((s) => s.activeSessionId);
  const chatStreaming = useBlobStore((s) => s.chatStreaming);
  // tickAnimation is now handled inside the physics loop

  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showGitGraph, setShowGitGraph] = useState(false);
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [needsInfo, setNeedsInfo] = useState(false);

  const PROMPT_SUGGESTIONS = [
    // Architecture & Systems
    "Build me a REST API for a task management app",
    "Design a microservices architecture for an e-commerce platform",
    "Architect a real-time chat system that scales to 1M users",
    "Design a multi-tenant SaaS authentication flow with OAuth2",
    "Build an event-driven order processing pipeline",
    "Create a CQRS + Event Sourcing system for a banking app",
    "Design a service mesh architecture with Istio",
    "Architect a serverless image processing pipeline on AWS",
    "Build a GraphQL federation gateway for 5 microservices",
    "Design a distributed caching strategy with Redis Cluster",
    // Database & Data
    "Compare 3 database strategies for real-time analytics",
    "Design a data lake architecture on AWS S3 + Athena",
    "Build an ETL pipeline from PostgreSQL to Elasticsearch",
    "Architect a time-series database for IoT sensor data",
    "Design a multi-region database replication strategy",
    "Build a vector database for semantic search",
    "Design schema migrations for zero-downtime deployments",
    "Compare MongoDB vs DynamoDB for a social media app",
    "Build a data warehouse with dbt and BigQuery",
    "Design a graph database schema for a knowledge base",
    // DevOps & Infrastructure
    "Design a CI/CD pipeline for a monorepo with 5 services",
    "Build a Kubernetes deployment strategy with blue-green rollouts",
    "Create a Terraform infrastructure for a 3-tier web app",
    "Design a monitoring stack with Prometheus, Grafana, and alerting",
    "Build a GitOps workflow with ArgoCD and Helm",
    "Architect a multi-cloud disaster recovery plan",
    "Design a container orchestration strategy for ML workloads",
    "Build an automated security scanning pipeline",
    "Create a cost optimization strategy for AWS infrastructure",
    "Design a log aggregation system with ELK stack",
    // Security
    "Analyze the security risks of a serverless architecture",
    "Design a zero-trust network architecture",
    "Build a secrets management system with Vault",
    "Create a WAF configuration for OWASP Top 10 protection",
    "Design an API authentication system with JWT + refresh tokens",
    "Build a RBAC permission system for a multi-tenant app",
    "Audit the security of a Node.js Express application",
    "Design a data encryption strategy at rest and in transit",
    "Build a fraud detection system for payment processing",
    "Create a compliance framework for GDPR and SOC2",
    // Frontend & UX
    "Build a design system with React components and Storybook",
    "Create a real-time collaborative editor like Google Docs",
    "Design an accessible form validation library",
    "Build a virtual scrolling list for 100K items",
    "Create a drag-and-drop kanban board with animations",
    "Design a responsive email template system",
    "Build an offline-first PWA with service workers",
    "Create a theming engine with CSS custom properties",
    "Design a micro-frontend architecture with Module Federation",
    "Build a WebGL data visualization dashboard",
    // API & Integration
    "Design a rate limiting strategy for a public API",
    "Build a webhook delivery system with retry logic",
    "Create an API versioning strategy for backward compatibility",
    "Design a file upload system with chunked uploads and resumability",
    "Build a payment integration with Stripe Connect",
    "Create an OAuth2 provider for third-party app access",
    "Design an API gateway with request transformation",
    "Build a real-time notification system with WebSockets and SSE",
    "Create a PDF generation service from HTML templates",
    "Design a search API with facets, filters, and autocomplete",
    // Machine Learning & AI
    "Architect a data pipeline for ML model training",
    "Build a recommendation engine for an e-commerce platform",
    "Design a RAG system with vector embeddings and reranking",
    "Create an AI-powered content moderation pipeline",
    "Build a sentiment analysis API for customer reviews",
    "Design a feature store for ML model serving",
    "Create an A/B testing framework with statistical analysis",
    "Build an anomaly detection system for server metrics",
    "Design a conversational AI pipeline with intent classification",
    "Create an image classification API with model versioning",
    // Mobile & Cross-platform
    "Design a React Native app architecture for a delivery service",
    "Build a push notification system for iOS and Android",
    "Create a mobile offline sync strategy with conflict resolution",
    "Design a deep linking strategy for a mobile app",
    "Build a mobile payment flow with Apple Pay and Google Pay",
    "Create a mobile analytics pipeline with event tracking",
    "Design a mobile app update strategy with code push",
    "Build a cross-platform design system for web and mobile",
    "Create a mobile authentication flow with biometrics",
    "Design a mobile performance monitoring dashboard",
    // Business & Product
    "Build a subscription billing system with usage-based pricing",
    "Design a marketplace platform connecting buyers and sellers",
    "Create a multi-language internationalization system",
    "Build an inventory management system for a warehouse",
    "Design a customer support ticketing system with SLA tracking",
    "Create a referral program with tracking and rewards",
    "Build a booking and scheduling system for a clinic",
    "Design a loyalty points system for a retail chain",
    "Create an invoice generation and payment tracking system",
    "Build a project management tool with Gantt charts",
    // Emerging Tech
    "Design a blockchain-based supply chain tracking system",
    "Build a WebAssembly module for image processing in the browser",
    "Create an edge computing architecture for IoT devices",
    "Design a Web3 authentication flow with wallet signatures",
    "Build a real-time multiplayer game server with WebRTC",
    "Create a digital twin simulation for a smart factory",
    "Design an AR shopping experience for a furniture store",
    "Build a privacy-preserving analytics system",
    "Create a decentralized storage system with IPFS",
    "Design a quantum-resistant encryption migration strategy",
  ];
  const [suggestionIdx, setSuggestionIdx] = useState(() => Math.floor(Math.random() * PROMPT_SUGGESTIONS.length));
  const [promptTab, setPromptTab] = useState<"chat" | "planner">("chat");
  const sessions = useBlobStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [plannerPrompt, setPlannerPrompt] = useState("");

  // Sync prompt editor with active session
  useEffect(() => {
    if (activeSession) {
      setSystemPrompt(activeSession.chatPrompt ?? "");
      setPlannerPrompt(activeSession.plannerPrompt ?? "");
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [viewMode, setViewMode] = useState<"blob" | "graph">("blob");

  // ─── Restore last active session on mount ─────────────────────
  useEffect(() => {
    if (activeSessionId) return; // Already has one
    const savedId = localStorage.getItem("occ-blob-active-session");
    if (savedId) {
      // Check if this session still exists
      const sessions = useBlobStore.getState().sessions;
      if (sessions.some((s) => s.id === savedId)) {
        useBlobStore.getState().setActiveSession(savedId);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Get messages from core node
  const coreNode = [...nodes.values()].find((n) => n.type === "core");
  const messages = coreNode?.data.kind === "core" ? coreNode.data.messages : [];

  // ─── Sync store nodes → physicsNodesRef (when changed externally: addNode, executePlan, etc.) ──
  useEffect(() => {
    physicsNodesRef.current = new Map(nodes);
  }, [nodes]);

  // ─── Animation loop (reads store directly — no deps to avoid infinite loop) ──
  useEffect(() => {
    let running = true;
    let lastPhysics = 0;
    const loop = () => {
      if (!running) return;
      const canvas = canvasRef.current;
      const now = performance.now();
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const s = useBlobStore.getState();

          // Physics tick at ~30fps (every 33ms) — write to mutable ref, NOT store
          if (now - lastPhysics > 33) {
            physicsNodesRef.current = tickPhysics(physicsNodesRef.current, s.edges, now);
            lastPhysics = now;

            // Sync back to store every 500ms (not every frame)
            if (now - lastSyncRef.current > 500) {
              useBlobStore.setState({ nodes: new Map(physicsNodesRef.current) });
              lastSyncRef.current = now;
            }
          }

          renderBlobCanvas(ctx, canvas, s.camera, physicsNodesRef.current, s.edges, now);
        }
      }
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, []);

  // ─── Auto-save every 15s ─────────────────────────────────────
  useEffect(() => {
    if (!activeSessionId) return;
    const timer = setInterval(() => {
      useBlobStore.getState().saveActiveSession();
    }, 15_000);
    return () => clearInterval(timer);
  }, [activeSessionId]);

  // ─── Save on tab visibility change (user switches tab/minimizes) ──
  useEffect(() => {
    const onVisChange = () => {
      if (document.hidden && activeSessionId) {
        useBlobStore.getState().saveActiveSession();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [activeSessionId]);

  // ─── Save on unmount (when switching tabs in the app) ──
  useEffect(() => {
    return () => {
      useBlobStore.getState().saveActiveSession();
    };
  }, []);

  // ─── Pan & Zoom ─────────────────────────────────────────────
  const dragRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left - rect.width / 2;
    const sy = e.clientY - rect.top - rect.height / 2;

    // Hit test
    const hit = blobNodeAt(sx, sy, camera, nodes);
    if (hit) {
      setSelectedNode(hit);
      setShowKnowledge(false);
      return;
    }

    // Pan
    dragRef.current = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [camera, nodes]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setCamera({ x: dragRef.current.camX + dx, y: dragRef.current.camY + dy });
  }, [setCamera]);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    const newZoom = Math.max(0.2, Math.min(3, camera.zoom * factor));
    setCamera({ zoom: newZoom });
  }, [camera.zoom, setCamera]);

  // ─── Send message ───────────────────────────────────────────
  // ─── Debug: inject test plans via /test, /fork, /extend commands ─────────
  const handleDebugCommand = async (cmd: string): Promise<boolean> => {
    if (!activeSessionId) return false;
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0].toLowerCase();

    if (command === "/test") {
      useBlobStore.getState().addMessage({
        id: `msg_${Date.now()}`, role: "system",
        content: "Injecting test plan (5 branches, 14 steps, 3 knowledge entries)...",
        timestamp: new Date().toISOString(), spawnedNodeIds: [],
      });
      const res = await fetch(`/blobs/${activeSessionId}/test-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
      if (res.ok) {
        const plan = await res.json();
        useBlobStore.getState().executePlan(plan);
      }
      return true;
    }

    if (command === "/fork") {
      // /fork <branchNodeId> [forkAtStepId]
      const nodes = [...useBlobStore.getState().nodes.values()];
      const branches = nodes.filter((n) => n.type === "branch");
      if (branches.length === 0) {
        useBlobStore.getState().addMessage({
          id: `msg_${Date.now()}`, role: "system",
          content: "No branches to fork. Run /test first.",
          timestamp: new Date().toISOString(), spawnedNodeIds: [],
        });
        return true;
      }
      // Fork the first branch (or specified one)
      const targetBranch = parts[1] ? nodes.find((n) => n.id === parts[1]) : branches[0];
      if (!targetBranch) { return true; }

      // Find a step to fork from
      const edges = [...useBlobStore.getState().edges.values()];
      const branchSteps = edges.filter((e) => e.from === targetBranch.id).map((e) => e.to);
      const forkAt = parts[2] ?? branchSteps[0] ?? targetBranch.id;

      useBlobStore.getState().addMessage({
        id: `msg_${Date.now()}`, role: "system",
        content: `Forking branch "${targetBranch.label}" at ${forkAt}...`,
        timestamp: new Date().toISOString(), spawnedNodeIds: [],
      });

      const res = await fetch(`/blobs/${activeSessionId}/test-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "fork", branchNodeId: targetBranch.id, forkAtStepId: forkAt }),
      });
      if (res.ok) {
        const plan = await res.json();
        useBlobStore.getState().executePlan(plan);
      }
      return true;
    }

    if (command === "/extend") {
      const nodes = [...useBlobStore.getState().nodes.values()];
      const branches = nodes.filter((n) => n.type === "branch");
      if (branches.length === 0) return true;
      const targetBranch = parts[1] ? nodes.find((n) => n.id === parts[1]) : branches[0];
      if (!targetBranch) return true;

      useBlobStore.getState().addMessage({
        id: `msg_${Date.now()}`, role: "system",
        content: `Extending branch "${targetBranch.label}" with 2 new steps...`,
        timestamp: new Date().toISOString(), spawnedNodeIds: [],
      });

      const res = await fetch(`/blobs/${activeSessionId}/test-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "extend", branchNodeId: targetBranch.id }),
      });
      if (res.ok) {
        const plan = await res.json();
        useBlobStore.getState().executePlan(plan);
      }
      return true;
    }

    if (command === "/nodes") {
      const nodes = [...useBlobStore.getState().nodes.values()];
      const summary = nodes.map((n) => `${n.type}:${n.id.slice(-6)} "${n.label}"`).join("\n");
      useBlobStore.getState().addMessage({
        id: `msg_${Date.now()}`, role: "system",
        content: `${nodes.length} nodes:\n${summary}`,
        timestamp: new Date().toISOString(), spawnedNodeIds: [],
      });
      return true;
    }

    return false; // Not a debug command
  };

  const handleSend = async () => {
    if (!chatInput.trim() || !activeSessionId) return;
    const text = chatInput.trim();
    setChatInput("");

    // Check for debug commands first
    if (text.startsWith("/")) {
      const handled = await handleDebugCommand(text);
      if (handled) return;
    }

    // Add user message
    const msgId = `msg_${Date.now()}`;
    useBlobStore.getState().addMessage({
      id: msgId, role: "user", content: text,
      timestamp: new Date().toISOString(), spawnedNodeIds: [],
    });

    useBlobStore.getState().setChatStreaming(true);
    const coreNodeRef = [...useBlobStore.getState().nodes.values()].find((n) => n.type === "core");
    if (coreNodeRef) useBlobStore.getState().updateNode(coreNodeRef.id, { status: "thinking" });

    try {
      const context = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

      // Step 1: Chat (haiku — fast, ~5-15s)
      const session = useBlobStore.getState().sessions.find((s) => s.id === activeSessionId);
      const chatRes = await fetch(`/blobs/${activeSessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, context, systemPrompt: session?.chatPrompt || undefined }),
      });

      const assistantMsgId = `msg_${Date.now()}_a`;
      if (!chatRes.ok) {
        const errText = await chatRes.text().catch(() => chatRes.statusText);
        useBlobStore.getState().addMessage({
          id: assistantMsgId, role: "assistant",
          content: `Error (${chatRes.status}): ${errText}`,
          timestamp: new Date().toISOString(), spawnedNodeIds: [],
        });
        return;
      }

      const chatData = await chatRes.json() as { text: string; inputTokens?: number; outputTokens?: number };
      useBlobStore.getState().addMessage({
        id: assistantMsgId, role: "assistant",
        content: chatData.text,
        timestamp: new Date().toISOString(), spawnedNodeIds: [],
        inputTokens: chatData.inputTokens,
        outputTokens: chatData.outputTokens,
      });

      // Step 2: Plan (sonnet — sequential, after chat finishes)
      if (coreNodeRef) useBlobStore.getState().updateNode(coreNodeRef.id, { status: "running" });

      const existingBranches = [...useBlobStore.getState().nodes.values()]
        .filter((n) => n.type === "branch")
        .map((n) => ({
          id: n.id,
          topic: n.label,
          stepIds: [...useBlobStore.getState().edges.values()]
            .filter((e) => e.from === n.id)
            .map((e) => e.to),
        }));

      const knownConcepts = useBlobStore.getState().knowledge.map((k) => k.concept);

      const planRes = await fetch(`/blobs/${activeSessionId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          userMessage: text,
          existingBranches,
          knownConcepts,
          recentMessages: context,
          customPlannerPrompt: session?.plannerPrompt || undefined,
        }),
      });

      if (planRes.ok) {
        const plan = await planRes.json();
        if (plan.branches?.length > 0 || plan.reuseBranches?.length > 0) {
          useBlobStore.getState().executePlan(plan);
        }
      }
    } catch (err) {
      useBlobStore.getState().addMessage({
        id: `msg_${Date.now()}`, role: "assistant",
        content: `Error: ${err}`, timestamp: new Date().toISOString(), spawnedNodeIds: [],
      });
    } finally {
      useBlobStore.getState().setChatStreaming(false);
      if (coreNodeRef) useBlobStore.getState().updateNode(coreNodeRef.id, { status: "idle" });
      useBlobStore.getState().saveActiveSession();
    }
  };

  // ─── Execute a blob step via SSE streaming ──────────────────
  const executeStep = useCallback(async (nodeId: string) => {
    const state = useBlobStore.getState();
    const node = state.nodes.get(nodeId);
    if (!node || node.data.kind !== "step") return;

    state.updateNode(nodeId, { status: "running" });
    const stepData = node.data;

    // Collect branch context: walk backward to find previous step outputs
    const previousOutputs: Array<{ stepId: string; label: string; output: string }> = [];
    let branchNodeId: string | null = null;
    {
      let currentId = nodeId;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        let parentId: string | null = null;
        for (const [, edge] of state.edges) {
          if (edge.to === currentId) { parentId = edge.from; break; }
        }
        if (!parentId) break;
        const parentNode = state.nodes.get(parentId);
        if (!parentNode) break;
        if (parentNode.type === "step" && parentNode.data.kind === "step" && (parentNode.data as Record<string, unknown>).output) {
          previousOutputs.unshift({
            stepId: parentNode.id,
            label: parentNode.label,
            output: String((parentNode.data as Record<string, unknown>).output),
          });
        } else if (parentNode.type === "branch") {
          branchNodeId = parentNode.id;
          break;
        }
        currentId = parentId;
      }
    }

    try {
      const res = await fetch(`/blobs/${activeSessionId}/execute-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepType: stepData.stepType,
          prompt: stepData.prompt,
          model: stepData.model,
          nodeId,
          branchNodeId,
          previousOutputs: previousOutputs.length > 0 ? previousOutputs : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        useBlobStore.getState().updateNode(nodeId, { status: "error" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullOutput = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "chunk") {
              fullOutput += evt.text;
            } else if (evt.type === "done") {
              useBlobStore.getState().updateNode(nodeId, {
                status: "done",
                data: { ...stepData, output: fullOutput, durationMs: evt.durationMs, inputTokens: evt.inputTokens, outputTokens: evt.outputTokens },
              });
              // Auto-extract knowledge from output
              if (fullOutput.length > 50) {
                fetch("/knowledge/extract", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: fullOutput, sessionId: activeSessionId, nodeId }),
                  signal: AbortSignal.timeout(60000),
                }).then((r) => r.ok ? r.json() : null).then((data) => {
                  if (data?.extracted?.length > 0) {
                    for (const entry of data.extracted) {
                      useBlobStore.getState().updateKnowledge(entry.concept, entry.facts, activeSessionId!, nodeId);
                    }
                  }
                }).catch(() => {});
              }
            } else if (evt.type === "error") {
              useBlobStore.getState().updateNode(nodeId, { status: "error" });
            }
          } catch { /* skip */ }
        }
      }
    } catch {
      useBlobStore.getState().updateNode(nodeId, { status: "error" });
    }

    useBlobStore.getState().saveActiveSession();
  }, [activeSessionId]);

  // ─── Poll for autonomous plans ─────────────────────────────────
  useEffect(() => {
    if (!activeSessionId) return;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/blobs/${activeSessionId}/auto-plan`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json() as { plan?: unknown };
          if (data.plan) {
            useBlobStore.getState().addMessage({
              id: `msg_auto_${Date.now()}`, role: "system",
              content: `Autonomous growth triggered`,
              timestamp: new Date().toISOString(), spawnedNodeIds: [],
            });
            useBlobStore.getState().executePlan(data.plan as import("../../types/blob").BlobPlan);
          }
        }
      } catch { /* backend offline */ }
    }, 30_000); // Check every 30s
    return () => clearInterval(poll);
  }, [activeSessionId]);

  // ─── Auto-execute steps after plan ────────────────────────────
  const prevNodeCountRef = useRef(nodes.size);
  useEffect(() => {
    if (nodes.size > prevNodeCountRef.current) {
      // New nodes were added — find idle step nodes and execute them
      for (const [, node] of nodes) {
        if (node.type === "step" && node.status === "idle" && node.data.kind === "step") {
          executeStep(node.id);
        }
      }
    }
    prevNodeCountRef.current = nodes.size;
  }, [nodes.size, executeStep]);

  // ─── No session selected → show session manager ───────────────
  if (!activeSessionId) {
    return <BlobSessionManager />;
  }

  return (
    <div className={styles.blobWrap}>
      {/* Top-left: Sessions + View toggle */}
      <div className={styles.blobTopLeft}>
        <button className={styles.blobBackBtn} onClick={() => { useBlobStore.getState().saveActiveSession(); useBlobStore.getState().setActiveSession(null); }} title="Back to sessions">
          {"\u2190"}
        </button>
        <div className={styles.viewToggle}>
          <button
            className={`${styles.viewToggleBtn} ${viewMode === "blob" ? styles.viewToggleBtnActive : ""}`}
            onClick={() => setViewMode("blob")}
          >
            Blob
          </button>
          <button
            className={`${styles.viewToggleBtn} ${viewMode === "graph" ? styles.viewToggleBtnActive : ""}`}
            onClick={() => setViewMode("graph")}
          >
            Graph
          </button>
        </div>
      </div>

      {/* Blob view (physarum canvas) */}
      {viewMode === "blob" && (
        <canvas
          ref={canvasRef}
          className={styles.blobCanvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
      )}

      {/* Graph view (Obsidian-like force graph) */}
      {viewMode === "graph" && <GraphView />}

      {/* Chat overlay */}
      <div className={`${styles.chatPanel} ${chatOpen ? styles.chatPanelOpen : styles.chatPanelClosed}`}>
        <button className={styles.chatToggle} onClick={() => setChatOpen(!chatOpen)}>
          {chatOpen ? "\u25BC" : "\u25B2"} Chat
          {!chatOpen && chatStreaming && <MiniSpinner />}
        </button>

        {chatOpen && (
          <>
            <div className={styles.chatMessages}>
              {messages.map((msg) => (
                <div key={msg.id} className={`${styles.chatMsg} ${styles[`chatMsg_${msg.role}`]}`}>
                  {msg.role === "system" && <span className={styles.chatMsgRole}>{"\u2699"} system</span>}
                  <div className={styles.chatMsgContent}>{msg.content}</div>
                  <span className={styles.chatMsgTime}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ))}
              {chatStreaming && <BlobThinking />}
            </div>

            {/* Suggestion chip */}
            {messages.length === 0 && !chatInput && !chatStreaming && (
              <div className={styles.chatSuggestion}>
                <button className={styles.chatSuggestionBtn} onClick={() => setChatInput(PROMPT_SUGGESTIONS[suggestionIdx % PROMPT_SUGGESTIONS.length])}>
                  {PROMPT_SUGGESTIONS[suggestionIdx % PROMPT_SUGGESTIONS.length]}
                </button>
                <button className={styles.chatSuggestionShuffle} onClick={() => setSuggestionIdx((i) => (i + 1) % PROMPT_SUGGESTIONS.length)} title="Shuffle">{"\u21BB"}</button>
              </div>
            )}

            <div className={styles.chatInputRow}>
              <button
                className={styles.chatPromptBtn}
                onClick={() => { setShowPromptEditor(!showPromptEditor); setShowGitGraph(false); setShowKnowledge(false); }}
                title="Edit session prompts"
              >{"\u270E"}</button>
              <input
                className={styles.chatInput}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Ask anything... the BLOB will grow"
                disabled={chatStreaming}
                autoFocus
              />
              <button
                className={styles.chatSend}
                onClick={handleSend}
                disabled={chatStreaming || !chatInput.trim()}
              >
                {chatStreaming ? "..." : "\u2191"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Selected node info */}
      {selectedNode && !showKnowledge && !showGitGraph && nodes.get(selectedNode) && (
        <NodeInfoPanel nodeId={selectedNode} onClose={() => setSelectedNode(null)} onExecute={executeStep} />
      )}

      {/* Top-right action buttons */}
      <div className={styles.blobTopActions}>
        <button className={styles.blobGitBtn} onClick={() => { setShowGitGraph(!showGitGraph); setShowKnowledge(false); setShowPromptEditor(false); setSelectedNode(null); }} title="Git Graph View">
          {"\u{1F333}"} Graph
        </button>
        <button className={styles.blobKnowledgeBtn} onClick={() => { setShowKnowledge(!showKnowledge); setShowGitGraph(false); setShowPromptEditor(false); setSelectedNode(null); }} title="Knowledge Graph">
          {"\u{1F9E0}"} {useBlobStore.getState().knowledge.length}
        </button>
      </div>

      {/* Git Graph panel (inline like knowledge) */}
      {showGitGraph && <GitGraph onClose={() => setShowGitGraph(false)} />}


      {/* Knowledge panel */}
      {showKnowledge && <KnowledgePanel onClose={() => setShowKnowledge(false)} />}

      {/* Prompt Editor */}
      {showPromptEditor && (
        <div className={styles.knowledgePanel}>
          <div className={styles.gitHeader}>
            <div className={styles.gitTitle}>Prompts</div>
            <button className={styles.gitCloseBtn} onClick={() => setShowPromptEditor(false)}>{"\u2715"}</button>
          </div>
          <div className={styles.gitToolbar}>
            <div className={styles.gitFilters}>
              <button className={`${styles.gitFilterBtn} ${promptTab === "chat" ? styles.gitFilterBtnActive : ""}`} onClick={() => setPromptTab("chat")}>Chat</button>
              <button className={`${styles.gitFilterBtn} ${promptTab === "planner" ? styles.gitFilterBtnActive : ""}`} onClick={() => setPromptTab("planner")}>Planner</button>
            </div>
            <button
              className={styles.gitActionBtn}
              style={generating ? { opacity: 0.5 } : needsInfo ? { animation: "shake 0.4s ease-in-out", borderColor: "var(--c-error)" } : {}}
              disabled={generating}
              onClick={async () => {
                const s = useBlobStore.getState().sessions.find((ss) => ss.id === activeSessionId);
                if (!s?.name || s.name.length < 2) {
                  setNeedsInfo(true);
                  setTimeout(() => setNeedsInfo(false), 1500);
                  return;
                }
                setGenerating(true);
                try {
                  const res = await fetch(`/blobs/${activeSessionId}/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      message: promptTab === "chat"
                        ? `Generate a concise system prompt (5-8 lines) for a chat assistant specialized in: "${s.name}"${s.description ? ` — ${s.description}` : ""}. The prompt should define expertise, tone, and focus areas. Return ONLY the prompt text, no explanation.`
                        : `Generate a concise planner prompt (5-8 lines) for an AI graph planner working on: "${s.name}"${s.description ? ` — ${s.description}` : ""}. The prompt should guide how to structure branches, what types of steps to create, and when to fork. Return ONLY the prompt text, no explanation.`,
                      context: [],
                    }),
                  });
                  if (res.ok) {
                    const data = await res.json() as { text: string };
                    if (promptTab === "chat") setSystemPrompt(data.text.trim());
                    else setPlannerPrompt(data.text.trim());
                  }
                } catch { /* ignore */ }
                setGenerating(false);
              }}
            >
              {generating ? "\u23F3 Generating..." : needsInfo ? "Name your session first!" : "\u2728 Auto-generate"}
            </button>
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, flex: 1, overflow: "auto" }}>
            <div style={{ fontSize: 11, color: "var(--m-text2)" }}>
              {promptTab === "chat"
                ? "Custom instructions for the chat assistant. Controls personality, focus, and behavior."
                : "Custom instructions for the graph planner. Controls how branches, steps, and forks are created."}
            </div>
            <textarea
              value={promptTab === "chat" ? systemPrompt : plannerPrompt}
              onChange={(e) => promptTab === "chat" ? setSystemPrompt(e.target.value) : setPlannerPrompt(e.target.value)}
              placeholder={promptTab === "chat"
                ? "You are an expert in...\nFocus on...\nAlways use..."
                : "Create deep branches with 4-5 steps.\nAlways start with web_search.\nPrefer forking over new branches."}
              style={{
                flex: 1, minHeight: 180, padding: 10, border: "1px solid var(--glass-border)",
                borderRadius: "var(--m-radius)", background: "color-mix(in srgb, var(--m-text) 5%, var(--m-bg))",
                color: "var(--m-text)", fontFamily: "var(--m-font-mono, monospace)", fontSize: 12,
                lineHeight: 1.5, resize: "vertical", outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className={styles.gitActionBtn} onClick={() => {
                if (promptTab === "chat") setSystemPrompt("");
                else setPlannerPrompt("");
              }}>Reset</button>
              <button className={styles.gitActionBtn} style={{ background: "var(--m-accent)", color: "var(--m-accent-contrast, #000)", fontWeight: 600 }} onClick={() => {
                if (activeSessionId) {
                  useBlobStore.getState().setSessionPrompts(activeSessionId, systemPrompt, plannerPrompt);
                }
              }}>Save</button>
            </div>
            <div style={{ fontSize: 10, color: "var(--m-text2)", opacity: 0.6 }}>
              Per session. Click Auto-generate to create prompts from session name.
            </div>
          </div>
        </div>
      )}

      {/* Stats overlay — rich metrics */}
      <BlobMetrics nodes={nodes} messages={messages} />
    </div>
  );
}
