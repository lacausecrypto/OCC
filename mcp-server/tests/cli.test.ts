/**
 * CLI end-to-end tests — runs the actual `occ` binary as a subprocess.
 *
 * Covers:
 * - occ help / --help / -h
 * - occ list (with chains dir)
 * - occ validate (valid chains, invalid chains, empty dir)
 * - occ dry-run (execution plan, cost estimate, missing inputs)
 * - occ health (server not running → error)
 * - Unknown commands → help + exit 1
 * - Exit codes (0 on success, 1 on error)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI_PATH = path.resolve(__dirname, "..", "dist", "bin", "occ.js");
let tmpDir: string;

function occ(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

beforeAll(() => {
  // Ensure CLI is built
  if (!fs.existsSync(CLI_PATH)) {
    execFileSync("npx", ["tsc"], {
      cwd: path.resolve(__dirname, ".."),
      timeout: 30000,
    });
  }
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-cli-test-"));
});

afterEach(() => {
  cleanupTmpDirSync(tmpDir);
});

// ─── Help ───────────────────────────────────────────────────────────────────

describe("occ help", () => {
  it("shows help with no args", () => {
    const { stdout, exitCode } = occ([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OCC");
    expect(stdout).toContain("Chain execution:");
    expect(stdout).toContain("list");
    expect(stdout).toContain("run");
    expect(stdout).toContain("validate");
    expect(stdout).toContain("dry-run");
  });

  it("shows help with --help", () => {
    const { stdout, exitCode } = occ(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Chain execution:");
  });

  it("shows help with -h", () => {
    const { stdout, exitCode } = occ(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Chain execution:");
  });

  it("shows help with help command", () => {
    const { stdout, exitCode } = occ(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Quick start:");
  });
});

// ─── Unknown command ────────────────────────────────────────────────────────

describe("Unknown command", () => {
  it("exits 1 for unknown command", () => {
    const { exitCode, stderr } = occ(["foobar"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

// ─── Validate ───────────────────────────────────────────────────────────────

describe("occ validate", () => {
  it("validates real chains with 0 errors", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return; // Skip if no chains dir

    const { stdout, exitCode } = occ(["validate"], { CHAINS_DIR: chainsDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("chains");
    expect(stdout).toContain("0 errors");
  });

  it("validates with explicit path argument", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { stdout, exitCode } = occ(["validate", chainsDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 errors");
  });

  it("reports errors for invalid chain", () => {
    // Write an invalid chain (circular deps)
    fs.writeFileSync(
      path.join(tmpDir, "bad.yaml"),
      `name: bad
steps:
  - id: a
    prompt: "A"
    output_var: out_a
    depends_on: [b]
  - id: b
    prompt: "B"
    output_var: out_b
    depends_on: [a]
output: out_a
`
    );

    const { stdout, exitCode } = occ(["validate", tmpDir]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("error");
    expect(stdout.toLowerCase()).toContain("circular");
  });

  it("reports no chains found for empty dir", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);

    const { stdout, exitCode } = occ(["validate", emptyDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No chains found");
  });

  it("detects undefined variables", () => {
    fs.writeFileSync(
      path.join(tmpDir, "warn.yaml"),
      `name: warn-chain
steps:
  - id: s1
    prompt: "Use {undefined_var}"
    output_var: result
output: result
`
    );

    const { stdout, exitCode } = occ(["validate", tmpDir]);
    expect(exitCode).toBe(0); // warnings don't cause exit 1
    expect(stdout).toContain("undefined_var");
  });

  it("detects missing pre-tool fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "bad-pretool.yaml"),
      `name: bad-pretool
steps:
  - id: s1
    prompt: "X"
    output_var: result
    pre_tools:
      - type: web_search
        inject_as: data
output: result
`
    );

    const { stdout, exitCode } = occ(["validate", tmpDir]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("query");
  });
});

// ─── Dry-run ────────────────────────────────────────────────────────────────

describe("occ dry-run", () => {
  it("shows execution plan for a valid chain", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { stdout, exitCode } = occ(
      ["dry-run", "deep-researcher", "--input", "topic=AI"],
      { CHAINS_DIR: chainsDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Execution Plan");
    expect(stdout).toContain("Wave");
    expect(stdout).toContain("Estimated Cost");
    expect(stdout).toContain("claude-sonnet");
  });

  it("shows cost breakdown by model", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { stdout } = occ(
      ["dry-run", "deep-researcher", "--input", "topic=test"],
      { CHAINS_DIR: chainsDir }
    );
    expect(stdout).toContain("$");
    expect(stdout).toContain("steps");
    expect(stdout).toContain("waves");
  });

  it("shows parallel steps in same wave", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { stdout } = occ(
      ["dry-run", "deep-researcher", "--input", "topic=test"],
      { CHAINS_DIR: chainsDir }
    );
    // deep-researcher has 3 parallel steps in wave 1
    expect(stdout).toContain("3 parallel");
  });

  it("reports missing required inputs", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { stdout } = occ(
      ["dry-run", "deep-researcher"],
      { CHAINS_DIR: chainsDir }
    );
    expect(stdout).toContain("Missing required input");
    expect(stdout).toContain("topic");
  });

  it("exits 1 for nonexistent chain", () => {
    const { exitCode, stderr } = occ(
      ["dry-run", "nonexistent"],
      { CHAINS_DIR: tmpDir }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  it("resolves input variables in prompt preview", () => {
    fs.writeFileSync(
      path.join(tmpDir, "preview.yaml"),
      `name: preview
inputs:
  - name: topic
steps:
  - id: s1
    prompt: "Research about {input.topic} in depth"
    output_var: result
output: result
`
    );

    const { stdout } = occ(
      ["dry-run", "preview", "--input", "topic=quantum computing"],
      { CHAINS_DIR: tmpDir }
    );
    expect(stdout).toContain("quantum computing");
  });
});

// ─── List ───────────────────────────────────────────────────────────────────

describe("occ list", () => {
  it("exits with error when server not running", () => {
    // Use a port that's definitely not running
    const { exitCode, stderr } = occ(["list"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

// ─── Health ─────────────────────────────────────────────────────────────────

describe("occ health", () => {
  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["health"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

// ─── Run (no server) ────────────────────────────────────────────────────────

describe("occ run", () => {
  it("exits 1 without chain name", () => {
    const { exitCode, stderr } = occ(["run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["run", "test-chain", "--input", "topic=x"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

// ─── Status (no server) ────────────────────────────────────────────────────

describe("occ status", () => {
  it("exits 1 without execution id", () => {
    const { exitCode, stderr } = occ(["status"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });
});

// ─── Input parsing ──────────────────────────────────────────────────────────

describe("Input parsing", () => {
  it("handles multiple --input flags", () => {
    fs.writeFileSync(
      path.join(tmpDir, "multi-input.yaml"),
      `name: multi
inputs:
  - name: a
  - name: b
steps:
  - id: s1
    prompt: "{input.a} and {input.b}"
    output_var: result
output: result
`
    );

    const { stdout, exitCode } = occ(
      ["dry-run", "multi-input", "--input", "a=hello", "--input", "b=world"],
      { CHAINS_DIR: tmpDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hello");
    expect(stdout).toContain("world");
  });

  it("handles -i shorthand", () => {
    fs.writeFileSync(
      path.join(tmpDir, "short.yaml"),
      `name: short
inputs:
  - name: x
steps:
  - id: s1
    prompt: "Value: {input.x}"
    output_var: result
output: result
`
    );

    const { stdout, exitCode } = occ(
      ["dry-run", "short", "-i", "x=test123"],
      { CHAINS_DIR: tmpDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("test123");
  });
});

// ─── New commands ───────────────────────────────────────────────────────────

describe("occ cancel", () => {
  it("exits 1 without execution id", () => {
    const { exitCode, stderr } = occ(["cancel"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["cancel", "abc123"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ queue", () => {
  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["queue"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ timeline", () => {
  it("exits 1 without execution id", () => {
    const { exitCode, stderr } = occ(["timeline"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["timeline", "abc123"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ stats", () => {
  it("exits 1 without chain name", () => {
    const { exitCode, stderr } = occ(["stats"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["stats", "my-chain"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ approve/reject", () => {
  it("exits 1 without args", () => {
    const { exitCode: a, stderr: sa } = occ(["approve"]);
    expect(a).toBe(1);
    expect(sa).toContain("Usage");

    const { exitCode: b, stderr: sb } = occ(["reject"]);
    expect(b).toBe(1);
    expect(sb).toContain("Usage");
  });

  it("exits 1 with only execution id (missing stepId)", () => {
    const { exitCode, stderr } = occ(["approve", "exec123"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["approve", "exec123", "step1"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ run-pipeline", () => {
  it("exits 1 without pipeline name", () => {
    const { exitCode, stderr } = occ(["run-pipeline"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["run-pipeline", "my-pipe", "--input", "x=1"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("--json flag", () => {
  it("help still works with --json (no crash)", () => {
    const { exitCode } = occ(["help", "--json"]);
    expect(exitCode).toBe(0);
  });

  it("validate works with --json (no crash)", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { exitCode } = occ(["validate", "--json"], { CHAINS_DIR: chainsDir });
    expect(exitCode).toBe(0);
  });
});

describe("--priority flag", () => {
  it("dry-run works with --priority (no crash)", () => {
    const chainsDir = path.resolve(__dirname, "..", "..", "chains");
    if (!fs.existsSync(chainsDir)) return;

    const { exitCode } = occ(
      ["dry-run", "deep-researcher", "--input", "topic=test", "--priority", "10"],
      { CHAINS_DIR: chainsDir }
    );
    expect(exitCode).toBe(0);
  });
});

describe("Help includes new commands", () => {
  it("help mentions all 17 commands and flags", () => {
    const { stdout } = occ(["help"]);
    expect(stdout).toContain("cancel");
    expect(stdout).toContain("queue");
    expect(stdout).toContain("timeline");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("approve");
    expect(stdout).toContain("reject");
    expect(stdout).toContain("run-pipeline");
    expect(stdout).toContain("generate");
    expect(stdout).toContain("generate-answer");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--priority");
  });
});

// ─── Generate ───────────────────────────────────────────────────────────────

describe("occ generate", () => {
  it("exits 1 without description", () => {
    const { exitCode, stderr } = occ(["generate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits with error when server not running", () => {
    const { exitCode, stderr } = occ(["generate", "Create a chain that monitors prices"], { OCC_URL: "http://localhost:19999" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Cannot connect");
  });
});

describe("occ generate-answer", () => {
  it("exits 1 without args", () => {
    const { exitCode, stderr } = occ(["generate-answer"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  it("exits 1 without answers", () => {
    const { exitCode, stderr } = occ(["generate-answer", "session123"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });
});
