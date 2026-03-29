import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const BT_PATH = path.resolve(__dirname, "../browser-tools.cjs");

/** Helper: run the CLI and return { stdout, stderr, status }. Never throws. */
function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node "${BT_PATH}" ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      status: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Source file integrity — all expected commands exist in the switch
// ---------------------------------------------------------------------------
describe("Command existence (source analysis)", () => {
  const source = fs.readFileSync(BT_PATH, "utf-8");

  const expectedCommands = [
    "screenshot",
    "goto",
    "click",
    "type",
    "press",
    "select-all",
    "read",
    "read-all",
    "read-html",
    "wait",
    "tabs",
    "tab",
    "eval",
    "scroll",
  ];

  for (const cmd of expectedCommands) {
    it(`has a case for "${cmd}"`, () => {
      const pattern = new RegExp(`case\\s+["']${cmd}["']`);
      expect(source).toMatch(pattern);
    });
  }

  it("has a default case that exits with error", () => {
    expect(source).toContain("default:");
    expect(source).toMatch(/Unknown command/);
  });
});

// ---------------------------------------------------------------------------
// 2. CLI argument parsing — no Chrome needed for these checks
// ---------------------------------------------------------------------------
describe("CLI argument parsing", () => {
  it("no command -> exit 0 with usage message", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage:.*browser-tools\.cjs/);
  });

  it("unknown command -> exit 1 with error", () => {
    // Unknown commands still attempt to connect to Chrome first.
    // If Chrome is not running, the process will exit 1 with a connection
    // error before reaching the switch. Either way, exit code is 1.
    const result = run("this-command-does-not-exist");
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Argument validation — these commands validate args BEFORE connecting to
//    Chrome, so they should work regardless of whether Chrome is running.
//    NOTE: Some commands connect first, then validate. For those, we just
//    assert exit 1.
// ---------------------------------------------------------------------------
describe("Argument validation (exit codes)", () => {
  // Looking at the source: validation happens AFTER connect() for goto,
  // click, type, eval. So if Chrome is not running, we get a connection
  // error (exit 1) before argument validation. We still verify exit 1.

  it("click without coordinates -> exit 1", () => {
    const result = run("click");
    expect(result.status).toBe(1);
  });

  it("click with non-numeric args -> exit 1", () => {
    const result = run("click", "abc", "def");
    expect(result.status).toBe(1);
  });

  it("type without text -> exit 1", () => {
    const result = run("type");
    expect(result.status).toBe(1);
  });

  it("eval without JS -> exit 1", () => {
    const result = run("eval");
    expect(result.status).toBe(1);
  });

  it("goto without URL -> exit 1", () => {
    const result = run("goto");
    expect(result.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Default values (verified by reading source)
// ---------------------------------------------------------------------------
describe("Default values (source analysis)", () => {
  const source = fs.readFileSync(BT_PATH, "utf-8");

  it("screenshot without path defaults to /tmp/occ-browser.png", () => {
    expect(source).toMatch(/args\[0\]\s*\|\|\s*["']\/tmp\/occ-browser\.png["']/);
  });

  it("press without key defaults to Enter", () => {
    expect(source).toMatch(/args\[0\]\s*\|\|\s*["']Enter["']/);
  });

  it("wait without ms defaults to 1000", () => {
    expect(source).toMatch(/parseInt\(args\[0\]\)\s*\|\|\s*1000/);
  });

  it("scroll without direction defaults to down", () => {
    expect(source).toMatch(/args\[0\]\s*\|\|\s*["']down["']/);
  });

  it("scroll without amount defaults to 500", () => {
    expect(source).toMatch(/parseInt\(args\[1\]\)\s*\|\|\s*500/);
  });

  it("read-html without selector defaults to body", () => {
    expect(source).toMatch(/args\[0\]\s*\|\|\s*["']body["']/);
  });
});

// ---------------------------------------------------------------------------
// 5. Connection error handling — Chrome not running
// ---------------------------------------------------------------------------
describe("Connection error handling (Chrome not running)", () => {
  // We only run these if port 9222 is NOT listening.
  // If Chrome IS running, the commands would succeed which is not what we test.
  const chromeRunning = (() => {
    try {
      execSync("curl -s --max-time 1 http://127.0.0.1:9222/json/version", {
        stdio: "pipe",
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(chromeRunning)("when Chrome is NOT running", () => {
    it("screenshot fails with meaningful error", () => {
      const result = run("screenshot");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ERROR/i);
    });

    it("goto fails with meaningful error", () => {
      const result = run("goto", "https://example.com");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ERROR/i);
    });

    it("read fails with meaningful error", () => {
      const result = run("read");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ERROR/i);
    });

    it("tabs fails with meaningful error", () => {
      const result = run("tabs");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ERROR/i);
    });

    it("eval fails with meaningful error", () => {
      const result = run("eval", "1+1");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ERROR/i);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Live Chrome tests — only run when Chrome IS available
// ---------------------------------------------------------------------------
describe("Live Chrome integration", () => {
  const chromeRunning = (() => {
    try {
      execSync("curl -s --max-time 1 http://127.0.0.1:9222/json/version", {
        stdio: "pipe",
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!chromeRunning)("when Chrome IS running", () => {
    it("tabs returns JSON array", () => {
      const result = run("tabs");
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("url");
      expect(parsed[0]).toHaveProperty("title");
      expect(parsed[0]).toHaveProperty("index");
    });

    it("screenshot creates a file", () => {
      const tmpPath = `/tmp/occ-browser-test-${Date.now()}.png`;
      const result = run("screenshot", tmpPath);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(tmpPath);
      expect(fs.existsSync(tmpPath)).toBe(true);
      fs.unlinkSync(tmpPath);
    });

    it("read returns page text", () => {
      const result = run("read");
      expect(result.status).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("wait completes successfully", () => {
      const result = run("wait", "100");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("waited 100ms");
    });

    it("eval returns result", () => {
      const result = run("eval", "2+2");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("4");
    });
  });
});
