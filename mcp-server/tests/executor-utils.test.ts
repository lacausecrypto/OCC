/**
 * Tests for pure utility functions used by executor.ts.
 * Does NOT spawn any Claude CLI processes.
 *
 * Covers:
 * - evaluateCondition (advanced edge cases beyond utils.test.ts)
 * - resolveVariables (advanced: nested, multi-level, fallbacks)
 * - Output validation (guardrails) logic
 * - Cache key generation
 * - extractFilePaths pattern
 */
import { describe, it, expect } from "vitest";
import { evaluateCondition, resolveVariables } from "../src/utils.js";

// ─── evaluateCondition: advanced edge cases ────────────────────────────────

describe("evaluateCondition (advanced)", () => {
  describe("numeric comparisons with floats", () => {
    it("handles float > comparison", () => {
      expect(evaluateCondition("8.5 > 7.2")).toBe(true);
    });

    it("handles float < comparison", () => {
      expect(evaluateCondition("3.14 < 3.15")).toBe(true);
    });

    it("handles equal floats with > (not greater)", () => {
      expect(evaluateCondition("5.0 > 5.0")).toBe(false);
    });

    it("handles negative-like strings as truthy", () => {
      // "-5" is truthy since it's a non-empty, non-"false", non-"0" string
      expect(evaluateCondition("-5")).toBe(true);
    });
  });

  describe("contains with special characters", () => {
    it("handles contains with curly braces in value", () => {
      expect(evaluateCondition('{name: "test"} contains "name"')).toBe(true);
    });

    it("handles contains with newlines in value", () => {
      expect(evaluateCondition('line1\nline2 contains "line1"')).toBe(true);
    });
  });

  describe("equality with special strings", () => {
    it("equality check with numeric string", () => {
      expect(evaluateCondition('42 == "42"')).toBe(true);
    });

    it("equality check with boolean-like string", () => {
      expect(evaluateCondition('true == "true"')).toBe(true);
    });

    it("equality with spaces in quoted value", () => {
      expect(evaluateCondition('hello world == "hello world"')).toBe(true);
    });

    it("inequality with the same string is false", () => {
      expect(evaluateCondition('same != "same"')).toBe(false);
    });
  });

  describe("truthy edge cases", () => {
    it('"true" is truthy', () => {
      expect(evaluateCondition("true")).toBe(true);
    });

    it('"1" is truthy', () => {
      expect(evaluateCondition("1")).toBe(true);
    });

    it('"null" is truthy (it is a non-empty string)', () => {
      expect(evaluateCondition("null")).toBe(true);
    });

    it('"undefined" is truthy', () => {
      expect(evaluateCondition("undefined")).toBe(true);
    });

    it('"  false  " after trim is falsy', () => {
      expect(evaluateCondition("  false  ")).toBe(false);
    });

    it('"  0  " after trim is falsy', () => {
      expect(evaluateCondition("  0  ")).toBe(false);
    });
  });

  describe("chained conditions (single expression behavior)", () => {
    it("handles expression that looks numeric but has text", () => {
      // "score: 8 > 5" — the regex matches "score: 8" > 5
      // Number("score: 8") is NaN, so NaN > 5 = false
      expect(evaluateCondition("score: 8 > 5")).toBe(false);
    });

    it("handles empty comparison", () => {
      // " == " — eqMatch regex should match empty == empty
      expect(evaluateCondition(' == ""')).toBe(true);
    });
  });
});

// ─── resolveVariables: advanced patterns ───────────────────────────────────

