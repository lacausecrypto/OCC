/**
 * REST + SSE server for the canvas web app.
 * Runs on port 4242 alongside the MCP stdio server.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import type { ExecutionEvent } from "./types.js";
import {
  listChains,
  loadChainRaw,
  saveChain,
  deleteChain,
  loadChain,
} from "./loader.js";
import { executeChain, getExecution, getAllExecutions, cancelExecution, loadPersistedExecutions, resumeExecution, approveGate, getPendingApprovals, validateClaudeBinary, canStartExecution, getRunningExecutionCount, getExecutionTimeline } from "./executor.js";
import { getChainStats } from "./storage.js";
import { loadMcpServers, discoverTools, getConfiguredServers, closeMcpClients } from "./mcp-client.js";
import { closeStorage } from "./storage.js";
import { initQueue, enqueue, getQueueJob, listQueueJobs, listQueueByStatus, cancelQueueJob, getQueueStats, purgeOldJobs, closeQueue } from "./queue.js";
import {
  initScheduler, setSSEEmitter,
  getSchedules, getSchedule,
  createSchedule, updateSchedule, deleteSchedule, toggleSchedule, runNow,
} from "./scheduler.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/yaml", limit: "2mb" }));

// Serve canvas frontend build (includes /assets/ for sprites)
const canvasDistDir = process.env.CANVAS_DIST ?? path.join(process.cwd(), "..", "canvas", "dist");
if (fs.existsSync(canvasDistDir)) {
  app.use(express.static(canvasDistDir));
}

// CORS — configurable via CORS_ORIGIN env var (default: * for local dev)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

// ─── SSE subscriber map: executionId → list of response streams ──────────────
const sseClients = new Map<string, Response[]>();

function emitSSE(executionId: string, event: ExecutionEvent): void {
  const clients = sseClients.get(executionId) ?? [];
  const alive: Response[] = [];
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
      alive.push(res);
    } catch {
      // Client disconnected — don't keep reference
    }
  }
  if (alive.length !== clients.length) {
    sseClients.set(executionId, alive);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /chains → list
app.get("/chains", (_req, res) => {
  const names = listChains();
  const chains = names.map((name) => {
    try {
      const chain = loadChain(name);
      return {
        name,
        description: chain.description,
        version: chain.version,
        stepCount: chain.steps.length,
      };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
  res.json(chains);
});

// GET /chains/:name → raw YAML
app.get("/chains/:name", (req, res) => {
  try {
    const raw = loadChainRaw(req.params.name);
    res.type("text/yaml").send(raw);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// POST /chains/:name → save YAML (body: YAML string or JSON object)
app.post("/chains/:name", (req, res) => {
  try {
    if (typeof req.body === "string") {
      // Raw YAML — save directly
      const dir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${req.params.name}.yaml`), req.body as string, "utf-8");
    } else {
      saveChain(req.params.name, req.body);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /chains/:name
app.delete("/chains/:name", (req, res) => {
  try {
    deleteChain(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// POST /execute/:name → start execution (queued if busy), returns executionId immediately
app.post("/execute/:name", async (req: Request, res: Response) => {
  try {
    const chain = loadChain(req.params.name);
    const input = (req.body?.input ?? {}) as Record<string, string>;
    const priority = typeof req.body?.priority === "number" ? req.body.priority : 5;

    // Validate required inputs against chain definition
    for (const inputDef of chain.inputs ?? []) {
      if (!inputDef.optional && (input[inputDef.name] === undefined || input[inputDef.name] === "")) {
        return res.status(400).json({
          error: `Missing required input: "${inputDef.name}"${inputDef.description ? ` (${inputDef.description})` : ""}`,
        });
      }
    }

    if (canStartExecution()) {
      // Fast path: execute immediately
      const executionId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

      const emitter = (event: ExecutionEvent) => {
        if (event.type === "execution_started") {
          (event as any).executionId = executionId;
        }
        emitSSE(executionId, event);
      };

      res.json({ executionId, queued: false });

      setImmediate(() => {
        executeChain(chain, input, emitter).catch(() => {
          // errors are captured in execution record
        });
      });
    } else {
      // Queue path: add to queue, process when a worker is free
      const job = enqueue("chain", req.params.name, input, { priority });
      res.status(202).json({
        jobId: job.id,
        queued: true,
        position: getQueueStats().queued,
        message: `Queued (${getRunningExecutionCount()} running, ${getQueueStats().queued} in queue)`,
      });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions/:id/stream → SSE live stream
app.get("/executions/:id/stream", (req, res) => {
  const { id } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const execution = getExecution(id);

  // Catch-up: replay all step outputs accumulated so far
  if (execution) {
    const send = (e: ExecutionEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "execution_started", executionId: id, chainName: execution.chainName });
    for (const [stepId, step] of Object.entries(execution.steps)) {
      if (step.status === "pending") continue;
      send({ type: "step_started", executionId: id, stepId, label: stepId });
      if (step.output) send({ type: "step_output", executionId: id, stepId, chunk: step.output });
      if (step.status === "done")
        send({ type: "step_done", executionId: id, stepId, durationMs: step.durationMs ?? 0 });
      if (step.status === "error")
        send({ type: "step_error", executionId: id, stepId, error: step.error ?? "" });
    }
    // If already finished, close
    if (execution.status === "done" || execution.status === "error") {
      const event: ExecutionEvent =
        execution.status === "done"
          ? { type: "execution_done", executionId: id, result: execution.result ?? "", durationMs: execution.durationMs ?? 0 }
          : { type: "execution_error", executionId: id, error: execution.error ?? "Unknown error" };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
  }

  const clients = sseClients.get(id) ?? [];
  clients.push(res);
  sseClients.set(id, clients);

  // SSE heartbeat: prevent browser/proxy timeouts on idle connections
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeatTimer);
      sseClients.set(id, (sseClients.get(id) ?? []).filter((r) => r !== res));
    }
  }, 30000);

  const cleanupSSE = () => {
    clearInterval(heartbeatTimer);
    sseClients.set(id, (sseClients.get(id) ?? []).filter((r) => r !== res));
  };

  req.on("close", cleanupSSE);
  res.on("error", cleanupSSE); // Handle silent disconnects
});

// GET /executions/:id → status
app.get("/executions/:id", (req, res) => {
  const execution = getExecution(req.params.id);
  if (!execution) return res.status(404).json({ error: "Not found" });
  return res.json(execution);
});

// GET /executions/:id/timeline → time-travel checkpoint history
app.get("/executions/:id/timeline", (req, res) => {
  try {
    const timeline = getExecutionTimeline(req.params.id);
    return res.json(timeline);
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

// GET /chains/:name/stats → execution statistics for a chain
app.get("/chains/:name/stats", (req, res) => {
  try {
    const stats = getChainStats(req.params.name);
    return res.json(stats);
  } catch {
    return res.status(500).json({ error: "Stats unavailable" });
  }
});

// DELETE /executions/:id → cancel a running execution
app.delete("/executions/:id", (req, res) => {
  const ok = cancelExecution(req.params.id);
  if (!ok) return res.status(404).json({ error: "Execution not found or already finished" });
  return res.json({ ok: true });
});

// POST /executions/:id/resume → resume a failed execution from checkpoint
app.post("/executions/:id/resume", async (req, res) => {
  try {
    const { id } = req.params;
    const execution = getExecution(id);
    if (!execution) return res.status(404).json({ error: "Execution not found" });

    const chain = loadChain(execution.chainName);
    if (!chain) return res.status(404).json({ error: `Chain "${execution.chainName}" not found` });

    // Use same SSE broadcast pattern as execute
    const result = await resumeExecution(id, chain, (event) => {
      emitSSE(id, event);
    });

    res.json({ executionId: id, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

// POST /executions/:id/approve/:stepId → approve or reject a gate step
app.post("/executions/:id/approve/:stepId", (req, res) => {
  const { id, stepId } = req.params;
  const { approved } = req.body as { approved: boolean };

  const success = approveGate(id, stepId, approved ?? false);
  if (!success) {
    return res.status(404).json({ error: "No pending approval found" });
  }

  res.json({ ok: true });
});

// GET /approvals → list all pending gate approvals
app.get("/approvals", (_req, res) => {
  res.json(getPendingApprovals());
});

// Extract absolute file paths from text
function extractFilePaths(text: string): string[] {
  const matches = text.match(/\/[^\s"'`\])}>]+\.(pdf|png|jpg|csv)/gi) ?? [];
  return [...new Set(matches)];
}

// GET /executions → history (paginated)
app.get("/executions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const all = getAllExecutions().slice(offset, offset + limit);
  res.json(
    all.map(({ id, chainName, status, startedAt, finishedAt, durationMs, result, steps }) => {
      // Collect file paths from result + all step outputs
      const texts = [result ?? "", ...Object.values(steps).map((s) => s.output ?? "")];
      const files = extractFilePaths(texts.join("\n"));
      return { id, chainName, status, startedAt, finishedAt, durationMs, files };
    })
  );
});

// GET /download?path=... → serve a local file (restricted to /tmp and WORKSPACE_DIR)
app.get("/download", (req, res) => {
  const filePath = decodeURIComponent((req.query.path as string) ?? "");
  if (!filePath) return res.status(400).json({ error: "Missing path" });

  // Security: resolve to absolute path first to prevent path traversal attacks
  const resolved = path.resolve(filePath);
  const allowed = [os.tmpdir(), "/tmp", process.env.WORKSPACE_DIR ?? ""].filter(Boolean);
  const safe = allowed.some((dir) => {
    const resolvedDir = path.resolve(dir);
    return resolved.startsWith(resolvedDir + path.sep);
  });
  if (!safe) return res.status(403).json({ error: "Path not allowed" });

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });

  const filename = path.basename(resolved);
  const safeFilename = filename.replace(/["\\\n\r]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return res.sendFile(resolved);
});

// ─── Schedule routes ──────────────────────────────────────────────────────────

// GET /schedules
app.get("/schedules", (_req, res) => res.json(getSchedules()));

// GET /schedules/:id
app.get("/schedules/:id", (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// POST /schedules
app.post("/schedules", (req, res) => {
  try {
    const { label, chainName, input, cron, enabled } = req.body;
    if (!chainName || !cron) return res.status(400).json({ error: "chainName and cron are required" });
    const s = createSchedule({ label: label || chainName, chainName, input: input ?? {}, cron, enabled: enabled ?? true });
    return res.status(201).json(s);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// PUT /schedules/:id
app.put("/schedules/:id", (req, res) => {
  const s = updateSchedule(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// PATCH /schedules/:id/toggle
app.patch("/schedules/:id/toggle", (req, res) => {
  const s = toggleSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// POST /schedules/:id/run — trigger immediately
app.post("/schedules/:id/run", async (req, res) => {
  try {
    const executionId = await runNow(req.params.id);
    return res.json({ executionId });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /schedules/:id
app.delete("/schedules/:id", (req, res) => {
  const ok = deleteSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  return res.json({ ok: true });
});

// ─── Pipeline routes ─────────────────────────────────────────────────────────

import {
  listPipelines, loadPipeline, loadPipelineRaw,
  savePipeline, deletePipeline as deletePipelineFile,
} from "./pipeline-loader.js";
import {
  executePipeline, getPipelineExecution, getAllPipelineExecutions,
  loadPersistedPipelineExecutions,
} from "./pipeline-executor.js";

// GET /pipelines
app.get("/pipelines", (_req, res) => {
  const names = listPipelines();
  const pipelines = names.map((name) => {
    try {
      const p = loadPipeline(name);
      return { name, description: p.description, version: p.version, chainCount: p.chains.length };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
  res.json(pipelines);
});

// GET /pipelines/:name
app.get("/pipelines/:name", (req, res) => {
  try {
    const raw = loadPipelineRaw(req.params.name);
    res.type("text/yaml").send(raw);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// GET /pipelines/:name/json
app.get("/pipelines/:name/json", (req, res) => {
  try {
    const p = loadPipeline(req.params.name);
    res.json(p);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// POST /pipelines/:name — save
app.post("/pipelines/:name", (req, res) => {
  try {
    if (typeof req.body === "string") {
      const dir = process.env.PIPELINES_DIR ??
        path.join((process.env.CHAINS_DIR ?? "").replace(/[/\\]chains[/\\]?$/, ""), "pipelines") ??
        path.join(process.cwd(), "..", "pipelines");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${req.params.name}.yaml`), req.body, "utf-8");
    } else {
      savePipeline(req.params.name, req.body);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /pipelines/:name
app.delete("/pipelines/:name", (req, res) => {
  try {
    deletePipelineFile(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// POST /pipelines/:name/execute — run pipeline
app.post("/pipelines/:name/execute", async (req: Request, res: Response) => {
  try {
    if (!canStartExecution()) {
      return res.status(429).json({
        error: `Too many concurrent executions (${getRunningExecutionCount()} running). Try again later.`,
      });
    }

    const pipeline = loadPipeline(req.params.name);
    const input = (req.body?.input ?? {}) as Record<string, string>;

    // Validate required pipeline inputs
    for (const inputDef of pipeline.inputs ?? []) {
      if (!inputDef.optional && (input[inputDef.name] === undefined || input[inputDef.name] === "")) {
        return res.status(400).json({
          error: `Missing required input: "${inputDef.name}"${inputDef.description ? ` (${inputDef.description})` : ""}`,
        });
      }
    }

    let executionId = "";
    const emitter = (event: ExecutionEvent) => {
      if (event.type === "execution_started") executionId = event.executionId;
      if (executionId) emitSSE(executionId, event);
    };

    executePipeline(pipeline, input, emitter).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[occ] Pipeline "${pipeline.name}" execution failed: ${error}\n`);
      if (executionId) {
        emitSSE(executionId, { type: "execution_error", executionId, error });
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    res.json({ executionId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /pipelines/executions
app.get("/pipeline-executions", (_req, res) => {
  res.json(getAllPipelineExecutions().slice(0, 50));
});

// GET /pipeline-executions/:id
app.get("/pipeline-executions/:id", (req, res) => {
  const ex = getPipelineExecution(req.params.id);
  if (!ex) return res.status(404).json({ error: "Not found" });
  return res.json(ex);
});

// ─── Queue routes ────────────────────────────────────────────────────────────

// GET /queue → queue statistics
app.get("/queue", (_req, res) => res.json(getQueueStats()));

// GET /queue/jobs → list all jobs
app.get("/queue/jobs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const status = req.query.status as string;
  if (status) {
    res.json(listQueueByStatus(status, limit));
  } else {
    res.json(listQueueJobs(limit, offset));
  }
});

// GET /queue/jobs/:id → single job status
app.get("/queue/jobs/:id", (req, res) => {
  const job = getQueueJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(job);
});

// DELETE /queue/jobs/:id → cancel a queued job
app.delete("/queue/jobs/:id", (req, res) => {
  const ok = cancelQueueJob(req.params.id);
  if (!ok) return res.status(404).json({ error: "Job not found or already running" });
  return res.json({ ok: true });
});

// DELETE /queue/purge → remove old completed/failed jobs
app.delete("/queue/purge", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const purged = purgeOldJobs(days);
  res.json({ purged });
});

// GET /health
app.get("/health", (_req, res) => res.json({
  ok: true,
  version: "2.0.0",
  runningExecutions: getRunningExecutionCount(),
  mcpServers: getConfiguredServers(),
  queue: getQueueStats(),
}));

// GET /mcp-servers → list configured external MCP servers and their tools
app.get("/mcp-servers", async (_req, res) => {
  try {
    const tools = await discoverTools();
    res.json(tools);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Generate Chain via Claude Code CLI + MCP (conversational + SSE stream) ──
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Session store for multi-turn conversations
const sessions = new Map<string, { conversationId: string; description: string; history: string[] }>();

const SYSTEM_PROMPT = `Tu es un architecte de workflows OCC (Claude Chain Orchestrator), expert en création de chains d'agents IA.
Tu travailles pour un développeur francophone. Réponds TOUJOURS en français.

═══ TON RÔLE ═══
Tu crées des chains de haute qualité en utilisant les outils MCP du chain-orchestrator.
Tu dois être RIGOUREUX, PRÉCIS et COMPLET.

═══ PHASE 1 : ANALYSE & QUESTIONS ═══
Avant de créer quoi que ce soit, tu DOIS d'abord :
1. Analyser la demande de l'utilisateur
2. Identifier les ambiguïtés et les paramètres manquants
3. Poser des questions PRÉCISES pour clarifier :

Questions à considérer (pose UNIQUEMENT celles qui sont pertinentes) :
- Objectif exact : quel résultat final attendu ?
- Périmètre : sur quel projet/codebase/dossier travailler ?
- Langue/framework : Python, TypeScript, React, etc. ?
- Profondeur : analyse rapide ou audit exhaustif ?
- Output : rapport, code, fichier, PR, etc. ?
- Qualité : mode brouillon ou production ?
- Dépendances : faut-il utiliser des APIs externes, un browser, des fichiers ?
- Parallélisme : quelles parties peuvent tourner simultanément ?
- Validation : faut-il un gate humain avant certaines étapes ?
- Chains existantes : veut-il réutiliser/combiner des chains déjà créées ?

FORMAT DE RÉPONSE QUAND TU POSES DES QUESTIONS :
Commence ta réponse par "QUESTIONS:" suivi d'un JSON array :
QUESTIONS:["Question 1 ?", "Question 2 ?", "Question 3 ?"]

Ne pose que 2 à 5 questions maximum. Sois concis.
Si la demande est déjà claire et complète, passe directement à la création (Phase 2).

═══ PHASE 2 : CRÉATION ═══
Quand tu as assez d'infos (soit après les réponses, soit si la demande est claire) :

1. Utilise list_chains pour voir les chains existantes
2. Étudie 2-3 chains similaires avec get_chain
3. Conçois l'architecture optimale :
   - Identifie les steps parallélisables (pas de depends_on entre eux)
   - Utilise le bon type pour chaque step :
     * agent : step principal (LLM fait le travail)
     * router : aiguillage conditionnel (ex: si erreur → route A, sinon → route B)
     * transform : manipulation de données (json_extract, template, regex, truncate)
     * evaluator : scoring + décision (seuil de qualité, retry si score bas)
     * gate : pause pour validation humaine ou condition temporelle
     * merge : combine les outputs de steps parallèles (concat, smart_summary, pick_best)
     * browser : automatisation web (goto, click, screenshot, extract)
     * loop : répétition avec condition de sortie
     * subchain : réutilise une chain existante comme step
     * debate : multi-agents qui débattent (brainstorm, Devil's advocate)
   - Écris des agent_prompt DÉTAILLÉS (10+ lignes, avec contexte, contraintes, format attendu)
   - Configure les tools pertinents pour chaque step (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
   - Ajoute des pre_tools si un step a besoin de données injectées (lire un fichier, une variable d'env)
   - Configure les retry, cache, timeout quand pertinent

4. Crée la chain via create_chain puis add_step pour chaque étape
5. Vérifie avec get_chain que tout est correct

FORMAT DE RÉPONSE FINALE :
Commence par "CREATED:" suivi du nom de la chain :
CREATED:nom-de-la-chain

═══ PRINCIPES ═══
- Chaque agent_prompt doit être autonome : contient TOUT le contexte nécessaire
- Utilise {variable} pour référencer les outputs des steps précédents
- Les inputs de la chain sont accessibles via {input_name}
- Privilégie la qualité : mieux vaut 7 steps bien faits que 3 bâclés
- Les steps sans depends_on commun s'exécutent EN PARALLÈLE automatiquement
- Nomme les steps en kebab-case descriptif (analyze-code, generate-tests, write-report)`;

// POST /generate-chain — Start or continue a conversation
app.post("/generate-chain", async (req: Request, res: Response) => {
  const { description, sessionId, answers } = req.body;

  if (!description && !answers) {
    return res.status(400).json({ error: "description or answers required" });
  }

  try {
    const claudePath = process.env.CLAUDE_CLI ?? "claude";
    const chainsDir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
    const mcpConfig = path.join(chainsDir, "..", ".mcp.json");
    const allowedTools = [
      "mcp__chain-orchestrator__list_chains",
      "mcp__chain-orchestrator__get_chain",
      "mcp__chain-orchestrator__create_chain",
      "mcp__chain-orchestrator__add_step",
      "mcp__chain-orchestrator__update_step",
      "mcp__chain-orchestrator__add_pre_tool",
    ].join(",");

    let userMessage: string;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (answers && session) {
      // ── Continue conversation with answers ──────────────────
      // Reset session expiry on access
      if ((session as any)._timeout) { clearTimeout((session as any)._timeout); }
      const sid = session.conversationId;
      (session as any)._timeout = setTimeout(() => sessions.delete(sid), 600_000);

      userMessage = `Voici mes réponses à tes questions :\n\n${answers}\n\nMaintenant crée la chain avec les outils MCP.`;
      session.history.push(userMessage);
    } else {
      // ── New conversation ────────────────────────────────────
      const sid = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      session = { conversationId: sid, description: description!, history: [] };
      sessions.set(sid, session);
      userMessage = `Demande de l'utilisateur : "${description}"`;
      session.history.push(userMessage);

      // Auto-cleanup old sessions after 10 min (reset on each access)
      const sessionTimeout = setTimeout(() => sessions.delete(sid), 600_000);
      (session as any)._timeout = sessionTimeout;
    }

    const fullPrompt = session.history.length > 1
      ? `${SYSTEM_PROMPT}\n\n═══ HISTORIQUE ═══\n${session.history.join("\n\n---\n\n")}`
      : `${SYSTEM_PROMPT}\n\n${userMessage}`;

    process.stderr.write(`[generate-chain] Session ${session.conversationId}: ${userMessage.slice(0, 100)}...\n`);

    const { stdout } = await execFileAsync(claudePath, [
      "--print",
      "--mcp-config", mcpConfig,
      "--allowedTools", allowedTools,
      fullPrompt,
    ], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
      cwd: chainsDir,
    });

    const output = stdout.trim();
    process.stderr.write(`[generate-chain] Output: ${output.slice(0, 300)}...\n`);

    // ── Parse response ───────────────────────────────────────
    // Check if Claude is asking questions
    const questionsMatch = output.match(/QUESTIONS:\s*\[([^\]]+)\]/);
    if (questionsMatch) {
      try {
        const questions = JSON.parse(`[${questionsMatch[1]}]`) as string[];
        session.history.push(output);
        return res.json({
          status: "questions",
          sessionId: session.conversationId,
          questions,
          message: output.replace(/QUESTIONS:\s*\[.*\]/, "").trim(),
        });
      } catch { /* parse failed, treat as creation */ }
    }

    // Check if Claude created a chain
    const createdMatch = output.match(/CREATED:\s*([a-z0-9-]+)/i);
    const chainName = createdMatch?.[1]
      ?? output.match(/(?:chain[:\s]+["']?|créée?\s*:\s*["']?|name:\s*)([a-z0-9][a-z0-9-]*)/i)?.[1]
      ?? `voice-chain-${Date.now()}`;

    // Load the YAML from disk (created via MCP)
    let yaml = "";
    try {
      yaml = loadChainRaw(chainName);
    } catch {
      // Fallback: extract from output
      yaml = output;
      if (yaml.includes("```")) {
        const parts = yaml.split("```");
        if (parts.length >= 2) {
          yaml = parts[1].replace(/^ya?ml\n/, "");
        }
      }
    }

    // Cleanup session
    if (sessionId) sessions.delete(sessionId);

    process.stderr.write(`[generate-chain] Created chain: ${chainName}\n`);
    res.json({
      status: "created",
      chainName,
      yaml: yaml.trim(),
      summary: output.replace(/CREATED:.*/, "").trim().slice(0, 500),
    });
  } catch (err: any) {
    process.stderr.write(`[generate-chain] Error: ${err.message}\n`);
    res.status(500).json({ error: err.message ?? "Generation failed" });
  }
});

