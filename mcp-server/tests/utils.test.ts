/**
 * Tests for the shared utilities (utils.ts).
 *
 * Covers:
 * - evaluateCondition: all operators, edge cases
 * - resolveVariables: simple, compound, fallback, edge cases
 */
import { describe, it, expect } from "vitest";
import { evaluateCondition, resolveVariables } from "../src/utils.js";

// ─── evaluateCondition ──────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  describe("equality (==)", () => {
    it('returns true for matching equality', () => {
      expect(evaluateCondition('hello == "hello"')).toBe(true);
    });

    it('returns false for non-matching equality', () => {
      expect(evaluateCondition('hello == "world"')).toBe(false);
    });

    it('handles empty string equality', () => {
      expect(evaluateCondition(' == ""')).toBe(true);
    });

    it('handles spaces in value', () => {
      expect(evaluateCondition('frontend == "frontend"')).toBe(true);
    });
  });

  describe("inequality (!=)", () => {
    it('returns true for non-matching', () => {
      expect(evaluateCondition('hello != "world"')).toBe(true);
    });

    it('returns false for matching', () => {
      expect(evaluateCondition('hello != "hello"')).toBe(false);
    });

    it('not-empty check', () => {
      expect(evaluateCondition('some_value != ""')).toBe(true);
    });

    it('empty left side falls through to truthy (edge case)', () => {
      // After trim: '!= ""' — no left side for regex, treated as truthy non-empty string
      expect(evaluateCondition(' != ""')).toBe(true);
    });
  });

  describe("contains", () => {
    it('returns true when substring found', () => {
      expect(evaluateCondition('hello world contains "world"')).toBe(true);
    });

    it('returns false when substring not found', () => {
      expect(evaluateCondition('hello world contains "xyz"')).toBe(false);
    });

    it('handles empty contains check', () => {
      expect(evaluateCondition('anything contains ""')).toBe(true);
    });
  });

  describe("numeric comparison", () => {
    it('greater than: true', () => {
      expect(evaluateCondition('10 > 5')).toBe(true);
    });

    it('greater than: false', () => {
      expect(evaluateCondition('3 > 5')).toBe(false);
    });

    it('less than: true', () => {
      expect(evaluateCondition('3 < 5')).toBe(true);
    });

    it('less than: false', () => {
      expect(evaluateCondition('10 < 5')).toBe(false);
    });

    it('equal is not greater', () => {
      expect(evaluateCondition('5 > 5')).toBe(false);
    });
  });

  describe("truthy fallback", () => {
    it('non-empty string is truthy', () => {
      expect(evaluateCondition('hello')).toBe(true);
    });

    it('empty string is falsy', () => {
      expect(evaluateCondition('')).toBe(false);
    });

    it('"false" is falsy', () => {
      expect(evaluateCondition('false')).toBe(false);
    });

    it('"0" is falsy', () => {
      expect(evaluateCondition('0')).toBe(false);
    });

    it('whitespace-only is falsy', () => {
      expect(evaluateCondition('   ')).toBe(false);
    });
  });

  describe("edge cases", () => {
    it('handles quoted strings with spaces', () => {
      expect(evaluateCondition('hello world == "hello world"')).toBe(true);
    });

    it('trims whitespace around expression', () => {
      expect(evaluateCondition('  hello == "hello"  ')).toBe(true);
    });
  });
});

// ─── resolveVariables ───────────────────────────────────────────────────────

describe("resolveVariables", () => {
  describe("simple variables", () => {
    it("resolves a single variable", () => {
      expect(resolveVariables("Hello {name}!", { name: "Alice" })).toBe("Hello Alice!");
    });

    it("resolves multiple variables", () => {
      expect(resolveVariables("{a} and {b}", { a: "X", b: "Y" })).toBe("X and Y");
    });

    it("resolves same variable multiple times", () => {
      expect(resolveVariables("{x} + {x}", { x: "1" })).toBe("1 + 1");
    });

    it("leaves unresolved variables as-is", () => {
      expect(resolveVariables("Hello {unknown}!", {})).toBe("Hello {unknown}!");
    });
  });

  describe("compound keys (dot notation)", () => {
    it("resolves {input.topic}", () => {
      expect(resolveVariables("{input.topic}", { "input.topic": "AI" })).toBe("AI");
    });

    it("resolves {key.subkey} with compound lookup", () => {
      expect(resolveVariables("{data.name}", { "data.name": "test" })).toBe("test");
    });
  });

  describe("fallback values", () => {
    it('resolves {key|"default"} when key missing', () => {
      expect(resolveVariables('{missing|"fallback"}', {})).toBe("fallback");
    });

    it("uses value when key exists (ignores fallback)", () => {
      expect(resolveVariables('{name|"default"}', { name: "Alice" })).toBe("Alice");
    });

    it("resolves {key|default} without quotes", () => {
      expect(resolveVariables("{x|none}", {})).toBe("none");
    });
  });

  describe("edge cases", () => {
    it("handles empty template", () => {
      expect(resolveVariables("", { x: "y" })).toBe("");
    });

    it("handles no variables in template", () => {
      expect(resolveVariables("plain text", { x: "y" })).toBe("plain text");
    });

    it("handles empty variable value", () => {
      expect(resolveVariables("{x}", { x: "" })).toBe("");
    });

    it("handles special characters in value", () => {
      expect(resolveVariables("{x}", { x: 'he said "hi" & <bye>' })).toBe('he said "hi" & <bye>');
    });

    it("handles multiline values", () => {
      expect(resolveVariables("{x}", { x: "line1\nline2\nline3" })).toContain("line2");
    });
  });
});