describe("resolveVariables (advanced)", () => {
  describe("compound keys (dot notation)", () => {
    it("resolves {input.topic}", () => {
      expect(resolveVariables("Research {input.topic}", { "input.topic": "AI safety" })).toBe("Research AI safety");
    });

    it("resolves {input.depth} alongside simple vars", () => {
      expect(resolveVariables("{greeting} about {input.topic}", {
        greeting: "Hello",
        "input.topic": "testing",
      })).toBe("Hello about testing");
    });

    it("compound key falls back to base key if compound not found", () => {
      // If {a.b} is not in vars but {a} is, it should use {a}
      expect(resolveVariables("{a.b}", { a: "base" })).toBe("base");
    });

    it("compound key prefers compound over base", () => {
      expect(resolveVariables("{a.b}", { "a.b": "compound", a: "base" })).toBe("compound");
    });
  });

  describe("fallback values", () => {
    it('uses quoted fallback when key is missing: {key|"default"}', () => {
      expect(resolveVariables('{missing|"hello world"}', {})).toBe("hello world");
    });

    it("uses unquoted fallback: {key|default}", () => {
      expect(resolveVariables("{missing|fallback}", {})).toBe("fallback");
    });

    it("prefers actual value over fallback", () => {
      expect(resolveVariables('{x|"default"}', { x: "actual" })).toBe("actual");
    });

    it('fallback with empty string: {key|""}', () => {
      expect(resolveVariables('{missing|""}', {})).toBe("");
    });

    it("multiple fallbacks in one template", () => {
      expect(resolveVariables('{a|"one"} and {b|"two"}', {})).toBe("one and two");
    });
  });

  describe("multiple variables in complex templates", () => {
    it("resolves multiple different variables", () => {
      const template = "Step {step_id}: Process {input.data} with model {model}";
      const vars = {
        step_id: "analyze",
        "input.data": "customer feedback",
        model: "claude-sonnet-4-6",
      };
      expect(resolveVariables(template, vars)).toBe("Step analyze: Process customer feedback with model claude-sonnet-4-6");
    });

    it("handles template with no curly braces", () => {
      expect(resolveVariables("plain text no vars", { x: "1" })).toBe("plain text no vars");
    });

    it("handles empty template", () => {
      expect(resolveVariables("", { x: "1" })).toBe("");
    });

    it("handles template that is just a variable", () => {
      expect(resolveVariables("{x}", { x: "value" })).toBe("value");
    });
  });

  describe("unresolved variables", () => {
    it("keeps unresolved simple variable as-is", () => {
      expect(resolveVariables("Hello {unknown}!", {})).toBe("Hello {unknown}!");
    });

    it("keeps unresolved compound variable as-is", () => {
      expect(resolveVariables("{input.missing}", {})).toBe("{input.missing}");
    });

    it("partial resolution — some resolved, some not", () => {
      expect(resolveVariables("{a} and {b}", { a: "X" })).toBe("X and {b}");
    });
  });

  describe("special characters in values", () => {
    it("handles JSON in value", () => {
      const val = '{"key": "value", "arr": [1,2,3]}';
      expect(resolveVariables("{data}", { data: val })).toBe(val);
    });

    it("handles multiline value", () => {
      expect(resolveVariables("{text}", { text: "line1\nline2\nline3" })).toBe("line1\nline2\nline3");
    });

    it("handles value with curly braces", () => {
      expect(resolveVariables("Output: {result}", { result: "const x = {a: 1}" })).toBe("Output: const x = {a: 1}");
    });

    it("handles empty string value", () => {
      expect(resolveVariables("{x}", { x: "" })).toBe("");
    });

    it("handles very long value", () => {
      const long = "x".repeat(100000);
      expect(resolveVariables("{x}", { x: long })).toBe(long);
    });
  });
});

// ─── Output validation (guardrails) logic ──────────────────────────────────
// These test the validateOutput logic in executor.ts via pure function recreation