// ─── SSE Streaming endpoint for live Claude CLI output ───────────────────────
app.get("/generate-chain/stream/:sessionId", (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

  if (!session) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Session not found" })}\n\n`);
    res.end();
    return;
  }

  // Store SSE response for this session so the generate-chain POST can stream to it
  (session as any)._sseRes = res;

  req.on("close", () => {
    (session as any)._sseRes = undefined;
  });
});

// Streaming version of generate-chain: spawns Claude CLI and streams output via SSE
app.post("/generate-chain/stream", async (req: Request, res: Response) => {
  const { description, sessionId: existingSessionId, answers } = req.body;

  if (!description && !answers) {
    return res.status(400).json({ error: "description or answers required" });
  }

  const claudePath = process.env.CLAUDE_CLI ?? "claude";
  const chainsDir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
  const mcpConfig = path.join(chainsDir, "..", ".mcp.json");
  const allowedTools = [
    "mcp__chain-orchestrator__list_chains",
    "mcp__chain-orchestrator__get_chain",
    "mcp__chain-orchestrator__create_chain",
    "mcp__chain-orchestrator__add_step",
    "mcp__chain-orchestrator__update_step",
    "mcp__chain-orchestrator__add_pre_tool",
  ].join(",");

  // Create or resume session
  let session = existingSessionId ? sessions.get(existingSessionId) : undefined;
  const sid = session?.conversationId ?? `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (!session) {
    session = { conversationId: sid, description: description ?? "", history: [] };
    sessions.set(sid, session);
    setTimeout(() => sessions.delete(sid), 600_000);
  }

  // Build prompt
  let userMessage: string;
  if (answers && existingSessionId) {
    userMessage = `Voici mes réponses :\n\n${answers}\n\nMaintenant crée la chain.`;
  } else {
    userMessage = `Demande : "${description}"`;
  }
  session.history.push(userMessage);

  const fullPrompt = session.history.length > 1
    ? `${SYSTEM_PROMPT}\n\n═══ HISTORIQUE ═══\n${session.history.join("\n\n---\n\n")}`
    : `${SYSTEM_PROMPT}\n\n${userMessage}`;

  // ── Set up SSE response ────────────────────────────────────
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sendEvent = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: "start", sessionId: sid });

  // ── Spawn Claude CLI and stream output ─────────────────────
  const child: ChildProcess = spawn(claudePath, [
    "--print",
    "--mcp-config", mcpConfig,
    "--allowedTools", allowedTools,
    fullPrompt,
  ], {
    env: { ...process.env, NO_COLOR: "1" },
    cwd: chainsDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let fullOutput = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    fullOutput += text;
    sendEvent({ type: "text", content: text });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // Claude CLI outputs tool use info on stderr
    if (text.includes("mcp__")) {
      const toolMatch = text.match(/mcp__chain-orchestrator__(\w+)/);
      if (toolMatch) {
        sendEvent({ type: "tool", tool: toolMatch[1], raw: text.trim().slice(0, 200) });
      }
    }
    sendEvent({ type: "progress", content: text.trim().slice(0, 200) });
  });

  child.on("close", (code) => {
    const output = fullOutput.trim();

    // Parse result
    const questionsMatch = output.match(/QUESTIONS:\s*\[([^\]]+)\]/);
    if (questionsMatch) {
      try {
        const questions = JSON.parse(`[${questionsMatch[1]}]`) as string[];
        session!.history.push(output);
        sendEvent({
          type: "questions",
          sessionId: sid,
          questions,
          message: output.replace(/QUESTIONS:\s*\[.*\]/, "").trim(),
        });
        sendEvent({ type: "done" });
        res.end();
        return;
      } catch { /* parse failed */ }
    }

    // Extract chain name
    const createdMatch = output.match(/CREATED:\s*([a-z0-9-]+)/i);
    const chainName = createdMatch?.[1]
      ?? output.match(/(?:chain[:\s]+["']?|name:\s*)([a-z0-9][a-z0-9-]*)/i)?.[1]
      ?? `voice-chain-${Date.now()}`;

    let yaml = "";
    try { yaml = loadChainRaw(chainName); }
    catch {
      yaml = output;
      if (yaml.includes("```")) {
        const parts = yaml.split("```");
        if (parts.length >= 2) yaml = parts[1].replace(/^ya?ml\n/, "");
      }
    }

    if (existingSessionId) sessions.delete(existingSessionId);

    sendEvent({
      type: "created",
      chainName,
      yaml: yaml.trim(),
      summary: output.replace(/CREATED:.*/, "").trim().slice(0, 500),
    });
    sendEvent({ type: "done" });
    res.end();
  });

  child.on("error", (err) => {
    sendEvent({ type: "error", message: err.message });
    sendEvent({ type: "done" });
    res.end();
  });

  // Timeout
  const timeout = setTimeout(() => {
    child.kill();
    sendEvent({ type: "error", message: "Timeout (3 min)" });
    sendEvent({ type: "done" });
    res.end();
  }, 180_000);

  child.on("close", () => clearTimeout(timeout));

  req.on("close", () => { child.kill(); clearTimeout(timeout); });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.REST_PORT ?? "4242", 10);
