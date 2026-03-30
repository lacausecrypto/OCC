#!/usr/bin/env node
/**
 * OCC MCP Server — stdio transport
 * Exposes chain orchestration tools to Claude Code.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listChains, loadChain, loadChainRaw, saveChain, deleteChain } from "./loader.js";
import { executeChain, getExecution, getAllExecutions, cancelExecution, getPendingApprovals, approveGate } from "./executor.js";
import { getSchedules, createSchedule, toggleSchedule, deleteSchedule } from "./scheduler.js";
import { listPipelines, loadPipeline } from "./pipeline-loader.js";
import { executePipeline, getPipelineExecution, getAllPipelineExecutions } from "./pipeline-executor.js";
import type { ChainDefinition, ChainStep, PreTool, ExecutionEvent } from "./types.js";
import { lintChain, dryRunChain } from "./linter.js";
import { getChainStats } from "./storage.js";
import { getQueueStats, listQueueJobs } from "./queue.js";

// Also start REST server alongside MCP server
import "./rest.js";

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "occ-chain-orchestrator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_chains",
      description:
        "List all available agent chains. Returns names and descriptions.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "run_chain",
      description:
        "Execute an agent chain with a given input. " +
        "Runs steps in dependency order, steps without dependencies run in parallel. " +
        "Returns the final output when complete.",
      inputSchema: {
        type: "object",
        required: ["name", "input"],
        properties: {
          name: {
            type: "string",
            description: "Chain name (from list_chains)",
          },
          input: {
            type: "object",
            description: "Input variables for the chain (key: value pairs)",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    {
      name: "chain_status",
      description:
        "Check the status of a running or completed chain execution. " +
        "Returns per-step status, outputs, and durations.",
      inputSchema: {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: {
            type: "string",
            description: "Execution ID returned by run_chain",
          },
        },
      },
    },
    {
      name: "chain_result",
      description:
        "Get the final output of a completed chain execution.",
      inputSchema: {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: {
            type: "string",
            description: "Execution ID returned by run_chain",
          },
        },
      },
    },
    // ── Chain management ────────────────────────────────────────────────────
    {
      name: "get_chain",
      description:
        "Get the full definition of a chain: steps, prompts, tools, dependencies, inputs. " +
        "Use this before editing a chain to understand its current structure.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Chain name" },
        },
      },
    },
    {
      name: "create_chain",
      description:
        "Create a new agent chain from scratch. Define all steps with their prompts, " +
        "models, tools, and dependencies. Steps without depends_on run in parallel. " +
        "Available models: claude-opus-4-6 (powerful), claude-sonnet-4-6 (default), claude-haiku-4-5 (fast). " +
        "Available tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, or any custom tool pattern.",
      inputSchema: {
        type: "object",
        required: ["name", "steps", "output"],
        properties: {
          name: { type: "string", description: "Chain name (kebab-case, e.g. my-chain)" },
          description: { type: "string", description: "Human-readable description" },
          version: { type: "string", description: "Version string, e.g. '1.0'" },
          inputs: {
            type: "array",
            description: "Input variables the chain accepts",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", description: "Variable name, used as {name} in prompts" },
                description: { type: "string" },
                optional: { type: "boolean", default: false },
              },
            },
          },
          steps: {
            type: "array",
            description: "Ordered list of agent steps",
            items: {
              type: "object",
              required: ["id", "prompt", "output_var"],
              properties: {
                id: { type: "string", description: "Unique step identifier (snake_case)" },
                label: { type: "string", description: "Human-readable step name" },
                model: { type: "string", description: "Claude model (default: claude-sonnet-4-6)" },
                prompt: { type: "string", description: "Full prompt. Use {input.varname} or {other_step_output_var} for interpolation" },
                tools: {
                  type: "array",
                  items: { type: "string" },
                  description: "Tools Claude can use: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, or custom patterns like 'Bash(npm *)'"
                },
                depends_on: {
                  type: "array",
                  items: { type: "string" },
                  description: "IDs of steps that must complete before this one runs. Steps without depends_on run in parallel."
                },
                output_var: { type: "string", description: "Variable name for this step's output. Reference it in later steps as {output_var}" },
                cwd: { type: "string", description: "Working directory for Bash/file tools (optional, defaults to WORKSPACE_DIR)" },
                type: { type: "string", enum: ["agent", "router", "transform", "evaluator", "gate", "merge", "browser", "loop"], description: "Step type (default: agent)" },
                condition: { type: "string", description: "Condition expression — step is skipped if falsy. Ex: '{var} contains \"word\"'" },
                // Browser params
                browser_url: { type: "string", description: "Browser: starting URL (supports {var} substitution)" },
                browser_task: { type: "string", description: "Browser: task description for Claude" },
                browser_max_steps: { type: "number", description: "Browser: max actions (default: 20)" },
                browser_headless: { type: "boolean", description: "Browser: launch headless Chromium if no Chrome found" },
                browser_port: { type: "number", description: "Browser: Chrome debug port (default: auto-discover 9222-9229)" },
                browser_viewport: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, description: "Browser: viewport size (default: 1280x720)" },
                browser_wait_ms: { type: "number", description: "Browser: wait after navigation in ms (default: 3000)" },
                browser_output_format: { type: "string", enum: ["text", "markdown", "json", "screenshot"], description: "Browser: output format" },
                browser_page_name: { type: "string", description: "Browser: persistent page name (same name = same page between steps)" },
                browser_scroll_strategy: { type: "string", enum: ["auto", "full", "none"], description: "Browser: scroll strategy" },
                browser_cookies_domain: { type: "string", description: "Browser: filter cookies by domain" },
              },
            },
          },
          output: { type: "string", description: "The output_var from the final step to return as the chain result" },
        },
      },
    },
    {
      name: "update_chain",
      description:
        "Update a chain's metadata (name, description) or fully replace its steps and output. " +
        "To modify individual steps, prefer add_step / update_step / remove_step instead.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Current chain name" },
          new_name: { type: "string", description: "Rename the chain" },
          description: { type: "string", description: "New description" },
          inputs: { type: "array", description: "Replace chain inputs entirely", items: { type: "object" } },
          steps: { type: "array", description: "Replace all steps entirely", items: { type: "object" } },
          output: { type: "string", description: "New chain output var" },
        },
      },
    },
    {
      name: "delete_chain",
      description: "Permanently delete a chain YAML file.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Chain name to delete" },
        },
      },
    },
    {
      name: "add_step",
      description:
        "Add a new step to an existing chain. The step is appended after existing steps. " +
        "Specify depends_on to control execution order. " +
        "Optionally update the chain output to this new step.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "step"],
        properties: {
          chain_name: { type: "string", description: "Chain to modify" },
          step: {
            type: "object",
            required: ["id", "prompt", "output_var"],
            description: "Step definition",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              model: { type: "string" },
              prompt: { type: "string" },
              tools: { type: "array", items: { type: "string" } },
              depends_on: { type: "array", items: { type: "string" } },
              output_var: { type: "string" },
              cwd: { type: "string" },
              type: { type: "string", enum: ["agent", "router", "transform", "evaluator", "gate", "merge", "browser", "loop"] },
              condition: { type: "string" },
              // Browser params
              browser_url: { type: "string" },
              browser_task: { type: "string" },
              browser_max_steps: { type: "number" },
              browser_headless: { type: "boolean" },
              browser_port: { type: "number" },
              browser_viewport: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } } },
              browser_wait_ms: { type: "number" },
              browser_output_format: { type: "string", enum: ["text", "markdown", "json", "screenshot"] },
              browser_page_name: { type: "string" },
              browser_scroll_strategy: { type: "string", enum: ["auto", "full", "none"] },
              browser_cookies_domain: { type: "string" },
              pre_tools: {
                type: "array",
                description: "Pre-tools executed before the LLM call. Results injected as {inject_as} variables in the prompt.",
                items: {
                  type: "object",
                  required: ["type", "inject_as"],
                  properties: {
                    type: { type: "string", enum: ["current_datetime", "http_fetch", "web_search", "read_file", "write_file", "bash", "env_var"] },
                    inject_as: { type: "string", description: "Variable name available as {inject_as} in the prompt" },
                    label: { type: "string" },
                    url: { type: "string", description: "For http_fetch" },
                    query: { type: "string", description: "For web_search (supports {variables})" },
                    path: { type: "string", description: "For read_file / write_file" },
                    content: { type: "string", description: "For write_file (supports {variables})" },
                    command: { type: "string", description: "For bash (supports {variables})" },
                    var_name: { type: "string", description: "For env_var" },
                  },
                },
              },
            },
          },
          set_as_output: {
            type: "boolean",
            description: "If true, set this step's output_var as the chain output (default: false)",
          },
        },
      },
    },
    {
      name: "update_step",
      description:
        "Update a specific step within a chain. Only the fields you provide are changed. " +
        "Supports all step types: agent, router, transform, evaluator, gate, merge, browser, loop, subchain, debate.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "step_id"],
        properties: {
          chain_name: { type: "string", description: "Chain containing the step" },
          step_id: { type: "string", description: "ID of the step to update" },
          // Basic fields
          label: { type: "string" },
          model: { type: "string" },
          prompt: { type: "string" },
          tools: { type: "array", items: { type: "string" }, description: "Replaces the tools list entirely" },
          depends_on: { type: "array", items: { type: "string" }, description: "Replaces depends_on entirely" },
          output_var: { type: "string" },
          cwd: { type: "string" },
          pre_tools: { type: "array", description: "Replaces pre_tools entirely" },
          type: { type: "string", enum: ["agent", "router", "transform", "evaluator", "gate", "merge", "browser", "loop", "subchain", "debate"], description: "Change step type" },
          condition: { type: "string", description: "Conditional expression — step skipped if falsy" },
          // Router
          routes: { type: "object", description: "Router routes: {route_key: [step_ids]}" },
          default_route: { type: "string", description: "Router default route key" },
          // Evaluator
          input_var: { type: "string", description: "Evaluator input variable to evaluate" },
          criteria: { type: "string", description: "Evaluator criteria" },
          on_fail: { type: "string", enum: ["retry", "skip", "error"], description: "Evaluator on-fail action" },
          retry_target: { type: "string", description: "Evaluator step to retry on fail" },
          // Transform
          operation: { type: "string", enum: ["json_extract", "regex_match", "template", "split", "merge", "truncate", "replace", "filter", "map", "join", "to_json", "from_json"] },
          template_str: { type: "string" },
          regex: { type: "string" },
          json_path: { type: "string" },
          // Merge
          inputs: { type: "array", items: { type: "string" }, description: "Merge input variable names" },
          strategy: { type: "string", enum: ["concatenate", "json_array", "llm_summarize", "pick_best"] },
          // Loop
          items_var: { type: "string", description: "Loop items variable" },
          max_parallel: { type: "number", description: "Loop max parallel executions" },
          // Gate
          timeout_hours: { type: "number", description: "Gate timeout in hours" },
          gate_auto_approve_if: { type: "string", description: "Gate auto-approve condition" },
          // Browser
          browser_url: { type: "string" },
          browser_task: { type: "string" },
          browser_max_steps: { type: "number" },
          browser_headless: { type: "boolean" },
          browser_page_name: { type: "string" },
          // Subchain
          subchain: { type: "string", description: "Subchain name to execute" },
          subchain_input_map: { type: "object", description: "Map vars to subchain inputs" },
          // Meta
          set_as_output: { type: "boolean", description: "Set this step's output_var as the chain output" },
        },
      },
    },
    {
      name: "remove_step",
      description:
        "Remove a step from a chain. Automatically removes it from other steps' depends_on. " +
        "If the removed step was the chain output, the output is updated to the last remaining step.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "step_id"],
        properties: {
          chain_name: { type: "string" },
          step_id: { type: "string" },
        },
      },
    },

    {
      name: "add_pre_tool",
      description:
        "Add a pre-tool to a step. Pre-tools run BEFORE the LLM call and inject results as {inject_as} variables into the prompt. " +
        "Types: current_datetime (no params), web_search (query), http_fetch (url), read_file (path), write_file (path + content), bash (command), env_var (var_name). " +
        "Example: add web_search with query '{topic} latest 2025' inject_as 'web_data', then use {web_data} in the prompt. " +
        "write_file writes resolved content (with {variables}) to a file, injecting the path as variable — ideal for materializing large step outputs to disk before a tool-using step.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "step_id", "type", "inject_as"],
        properties: {
          chain_name: { type: "string" },
          step_id: { type: "string" },
          type: { type: "string", enum: ["current_datetime", "http_fetch", "web_search", "read_file", "write_file", "bash", "env_var"] },
          inject_as: { type: "string", description: "Variable name usable as {inject_as} in the step prompt" },
          label: { type: "string" },
          url: { type: "string" },
          query: { type: "string" },
          path: { type: "string" },
          command: { type: "string" },
          var_name: { type: "string" },
        },
      },
    },
    {
      name: "remove_pre_tool",
      description: "Remove a pre-tool from a step by its inject_as variable name.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "step_id", "inject_as"],
        properties: {
          chain_name: { type: "string" },
          step_id: { type: "string" },
          inject_as: { type: "string", description: "The inject_as variable name of the pre-tool to remove" },
        },
      },
    },

    // ── Schedules ────────────────────────────────────────────────────────────
    {
      name: "list_schedules",
      description:
        "List all scheduled chain executions. " +
        "Returns each schedule with its id, label, chain name, cron expression, " +
        "enabled state, last run status, and next run time.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "create_schedule",
      description:
        "Schedule a chain to run automatically on a cron expression. " +
        "Use standard 5-field cron syntax (min hour day month weekday). " +
        "Examples: '0 8 * * 1' = every Monday 8h, '0 */6 * * *' = every 6h, " +
        "'0 9 * * *' = daily at 9h, '*/30 * * * *' = every 30 minutes. " +
        "Returns the created schedule with its id.",
      inputSchema: {
        type: "object",
        required: ["chain_name", "cron"],
        properties: {
          chain_name: {
            type: "string",
            description: "Name of the chain to schedule (from list_chains)",
          },
          cron: {
            type: "string",
            description: "Cron expression (5 fields: min hour day month weekday)",
          },
          label: {
            type: "string",
            description: "Human-readable label for this schedule",
          },
          input: {
            type: "object",
            description: "Preset input variables for the chain (key: value)",
            additionalProperties: { type: "string" },
          },
          enabled: {
            type: "boolean",
            description: "Whether to enable immediately (default: true)",
          },
        },
      },
    },
    {
      name: "delete_schedule",
      description: "Delete a scheduled chain execution by its id.",
      inputSchema: {
        type: "object",
        required: ["schedule_id"],
        properties: {
          schedule_id: {
            type: "string",
            description: "Schedule id (from list_schedules or create_schedule)",
          },
        },
      },
    },
    {
      name: "toggle_schedule",
      description: "Enable or disable a scheduled chain execution.",
      inputSchema: {
        type: "object",
        required: ["schedule_id"],
        properties: {
          schedule_id: {
            type: "string",
            description: "Schedule id (from list_schedules)",
          },
        },
      },
    },
    // ── Gate Approvals ──────────────────────────────────────────────────────
    {
      name: "list_pending_approvals",
      description:
        "List all chain steps that are waiting for human approval (gate nodes). " +
        "Returns each pending approval with executionId, stepId, chainName, prompt, and startedAt. " +
        "Use approve_gate to approve or reject a pending gate.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "approve_gate",
      description:
        "Approve or reject a pending gate step. Gate steps pause the chain execution " +
        "until a human decision is made. Use list_pending_approvals to see what's waiting. " +
        "Approved gates continue the chain. Rejected gates abort the chain with an error.",
      inputSchema: {
        type: "object",
        required: ["execution_id", "step_id", "approved"],
        properties: {
          execution_id: {
            type: "string",
            description: "Execution ID (from list_pending_approvals)",
          },
          step_id: {
            type: "string",
            description: "Step ID of the gate to approve/reject (from list_pending_approvals)",
          },
          approved: {
            type: "boolean",
            description: "true = approve and continue the chain, false = reject and abort",
          },
        },
      },
    },

    // ── Execution management ──────────────────────────────────────────────
    {
      name: "list_executions",
      description:
        "List recent chain executions (last 50). Returns id, chain name, status, duration, and timestamps.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "cancel_execution",
      description:
        "Cancel a running chain execution. Kills all active processes and marks remaining steps as skipped.",
      inputSchema: {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: {
            type: "string",
            description: "Execution ID to cancel",
          },
        },
      },
    },

    // ── Pipelines (multi-chain) ──────────────────────────────────────────
    {
      name: "list_pipelines",
      description:
        "List all available pipelines (multi-chain workflows). Returns names, descriptions, and chain counts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_pipeline",
      description:
        "Get the full definition of a pipeline: chains, dependencies, inputs, and output.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Pipeline name" },
        },
      },
    },
    {
      name: "run_pipeline",
      description:
        "Execute a pipeline (multi-chain workflow). Runs chains in dependency order. " +
        "Returns the final output when complete.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Pipeline name (from list_pipelines)" },
          input: {
            type: "object",
            description: "Input variables for the pipeline (key: value pairs)",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    {
      name: "pipeline_status",
      description:
        "Check the status of a pipeline execution. Returns per-chain status and results.",
      inputSchema: {
        type: "object",
        required: ["execution_id"],
        properties: {
          execution_id: {
            type: "string",
            description: "Pipeline execution ID (starts with pip_)",
          },
        },
      },
    },
    {
      name: "dry_run_chain",
      description:
        "Preview the execution plan and cost estimate for a chain WITHOUT making any LLM calls. " +
        "Shows execution waves, parallel steps, model assignments, prompt previews, and estimated cost.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Chain name" },
          input: {
            type: "object",
            description: "Input variables for the chain",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    {
      name: "chain_stats",
      description:
        "Get execution statistics for a chain from the SQLite database. " +
        "Returns total runs, success rate, average duration, and total token usage.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Chain name" },
        },
      },
    },
    {
      name: "queue_status",
      description:
        "Get the current queue status: queued jobs, running workers, completed count, " +
        "average wait time, and recent jobs.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── list_chains ──────────────────────────────────────────────────────
      case "list_chains": {
        const names = listChains();
        if (names.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No chains found. Create a YAML chain file in the chains/ directory.",
              },
            ],
          };
        }
        const details = names.map((n) => {
          try {
            const chain = loadChain(n);
            return `• ${n}: ${chain.description ?? "no description"} (${chain.steps.length} steps)`;
          } catch {
            return `• ${n}: [invalid YAML]`;
          }
        });
        return {
          content: [
            {
              type: "text",
              text: `Available chains (${names.length}):\n${details.join("\n")}`,
            },
          ],
        };
      }

      // ── run_chain ────────────────────────────────────────────────────────
      case "run_chain": {
        const chainName = args?.name as string;
        const input = (args?.input ?? {}) as Record<string, string>;

        if (!chainName) {
          throw new Error("Missing required argument: name");
        }

        const chain = loadChain(chainName);

        // Execute and collect progress messages
        const messages: string[] = [];
        messages.push(`Starting chain: ${chain.name}`);
        if (chain.description) messages.push(chain.description);
        messages.push(`Steps: ${chain.steps.map((s) => s.label ?? s.id).join(" → ")}`);
        messages.push("─".repeat(50));

        let executionId = "";
        const result = await executeChain(chain, input, (event) => {
          switch (event.type) {
            case "execution_started":
              executionId = event.executionId;
              messages.push(`Execution ID: ${event.executionId}`);
              break;
            case "step_started":
              messages.push(`\n▶ ${event.label ?? event.stepId}...`);
              break;
            case "step_done":
              messages.push(`✓ done (${(event.durationMs / 1000).toFixed(1)}s)`);
              break;
            case "step_error":
              messages.push(`✗ error: ${event.error}`);
              break;
            case "execution_done":
              messages.push(`\n${"─".repeat(50)}`);
              messages.push(`✓ Chain complete (${(event.durationMs / 1000).toFixed(1)}s)`);
              break;
          }
        });

        messages.push("\n── RESULT ──");
        messages.push(result);

        return {
          content: [{ type: "text", text: messages.join("\n") }],
        };
      }

      // ── chain_status ─────────────────────────────────────────────────────
      case "chain_status": {
        const executionId = args?.execution_id as string;
        if (!executionId) throw new Error("Missing required argument: execution_id");

        const execution = getExecution(executionId);
        if (!execution) {
          throw new Error(`Execution "${executionId}" not found`);
        }

        const lines: string[] = [
          `Chain: ${execution.chainName}`,
          `Status: ${execution.status}`,
          `Started: ${execution.startedAt}`,
        ];
        if (execution.finishedAt) lines.push(`Finished: ${execution.finishedAt}`);
        if (execution.durationMs) lines.push(`Duration: ${(execution.durationMs / 1000).toFixed(1)}s`);

        lines.push("\nSteps:");
        for (const [stepId, step] of Object.entries(execution.steps)) {
          const icon =
            step.status === "done" ? "✓"
            : step.status === "error" ? "✗"
            : step.status === "running" ? "▶"
            : step.status === "skipped" ? "–"
            : "○";
          const dur = step.durationMs ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : "";
          lines.push(`  ${icon} ${stepId}${dur}: ${step.status}`);
          if (step.error) lines.push(`    Error: ${step.error}`);
        }

        if (execution.error) {
          lines.push(`\nError: ${execution.error}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── chain_result ─────────────────────────────────────────────────────
      case "chain_result": {
        const executionId = args?.execution_id as string;
        if (!executionId) throw new Error("Missing required argument: execution_id");

        const execution = getExecution(executionId);
        if (!execution) throw new Error(`Execution "${executionId}" not found`);

        if (execution.status === "running") {
          return {
            content: [{ type: "text", text: "Execution still in progress. Use chain_status to monitor." }],
          };
        }
        if (execution.status === "error") {
          return {
            content: [{ type: "text", text: `Execution failed: ${execution.error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: execution.result ?? "" }],
        };
      }

      // ── get_chain ────────────────────────────────────────────────────────
      case "get_chain": {
        const name = args?.name as string;
        if (!name) throw new Error("Missing required argument: name");
        const chain = loadChain(name);
        const lines: string[] = [
          `Chain: ${chain.name}`,
          chain.description ? `Description: ${chain.description}` : "",
          chain.version ? `Version: ${chain.version}` : "",
          "",
          `Inputs (${chain.inputs?.length ?? 0}):`,
          ...(chain.inputs ?? []).map((i) =>
            `  • ${i.name}${i.optional ? " (optional)" : " (required)"}: ${i.description ?? ""}`
          ),
          "",
          `Steps (${chain.steps.length}):`,
          ...chain.steps.map((s, idx) => [
            `  [${idx + 1}] id: ${s.id}`,
            `      label: ${s.label ?? "(none)"}`,
            `      model: ${s.model ?? "claude-sonnet-4-6 (default)"}`,
            `      output_var: ${s.output_var}`,
            `      depends_on: ${s.depends_on?.length ? s.depends_on.join(", ") : "(none — runs first/parallel)"}`,
            `      tools: ${s.tools?.length ? s.tools.join(", ") : "(none)"}`,
            s.cwd ? `      cwd: ${s.cwd}` : "",
            `      prompt:\n${s.prompt.split("\n").map((l) => `        ${l}`).join("\n")}`,
          ].filter(Boolean).join("\n")),
          "",
          `Chain output: ${chain.output}`,
        ].filter((l) => l !== undefined);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── create_chain ──────────────────────────────────────────────────────
      case "create_chain": {
        const name = args?.name as string;
        if (!name) throw new Error("Missing required argument: name");
        if (!args?.steps || !Array.isArray(args.steps) || args.steps.length === 0)
          throw new Error("Missing required argument: steps (must be non-empty array)");
        if (!args?.output) throw new Error("Missing required argument: output");

        const chain: ChainDefinition = {
          name,
          description: args.description as string | undefined,
          version: (args.version as string | undefined) ?? "1.0",
          inputs: (args.inputs as ChainDefinition["inputs"]) ?? [],
          steps: args.steps as ChainStep[],
          output: args.output as string,
        };

        // Validate by running through loader's schema indirectly
        saveChain(name, chain);

        const stepSummary = chain.steps.map((s) =>
          `  • ${s.id} → ${s.output_var}${s.depends_on?.length ? ` (after: ${s.depends_on.join(", ")})` : ""}`
        ).join("\n");

        return {
          content: [{
            type: "text",
            text: [
              `✓ Chain "${name}" created (${chain.steps.length} steps)`,
              stepSummary,
              `  Output: ${chain.output}`,
            ].join("\n"),
          }],
        };
      }

      // ── update_chain ──────────────────────────────────────────────────────
      case "update_chain": {
        const name = args?.name as string;
        if (!name) throw new Error("Missing required argument: name");
        const chain = loadChain(name);

        if (args?.description !== undefined) chain.description = args.description as string;
        if (args?.inputs !== undefined) chain.inputs = args.inputs as ChainDefinition["inputs"];
        if (args?.steps !== undefined) chain.steps = args.steps as ChainStep[];
        if (args?.output !== undefined) chain.output = args.output as string;

        const newName = (args?.new_name as string | undefined) ?? name;
        chain.name = newName;

        saveChain(newName, chain);
        if (newName !== name) deleteChain(name);

        return {
          content: [{
            type: "text",
            text: `✓ Chain "${name}"${newName !== name ? ` renamed to "${newName}"` : ""} updated (${chain.steps.length} steps, output: ${chain.output}).`,
          }],
        };
      }

      // ── delete_chain ──────────────────────────────────────────────────────
      case "delete_chain": {
        const name = args?.name as string;
        if (!name) throw new Error("Missing required argument: name");
        deleteChain(name);
        return { content: [{ type: "text", text: `✓ Chain "${name}" deleted.` }] };
      }

      // ── add_step ──────────────────────────────────────────────────────────
      case "add_step": {
        const chainName = args?.chain_name as string;
        if (!chainName) throw new Error("Missing required argument: chain_name");
        const stepDef = args?.step as ChainStep;
        if (!stepDef?.id || !stepDef?.prompt || !stepDef?.output_var)
          throw new Error("step must have id, prompt, and output_var");

        const chain = loadChain(chainName);

        if (chain.steps.find((s) => s.id === stepDef.id))
          throw new Error(`Step id "${stepDef.id}" already exists in chain "${chainName}"`);

        chain.steps.push(stepDef);
        if (args?.set_as_output) chain.output = stepDef.output_var;

        saveChain(chainName, chain);

        return {
          content: [{
            type: "text",
            text: [
              `✓ Step "${stepDef.id}" added to chain "${chainName}"`,
              `  model: ${stepDef.model ?? "sonnet (default)"}`,
              `  tools: ${stepDef.tools?.length ? stepDef.tools.join(", ") : "none"}`,
              `  depends_on: ${stepDef.depends_on?.length ? stepDef.depends_on.join(", ") : "none (parallel)"}`,
              `  output_var: ${stepDef.output_var}`,
              args?.set_as_output ? `  ⬆ chain output updated to: ${stepDef.output_var}` : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      }

      // ── update_step ───────────────────────────────────────────────────────
      case "update_step": {
        const chainName = args?.chain_name as string;
        const stepId = args?.step_id as string;
        if (!chainName) throw new Error("Missing required argument: chain_name");
        if (!stepId) throw new Error("Missing required argument: step_id");

        const chain = loadChain(chainName);
        const step = chain.steps.find((s) => s.id === stepId);
        if (!step) throw new Error(`Step "${stepId}" not found in chain "${chainName}"`);

        const changed: string[] = [];
        // Basic fields
        if (args?.label !== undefined) { step.label = args.label as string; changed.push("label"); }
        if (args?.model !== undefined) { step.model = args.model as string; changed.push("model"); }
        if (args?.prompt !== undefined) { step.prompt = args.prompt as string; changed.push("prompt"); }
        if (args?.tools !== undefined) { step.tools = args.tools as string[]; changed.push("tools"); }
        if (args?.depends_on !== undefined) { step.depends_on = args.depends_on as string[]; changed.push("depends_on"); }
        if (args?.output_var !== undefined) { step.output_var = args.output_var as string; changed.push("output_var"); }
        if (args?.cwd !== undefined) { step.cwd = args.cwd as string; changed.push("cwd"); }
        if (args?.pre_tools !== undefined) { step.pre_tools = args.pre_tools as PreTool[]; changed.push("pre_tools"); }
        if (args?.type !== undefined) { step.type = args.type as ChainStep["type"]; changed.push("type"); }
        if (args?.condition !== undefined) { step.condition = args.condition as string; changed.push("condition"); }
        // Router
        if (args?.routes !== undefined) { step.routes = args.routes as Record<string, string[]>; changed.push("routes"); }
        if (args?.default_route !== undefined) { step.default_route = args.default_route as string; changed.push("default_route"); }
        // Evaluator
        if (args?.input_var !== undefined) { step.input_var = args.input_var as string; changed.push("input_var"); }
        if (args?.criteria !== undefined) { step.criteria = args.criteria as string; changed.push("criteria"); }
        if (args?.on_fail !== undefined) { step.on_fail = args.on_fail as ChainStep["on_fail"]; changed.push("on_fail"); }
        if (args?.retry_target !== undefined) { step.retry_target = args.retry_target as string; changed.push("retry_target"); }
        // Transform
        if (args?.operation !== undefined) { step.operation = args.operation as ChainStep["operation"]; changed.push("operation"); }
        if (args?.template_str !== undefined) { step.template_str = args.template_str as string; changed.push("template_str"); }
        if (args?.regex !== undefined) { step.regex = args.regex as string; changed.push("regex"); }
        if (args?.json_path !== undefined) { step.json_path = args.json_path as string; changed.push("json_path"); }
        // Merge
        if (args?.inputs !== undefined) { step.inputs = args.inputs as string[]; changed.push("inputs"); }
        if (args?.strategy !== undefined) { step.strategy = args.strategy as ChainStep["strategy"]; changed.push("strategy"); }
        // Loop
        if (args?.items_var !== undefined) { step.items_var = args.items_var as string; changed.push("items_var"); }
        if (args?.max_parallel !== undefined) { step.max_parallel = args.max_parallel as number; changed.push("max_parallel"); }
        // Gate
        if (args?.timeout_hours !== undefined) { step.timeout_hours = args.timeout_hours as number; changed.push("timeout_hours"); }
        if (args?.gate_auto_approve_if !== undefined) { step.gate_auto_approve_if = args.gate_auto_approve_if as string; changed.push("gate_auto_approve_if"); }
        // Browser
        if (args?.browser_url !== undefined) { step.browser_url = args.browser_url as string; changed.push("browser_url"); }
        if (args?.browser_task !== undefined) { step.browser_task = args.browser_task as string; changed.push("browser_task"); }
        if (args?.browser_max_steps !== undefined) { step.browser_max_steps = args.browser_max_steps as number; changed.push("browser_max_steps"); }
        if (args?.browser_headless !== undefined) { step.browser_headless = args.browser_headless as boolean; changed.push("browser_headless"); }
        if (args?.browser_page_name !== undefined) { step.browser_page_name = args.browser_page_name as string; changed.push("browser_page_name"); }
        // Subchain
        if (args?.subchain !== undefined) { step.subchain = args.subchain as string; changed.push("subchain"); }
        if (args?.subchain_input_map !== undefined) { step.subchain_input_map = args.subchain_input_map as Record<string, string>; changed.push("subchain_input_map"); }
        // Chain output
        if (args?.set_as_output) { chain.output = step.output_var; changed.push("chain output"); }

        if (changed.length === 0) return { content: [{ type: "text", text: "No fields changed." }] };

        saveChain(chainName, chain);
        return {
          content: [{
            type: "text",
            text: `✓ Step "${stepId}" in chain "${chainName}" updated.\n  Changed: ${changed.join(", ")}`,
          }],
        };
      }

      // ── remove_step ───────────────────────────────────────────────────────
      case "remove_step": {
        const chainName = args?.chain_name as string;
        const stepId = args?.step_id as string;
        if (!chainName) throw new Error("Missing required argument: chain_name");
        if (!stepId) throw new Error("Missing required argument: step_id");

        const chain = loadChain(chainName);
        if (!chain.steps.find((s) => s.id === stepId))
          throw new Error(`Step "${stepId}" not found in chain "${chainName}"`);

        // Remove step and clean up depends_on references
        chain.steps = chain.steps.filter((s) => s.id !== stepId);
        for (const s of chain.steps) {
          if (s.depends_on) s.depends_on = s.depends_on.filter((d) => d !== stepId);
        }

        // If the removed step was the chain output, fallback to last step
        const outputStillExists = chain.steps.some((s) => s.output_var === chain.output);
        if (!outputStillExists && chain.steps.length > 0) {
          chain.output = chain.steps[chain.steps.length - 1].output_var;
        }

        saveChain(chainName, chain);
        return {
          content: [{
            type: "text",
            text: `✓ Step "${stepId}" removed from chain "${chainName}" (${chain.steps.length} steps remaining, output: ${chain.output}).`,
          }],
        };
      }

      // ── add_pre_tool ──────────────────────────────────────────────────────
      case "add_pre_tool": {
        const chainName = args?.chain_name as string;
        const stepId = args?.step_id as string;
        if (!chainName) throw new Error("Missing required argument: chain_name");
        if (!stepId) throw new Error("Missing required argument: step_id");
        if (!args?.type) throw new Error("Missing required argument: type");
        if (!args?.inject_as) throw new Error("Missing required argument: inject_as");

        const chain = loadChain(chainName);
        const step = chain.steps.find((s) => s.id === stepId);
        if (!step) throw new Error(`Step "${stepId}" not found in chain "${chainName}"`);

        const newTool: PreTool = { type: args.type as PreTool["type"], inject_as: args.inject_as as string };
        if (args.label) newTool.label = args.label as string;
        if (args.url) newTool.url = args.url as string;
        if (args.query) newTool.query = args.query as string;
        if (args.path) newTool.path = args.path as string;
        if (args.command) newTool.command = args.command as string;
        if (args.var_name) newTool.var_name = args.var_name as string;

        step.pre_tools = [...(step.pre_tools ?? []), newTool];
        saveChain(chainName, chain);
        return {
          content: [{
            type: "text",
            text: `✓ Pre-tool added to step "${stepId}" in chain "${chainName}".\n  type: ${newTool.type} → {${newTool.inject_as}}\n  Add {${newTool.inject_as}} to the step prompt to use it.`,
          }],
        };
      }

      // ── remove_pre_tool ───────────────────────────────────────────────────
      case "remove_pre_tool": {
        const chainName = args?.chain_name as string;
        const stepId = args?.step_id as string;
        const injectAs = args?.inject_as as string;
        if (!chainName || !stepId || !injectAs) throw new Error("Missing required arguments");

        const chain = loadChain(chainName);
        const step = chain.steps.find((s) => s.id === stepId);
        if (!step) throw new Error(`Step "${stepId}" not found`);

        const before = step.pre_tools?.length ?? 0;
        step.pre_tools = (step.pre_tools ?? []).filter((t) => t.inject_as !== injectAs);
        if (step.pre_tools.length === before) throw new Error(`No pre-tool with inject_as="${injectAs}" found`);

        saveChain(chainName, chain);
        return {
          content: [{ type: "text", text: `✓ Pre-tool {${injectAs}} removed from step "${stepId}" in chain "${chainName}".` }],
        };
      }

      // ── list_schedules ────────────────────────────────────────────────────
      case "list_schedules": {
        const schedules = getSchedules();
        if (schedules.length === 0) {
          return { content: [{ type: "text", text: "No schedules configured yet. Use create_schedule to add one." }] };
        }
        const lines = schedules.map((s) => {
          const status = s.enabled ? "enabled" : "disabled";
          const last = s.lastRunAt
            ? ` | last: ${s.lastRunStatus ?? "?"} at ${new Date(s.lastRunAt).toLocaleString()}`
            : "";
          const next = s.nextRunAt ? ` | next: ${new Date(s.nextRunAt).toLocaleString()}` : "";
          const inputStr = Object.keys(s.input).length
            ? ` | inputs: ${Object.entries(s.input).map(([k, v]) => `${k}="${v}"`).join(", ")}`
            : "";
          return `• [${s.id}] ${s.label} (${status})\n  chain: ${s.chainName} | cron: ${s.cron}${inputStr}${last}${next}`;
        });
        return {
          content: [{ type: "text", text: `Schedules (${schedules.length}):\n\n${lines.join("\n\n")}` }],
        };
      }

      // ── create_schedule ───────────────────────────────────────────────────
      case "create_schedule": {
        const chainName = args?.chain_name as string;
        const cronExpr = args?.cron as string;
        if (!chainName) throw new Error("Missing required argument: chain_name");
        if (!cronExpr) throw new Error("Missing required argument: cron");

        // Validate chain exists
        loadChain(chainName);

        const schedule = createSchedule({
          label: (args?.label as string) || `${chainName} @ ${cronExpr}`,
          chainName,
          cron: cronExpr,
          input: (args?.input as Record<string, string>) ?? {},
          enabled: (args?.enabled as boolean) ?? true,
        });

        return {
          content: [{
            type: "text",
            text: [
              `✓ Schedule created: ${schedule.label}`,
              `  ID: ${schedule.id}`,
              `  Chain: ${schedule.chainName}`,
              `  Cron: ${schedule.cron}`,
              `  Status: ${schedule.enabled ? "enabled ✓" : "disabled"}`,
              schedule.nextRunAt ? `  Next run: ${new Date(schedule.nextRunAt).toLocaleString()}` : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      }

      // ── delete_schedule ───────────────────────────────────────────────────
      case "delete_schedule": {
        const id = args?.schedule_id as string;
        if (!id) throw new Error("Missing required argument: schedule_id");
        const ok = deleteSchedule(id);
        if (!ok) throw new Error(`Schedule "${id}" not found`);
        return { content: [{ type: "text", text: `✓ Schedule ${id} deleted.` }] };
      }

      // ── toggle_schedule ───────────────────────────────────────────────────
      case "toggle_schedule": {
        const id = args?.schedule_id as string;
        if (!id) throw new Error("Missing required argument: schedule_id");
        const s = toggleSchedule(id);
        if (!s) throw new Error(`Schedule "${id}" not found`);
        return {
          content: [{
            type: "text",
            text: `✓ Schedule "${s.label}" is now ${s.enabled ? "enabled ✓" : "disabled"}.`,
          }],
        };
      }

      // ── list_pending_approvals ───────────────────────────────────────────
      case "list_pending_approvals": {
        const pending = getPendingApprovals();
        if (pending.length === 0) {
          return {
            content: [{ type: "text", text: "No pending gate approvals. All gates have been resolved." }],
          };
        }
        const lines = pending.map((p, i) =>
          `${i + 1}. **${p.stepId}** (chain: ${p.chainName})\n   Execution: ${p.executionId}\n   Waiting since: ${p.startedAt}\n   ${p.prompt ? `Prompt: ${p.prompt.slice(0, 200)}${p.prompt.length > 200 ? "…" : ""}` : ""}`
        );
        return {
          content: [{
            type: "text",
            text: `🔒 **${pending.length} pending approval${pending.length > 1 ? "s" : ""}:**\n\n${lines.join("\n\n")}\n\nUse \`approve_gate\` with the execution_id and step_id to approve or reject.`,
          }],
        };
      }

      // ── approve_gate ──────────────────────────────────────────────────────
      case "approve_gate": {
        const executionId = args?.execution_id as string;
        const stepId = args?.step_id as string;
        const approved = args?.approved as boolean;
        if (!executionId || !stepId) throw new Error("Missing required arguments: execution_id and step_id");
        if (typeof approved !== "boolean") throw new Error("approved must be true or false");

        const success = approveGate(executionId, stepId, approved);
        if (!success) {
          throw new Error(`No pending approval found for execution "${executionId}" step "${stepId}". Use list_pending_approvals to see what's waiting.`);
        }

        return {
          content: [{
            type: "text",
            text: approved
              ? `✅ Gate "${stepId}" **approved**. The chain will continue executing.`
              : `❌ Gate "${stepId}" **rejected**. The chain will abort.`,
          }],
        };
      }

      // ── list_executions ──────────────────────────────────────────────
      case "list_executions": {
        const all = getAllExecutions().slice(0, 50);
        if (all.length === 0) {
          return { content: [{ type: "text", text: "No executions found." }] };
        }
        const lines = all.map((ex) => {
          const icon = ex.status === "done" ? "✓" : ex.status === "error" ? "✗" : ex.status === "running" ? "▶" : "○";
          const dur = ex.durationMs ? ` (${(ex.durationMs / 1000).toFixed(1)}s)` : "";
          const steps = Object.values(ex.steps);
          const doneSteps = steps.filter(s => s.status === "done").length;
          return `${icon} [${ex.id}] ${ex.chainName} — ${ex.status}${dur} — ${doneSteps}/${steps.length} steps — ${ex.startedAt}`;
        });
        return { content: [{ type: "text", text: `Recent executions (${all.length}):\n\n${lines.join("\n")}` }] };
      }

      // ── cancel_execution ────────────────────────────────────────────
      case "cancel_execution": {
        const executionId = args?.execution_id as string;
        if (!executionId) throw new Error("Missing required argument: execution_id");
        const ok = cancelExecution(executionId);
        if (!ok) throw new Error(`Execution "${executionId}" not found or already finished`);
        return { content: [{ type: "text", text: `✓ Execution "${executionId}" cancelled.` }] };
      }

      // ── list_pipelines ──────────────────────────────────────────────
      case "list_pipelines": {
        const names = listPipelines();
        if (names.length === 0) {
          return { content: [{ type: "text", text: "No pipelines found. Create a YAML pipeline file in the pipelines/ directory." }] };
        }
        const details = names.map((n) => {
          try {
            const p = loadPipeline(n);
            return `• ${n}: ${p.description ?? "no description"} (${p.chains.length} chains)`;
          } catch {
            return `• ${n}: [invalid YAML]`;
          }
        });
        return { content: [{ type: "text", text: `Available pipelines (${names.length}):\n${details.join("\n")}` }] };
      }

      // ── get_pipeline ────────────────────────────────────────────────
      case "get_pipeline": {
        const pName = args?.name as string;
        if (!pName) throw new Error("Missing required argument: name");
        const pipeline = loadPipeline(pName);
        const lines: string[] = [
          `Pipeline: ${pipeline.name}`,
          pipeline.description ? `Description: ${pipeline.description}` : "",
          pipeline.version ? `Version: ${pipeline.version}` : "",
          "",
          `Inputs (${pipeline.inputs?.length ?? 0}):`,
          ...(pipeline.inputs ?? []).map(i => `  • ${i.name}${i.optional ? " (optional)" : " (required)"}: ${i.description ?? ""}`),
          "",
          `Chains (${pipeline.chains.length}):`,
          ...pipeline.chains.map((c, idx) => [
            `  [${idx + 1}] id: ${c.id} → chain: ${c.chain}`,
            c.label ? `      label: ${c.label}` : "",
            `      depends_on: ${c.depends_on?.length ? c.depends_on.join(", ") : "(none — runs first)"}`,
            c.condition ? `      condition: ${c.condition}` : "",
            `      inputs: ${Object.entries(c.inputs).map(([k, v]) => `${k}="${v}"`).join(", ") || "(none)"}`,
          ].filter(Boolean).join("\n")),
          "",
          `Pipeline output: ${pipeline.output}`,
        ].filter(l => l !== undefined);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── run_pipeline ────────────────────────────────────────────────
      case "run_pipeline": {
        const pName = args?.name as string;
        const pInput = (args?.input ?? {}) as Record<string, string>;
        if (!pName) throw new Error("Missing required argument: name");

        const pipeline = loadPipeline(pName);
        const messages: string[] = [];
        messages.push(`Starting pipeline: ${pipeline.name}`);
        if (pipeline.description) messages.push(pipeline.description);
        messages.push(`Chains: ${pipeline.chains.map(c => c.label ?? c.chain).join(" → ")}`);
        messages.push("─".repeat(50));

        const result = await executePipeline(pipeline, pInput, (event: ExecutionEvent) => {
          switch (event.type) {
            case "execution_started":
              messages.push(`Execution ID: ${event.executionId}`);
              break;
            case "step_started":
              messages.push(`\n▶ ${event.label ?? event.stepId}...`);
              break;
            case "step_done":
              messages.push(`✓ done (${(event.durationMs / 1000).toFixed(1)}s)`);
              break;
            case "step_error":
              messages.push(`✗ error: ${event.error}`);
              break;
            case "execution_done":
              messages.push(`\n${"─".repeat(50)}`);
              messages.push(`✓ Pipeline complete (${(event.durationMs / 1000).toFixed(1)}s)`);
              break;
          }
        });

        messages.push("\n── RESULT ──");
        messages.push(result);
        return { content: [{ type: "text", text: messages.join("\n") }] };
      }

      // ── pipeline_status ─────────────────────────────────────────────
      case "pipeline_status": {
        const pExId = args?.execution_id as string;
        if (!pExId) throw new Error("Missing required argument: execution_id");
        const pEx = getPipelineExecution(pExId);
        if (!pEx) throw new Error(`Pipeline execution "${pExId}" not found`);

        const lines: string[] = [
          `Pipeline: ${pEx.pipelineName}`,
          `Status: ${pEx.status}`,
          `Started: ${pEx.startedAt}`,
        ];
        if (pEx.finishedAt) lines.push(`Finished: ${pEx.finishedAt}`);
        if (pEx.durationMs) lines.push(`Duration: ${(pEx.durationMs / 1000).toFixed(1)}s`);

        lines.push("\nChains:");
        for (const [chainRefId, chain] of Object.entries(pEx.chains)) {
          const icon = chain.status === "done" ? "✓" : chain.status === "error" ? "✗" : chain.status === "running" ? "▶" : chain.status === "skipped" ? "–" : "○";
          const dur = chain.durationMs ? ` (${(chain.durationMs / 1000).toFixed(1)}s)` : "";
          lines.push(`  ${icon} ${chainRefId} (${chain.chainName})${dur}: ${chain.status}`);
          if (chain.error) lines.push(`    Error: ${chain.error}`);
        }

        if (pEx.error) lines.push(`\nError: ${pEx.error}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── dry_run_chain ─────────────────────────────────────────────
      case "dry_run_chain": {
        const chainName = args?.name as string;
        if (!chainName) throw new Error("Missing required argument: name");
        const chain = loadChain(chainName);
        const input = (args?.input ?? {}) as Record<string, string>;
        const result = dryRunChain(chain, input);

        const lines: string[] = [];

        // Issues
        if (result.issues.length > 0) {
          lines.push("Issues:");
          for (const issue of result.issues) {
            lines.push(`  ${issue.level}: ${issue.stepId ? `${issue.stepId}: ` : ""}${issue.message}`);
          }
          lines.push("");
        }

        // Plan
        lines.push(`Execution Plan: ${chain.name}\n`);
        let currentWave = 0;
        for (const step of result.plan) {
          if (step.wave !== currentWave) {
            currentWave = step.wave;
            const parallel = result.plan.filter((s) => s.wave === currentWave).length;
            lines.push(`  Wave ${currentWave}${parallel > 1 ? ` (${parallel} parallel)` : ""}`);
          }
          lines.push(`    ${step.stepId} [${step.model}]${step.dependsOn.length ? ` ← ${step.dependsOn.join(", ")}` : ""}`);
        }

        // Cost
        lines.push(`\nEstimated Cost:`);
        lines.push(`  Steps: ${result.estimatedCost.totalSteps} (${result.estimatedCost.parallelWaves} waves)`);
        for (const [model, count] of Object.entries(result.estimatedCost.models)) {
          lines.push(`  ${model}: ${count} step(s)`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── chain_stats ─────────────────────────────────────────────────
      case "chain_stats": {
        const statsChainName = args?.name as string;
        if (!statsChainName) throw new Error("Missing required argument: name");
        const stats = getChainStats(statsChainName);
        const lines = [
          `Stats for ${statsChainName}:`,
          `  Total runs: ${stats.totalRuns}`,
          `  Success rate: ${stats.successRate.toFixed(1)}%`,
          `  Avg duration: ${stats.avgDurationMs > 0 ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : "n/a"}`,
          `  Total tokens: ${stats.totalTokens.input} input, ${stats.totalTokens.output} output`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── queue_status ────────────────────────────────────────────────
      case "queue_status": {
        const qStats = getQueueStats();
        const recentJobs = listQueueJobs(10, 0);
        const lines = [
          `Queue Status:`,
          `  Queued: ${qStats.queued}`,
          `  Running: ${qStats.running}`,
          `  Done: ${qStats.done}`,
          `  Errors: ${qStats.errored}`,
          `  Workers: ${qStats.activeWorkers}/${qStats.maxWorkers}`,
          `  Avg wait: ${qStats.avgWaitSeconds}s`,
        ];
        if (recentJobs.length > 0) {
          lines.push("\nRecent jobs:");
          for (const job of recentJobs.slice(0, 5)) {
            lines.push(`  ${job.status} ${job.name} (p${job.priority})${job.executionId ? ` → ${job.executionId}` : ""}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