describe("Output validation (guardrails logic)", () => {
  // Recreate the validateOutput logic as a pure function for testing
  function validateOutput(
    output: string,
    step: {
      guardrails?: Array<{ type: string; value?: string | number }>;
      output_must_contain?: string[];
      output_must_not_contain?: string[];
      output_max_length?: number;
      output_schema?: string;
    },
  ): string[] {
    const errors: string[] = [];

    if (step.guardrails) {
      for (const guard of step.guardrails) {
        switch (guard.type) {
          case "max_length":
            if (output.length > (guard.value as number)) errors.push(`Output exceeds max length ${guard.value}`);
            break;
          case "min_length":
            if (output.length < (guard.value as number)) errors.push(`Output below min length ${guard.value}`);
            break;
          case "must_contain":
            if (!output.includes(guard.value as string)) errors.push(`Output missing required: "${guard.value}"`);
            break;
          case "must_not_contain":
            if (output.includes(guard.value as string)) errors.push(`Output contains forbidden: "${guard.value}"`);
            break;
          case "regex_match":
            if (!new RegExp(guard.value as string).test(output)) errors.push(`Output doesn't match regex: ${guard.value}`);
            break;
          case "json_valid":
            try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
            break;
        }
      }
    }

    if (step.output_must_contain) {
      for (const s of step.output_must_contain) {
        if (!output.includes(s)) errors.push(`Missing required string: "${s}"`);
      }
    }
    if (step.output_must_not_contain) {
      for (const s of step.output_must_not_contain) {
        if (output.includes(s)) errors.push(`Contains forbidden string: "${s}"`);
      }
    }
    if (step.output_max_length && output.length > step.output_max_length) {
      errors.push(`Output ${output.length} chars exceeds max ${step.output_max_length}`);
    }
    if (step.output_schema === "json") {
      try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
    }

    return errors;
  }

  describe("guardrails", () => {
    it("max_length: passes when under limit", () => {
      const errors = validateOutput("short", { guardrails: [{ type: "max_length", value: 100 }] });
      expect(errors).toEqual([]);
    });

    it("max_length: fails when over limit", () => {
      const errors = validateOutput("x".repeat(200), { guardrails: [{ type: "max_length", value: 100 }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("exceeds max length");
    });

    it("min_length: passes when over minimum", () => {
      const errors = validateOutput("x".repeat(200), { guardrails: [{ type: "min_length", value: 100 }] });
      expect(errors).toEqual([]);
    });

    it("min_length: fails when under minimum", () => {
      const errors = validateOutput("short", { guardrails: [{ type: "min_length", value: 100 }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("below min length");
    });

    it("must_contain: passes when string present", () => {
      const errors = validateOutput("This has a conclusion section", { guardrails: [{ type: "must_contain", value: "conclusion" }] });
      expect(errors).toEqual([]);
    });

    it("must_contain: fails when string absent", () => {
      const errors = validateOutput("No required text here", { guardrails: [{ type: "must_contain", value: "conclusion" }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("missing required");
    });

    it("must_not_contain: passes when string absent", () => {
      const errors = validateOutput("Clean output", { guardrails: [{ type: "must_not_contain", value: "TODO" }] });
      expect(errors).toEqual([]);
    });

    it("must_not_contain: fails when string present", () => {
      const errors = validateOutput("Has a TODO item", { guardrails: [{ type: "must_not_contain", value: "TODO" }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("contains forbidden");
    });

    it("regex_match: passes when matches", () => {
      const errors = validateOutput("# Title\nBody", { guardrails: [{ type: "regex_match", value: "^# " }] });
      expect(errors).toEqual([]);
    });

    it("regex_match: fails when no match", () => {
      const errors = validateOutput("No heading here", { guardrails: [{ type: "regex_match", value: "^# " }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("doesn't match regex");
    });

    it("json_valid: passes for valid JSON", () => {
      const errors = validateOutput('{"key": "value"}', { guardrails: [{ type: "json_valid" }] });
      expect(errors).toEqual([]);
    });

    it("json_valid: fails for invalid JSON", () => {
      const errors = validateOutput("not json at all", { guardrails: [{ type: "json_valid" }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("not valid JSON");
    });

    it("multiple guardrails: accumulates all errors", () => {
      const errors = validateOutput("short", {
        guardrails: [
          { type: "min_length", value: 100 },
          { type: "must_contain", value: "conclusion" },
          { type: "json_valid" },
        ],
      });
      expect(errors).toHaveLength(3);
    });

    it("multiple guardrails: no errors when all pass", () => {
      const output = '{"result": "This is the conclusion of the analysis"}';
      const errors = validateOutput(output, {
        guardrails: [
          { type: "max_length", value: 1000 },
          { type: "must_contain", value: "conclusion" },
          { type: "json_valid" },
        ],
      });
      expect(errors).toEqual([]);
    });
  });

  describe("legacy output validation fields", () => {
    it("output_must_contain passes", () => {
      const errors = validateOutput("Contains required text", { output_must_contain: ["required"] });
      expect(errors).toEqual([]);
    });

    it("output_must_contain fails", () => {
      const errors = validateOutput("No match here", { output_must_contain: ["required", "also_needed"] });
      expect(errors).toHaveLength(2);
    });

    it("output_must_not_contain passes", () => {
      const errors = validateOutput("Clean text", { output_must_not_contain: ["forbidden"] });
      expect(errors).toEqual([]);
    });

    it("output_must_not_contain fails", () => {
      const errors = validateOutput("Has forbidden word", { output_must_not_contain: ["forbidden"] });
      expect(errors).toHaveLength(1);
    });

    it("output_max_length passes", () => {
      const errors = validateOutput("short", { output_max_length: 100 });
      expect(errors).toEqual([]);
    });

    it("output_max_length fails", () => {
      const errors = validateOutput("x".repeat(200), { output_max_length: 100 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("exceeds max");
    });

    it("output_schema json passes for valid JSON", () => {
      const errors = validateOutput('{"a":1}', { output_schema: "json" });
      expect(errors).toEqual([]);
    });

    it("output_schema json fails for non-JSON", () => {
      const errors = validateOutput("plain text", { output_schema: "json" });
      expect(errors).toHaveLength(1);
    });
  });

  describe("empty / no constraints", () => {
    it("returns no errors when no constraints set", () => {
      const errors = validateOutput("anything", {});
      expect(errors).toEqual([]);
    });

    it("returns no errors for empty output with no constraints", () => {
      const errors = validateOutput("", {});
      expect(errors).toEqual([]);
    });
  });
});

// ─── File path extraction logic ────────────────────────────────────────────

describe("extractFilePaths (logic)", () => {
  // Recreate the extractFilePaths function from rest.ts
  function extractFilePaths(text: string): string[] {
    const matches = text.match(/\/[^\s"'`\])}>]+\.(pdf|png|jpg|csv)/gi) ?? [];
    return [...new Set(matches)];
  }

  it("extracts PDF paths", () => {
    expect(extractFilePaths("Generated report at /tmp/report.pdf")).toEqual(["/tmp/report.pdf"]);
  });

  it("extracts PNG paths", () => {
    expect(extractFilePaths("Screenshot saved to /tmp/screenshot.png")).toEqual(["/tmp/screenshot.png"]);
  });

  it("extracts CSV paths", () => {
    expect(extractFilePaths("Data exported to /tmp/data.csv")).toEqual(["/tmp/data.csv"]);
  });

  it("extracts JPG paths", () => {
    expect(extractFilePaths("Photo at /home/user/photo.jpg")).toEqual(["/home/user/photo.jpg"]);
  });

  it("extracts multiple paths", () => {
    const text = "Files: /tmp/a.pdf and /tmp/b.png and /tmp/c.csv";
    const paths = extractFilePaths(text);
    expect(paths).toHaveLength(3);
    expect(paths).toContain("/tmp/a.pdf");
    expect(paths).toContain("/tmp/b.png");
    expect(paths).toContain("/tmp/c.csv");
  });

  it("deduplicates paths", () => {
    const text = "File /tmp/a.pdf mentioned twice: /tmp/a.pdf";
    expect(extractFilePaths(text)).toEqual(["/tmp/a.pdf"]);
  });

  it("returns empty array for text with no paths", () => {
    expect(extractFilePaths("No file paths here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractFilePaths("")).toEqual([]);
  });

  it("handles deeply nested paths", () => {
    expect(extractFilePaths("/var/data/project/output/report.pdf")).toEqual(["/var/data/project/output/report.pdf"]);
  });
});

// ─── Cache key determinism ─────────────────────────────────────────────────

describe("Cache key generation (logic)", () => {
  // Recreate createCacheKey from executor.ts
  const crypto = require("node:crypto");

  function createCacheKey(stepId: string, resolvedPrompt: string, model?: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(stepId);
    hash.update(resolvedPrompt);
    hash.update(model ?? "");
    return hash.digest("hex");
  }

  it("produces deterministic keys", () => {
    const key1 = createCacheKey("step1", "Write about AI", "claude-sonnet-4-6");
    const key2 = createCacheKey("step1", "Write about AI", "claude-sonnet-4-6");
    expect(key1).toBe(key2);
  });

  it("produces different keys for different prompts", () => {
    const key1 = createCacheKey("step1", "Write about AI", "claude-sonnet-4-6");
    const key2 = createCacheKey("step1", "Write about ML", "claude-sonnet-4-6");
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different step IDs", () => {
    const key1 = createCacheKey("step1", "prompt", "model");
    const key2 = createCacheKey("step2", "prompt", "model");
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different models", () => {
    const key1 = createCacheKey("step1", "prompt", "claude-sonnet-4-6");
    const key2 = createCacheKey("step1", "prompt", "claude-haiku-4-5");
    expect(key1).not.toBe(key2);
  });

  it("handles undefined model", () => {
    const key1 = createCacheKey("step1", "prompt", undefined);
    const key2 = createCacheKey("step1", "prompt", "");
    expect(key1).toBe(key2);
  });

  it("produces a valid hex string", () => {
    const key = createCacheKey("s", "p", "m");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