const HOST = process.env.REST_HOST ?? "0.0.0.0";  // Listen on all interfaces for iPhone access
app.listen(PORT, HOST, () => {
  process.stderr.write(`[occ-rest] Listening on http://${HOST}:${PORT}\n`);
  validateClaudeBinary();
  loadMcpServers();
  loadPersistedExecutions();
  // Initialize queue with a runner that executes chains
  initQueue(async (job) => {
    const chain = loadChain(job.name);
    let executionId = "";
    const emitter = (event: ExecutionEvent) => {
      if (event.type === "execution_started") {
        executionId = event.executionId; // Capture ACTUAL executionId from executor
      }
      if (executionId) emitSSE(executionId, event);
    };
    await executeChain(chain, job.input, emitter);
    return executionId;
  });
  loadPersistedPipelineExecutions();
  setSSEEmitter(emitSSE);
  initScheduler();
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
  if (!process.env.VITEST) {
    process.stderr.write(`[occ-rest] Shutting down...\n`);
  }
  try { closeQueue(); } catch { /* ignore */ }
  try { await closeMcpClients(); } catch { /* ignore */ }
  try { closeStorage(); } catch { /* ignore */ }
  try { const { closeExtraDbs } = await import("./pretool-extras.js"); closeExtraDbs(); } catch { /* ignore */ }
  if (!process.env.VITEST) process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
