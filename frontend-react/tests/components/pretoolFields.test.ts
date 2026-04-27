import { describe, it, expect } from "vitest";
import {
  PRETOOL_FIELDS, PRETOOL_TYPES, TOOL_LIST, MODELS, STEP_TYPES,
  TYPE_COLORS, getTypeColors,
} from "../../src/components/canvas/pretoolFields";

describe("pretoolFields", () => {
  describe("PRETOOL_FIELDS", () => {
    it("has definitions for all expected pre-tool types", () => {
      const expected = [
        "http_fetch", "web_search", "bash", "read_file", "write_file",
        "env_var", "mcp_call", "db_query", "state_load", "state_save",
        "vector_query", "vector_index", "json_parse", "diff_inject", "notify",
        "semantic_cache", "screenshot", "sandbox_exec", "cost_gate", "ast_parse",
        "email", "embed_compare", "graph_query", "parallel_fetch",
        "template_render", "approval_request", "current_datetime",
        "pdf_generate", "ocr",
      ];
      for (const type of expected) {
        expect(PRETOOL_FIELDS).toHaveProperty(type);
      }
    });

    it("each field has k and l properties", () => {
      for (const [, fields] of Object.entries(PRETOOL_FIELDS)) {
        for (const field of fields) {
          expect(field).toHaveProperty("k");
          expect(field).toHaveProperty("l");
          expect(typeof field.k).toBe("string");
          expect(typeof field.l).toBe("string");
        }
      }
    });

    it("http_fetch has url, method, headers, body, json_path fields", () => {
      const keys = PRETOOL_FIELDS.http_fetch.map((f) => f.k);
      expect(keys).toContain("url");
      expect(keys).toContain("method");
      expect(keys).toContain("headers");
      expect(keys).toContain("body");
      expect(keys).toContain("json_path");
    });

    it("method field has select type with HTTP methods", () => {
      const methodField = PRETOOL_FIELDS.http_fetch.find((f) => f.k === "method");
      expect(methodField?.type).toBe("select");
      expect(methodField?.opts).toContain("GET");
      expect(methodField?.opts).toContain("POST");
    });

    it("bash has command and stderr fields", () => {
      const keys = PRETOOL_FIELDS.bash.map((f) => f.k);
      expect(keys).toContain("command");
      expect(keys).toContain("stderr");
    });

    it("stderr is a bool field", () => {
      const stderr = PRETOOL_FIELDS.bash.find((f) => f.k === "stderr");
      expect(stderr?.type).toBe("bool");
    });

    it("vector_query has top_k as num field", () => {
      const topK = PRETOOL_FIELDS.vector_query.find((f) => f.k === "top_k");
      expect(topK?.type).toBe("num");
    });

    it("parallel_fetch has textarea for urls", () => {
      const urls = PRETOOL_FIELDS.parallel_fetch.find((f) => f.k === "urls");
      expect(urls?.type).toBe("textarea");
    });
  });

  describe("PRETOOL_TYPES", () => {
    it("matches PRETOOL_FIELDS keys", () => {
      expect(PRETOOL_TYPES.sort()).toEqual(Object.keys(PRETOOL_FIELDS).sort());
    });

    it("has 29 types", () => {
      expect(PRETOOL_TYPES.length).toBe(29);
    });
  });

  describe("TOOL_LIST", () => {
    it("contains Claude Code tools", () => {
      expect(TOOL_LIST).toContain("Read");
      expect(TOOL_LIST).toContain("Write");
      expect(TOOL_LIST).toContain("Edit");
      expect(TOOL_LIST).toContain("Bash");
      expect(TOOL_LIST).toContain("Glob");
      expect(TOOL_LIST).toContain("Grep");
      expect(TOOL_LIST).toContain("WebSearch");
      expect(TOOL_LIST).toContain("WebFetch");
    });

    it("has 8 tools", () => {
      expect(TOOL_LIST).toHaveLength(8);
    });
  });

  describe("MODELS", () => {
    it("contains Claude model IDs", () => {
      expect(MODELS).toContain("claude-sonnet-4-6");
      expect(MODELS).toContain("claude-opus-4-6");
      expect(MODELS).toContain("claude-haiku-4-5");
    });
  });

  describe("STEP_TYPES", () => {
    it("contains every documented step type", () => {
      const expected = [
        "agent", "router", "evaluator", "gate", "transform",
        "loop", "merge", "webhook", "subchain", "debate", "browser",
        "image_gen",
      ];
      for (const t of expected) expect(STEP_TYPES).toContain(t);
      expect(STEP_TYPES).toHaveLength(expected.length);
    });
  });

  describe("TYPE_COLORS", () => {
    it("has color for each step type", () => {
      for (const type of STEP_TYPES) {
        expect(TYPE_COLORS).toHaveProperty(type);
        expect(TYPE_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });

  describe("getTypeColors", () => {
    it("returns colors for all step types", () => {
      const colors = getTypeColors();
      for (const type of STEP_TYPES) {
        expect(colors).toHaveProperty(type);
      }
    });
  });

  // ─── Schema integrity ─────────────────────────────────────────────────
  describe("PRETOOL_FIELDS schema integrity", () => {
    const VALID_TYPES = new Set(["select", "bool", "num", "textarea"]);

    it("every field uses a known type or none (plain text)", () => {
      for (const [tool, fields] of Object.entries(PRETOOL_FIELDS)) {
        for (const f of fields) {
          if (f.type !== undefined) {
            expect(VALID_TYPES.has(f.type), `${tool}.${f.k} has unknown type "${f.type}"`).toBe(true);
          }
        }
      }
    });

    it("every select field declares non-empty opts", () => {
      for (const [tool, fields] of Object.entries(PRETOOL_FIELDS)) {
        for (const f of fields) {
          if (f.type === "select") {
            expect(Array.isArray(f.opts), `${tool}.${f.k} select has no opts`).toBe(true);
            expect((f.opts ?? []).length, `${tool}.${f.k} select has empty opts`).toBeGreaterThan(0);
            for (const o of f.opts ?? []) {
              expect(typeof o).toBe("string");
              expect(o.length).toBeGreaterThan(0);
            }
          }
        }
      }
    });

    it("non-select fields do not declare opts", () => {
      for (const [tool, fields] of Object.entries(PRETOOL_FIELDS)) {
        for (const f of fields) {
          if (f.type !== "select") {
            expect(f.opts, `${tool}.${f.k} non-select has stray opts`).toBeUndefined();
          }
        }
      }
    });

    it("field keys are unique within each pre-tool definition", () => {
      for (const [tool, fields] of Object.entries(PRETOOL_FIELDS)) {
        const keys = fields.map((f) => f.k);
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
        expect(dupes, `${tool} has duplicate keys: ${dupes.join(", ")}`).toEqual([]);
      }
    });

    it("every pre-tool defines at least one field", () => {
      for (const [tool, fields] of Object.entries(PRETOOL_FIELDS)) {
        expect(fields.length, `${tool} has no fields`).toBeGreaterThan(0);
      }
    });

    it("notify channel select includes the documented providers", () => {
      const ch = PRETOOL_FIELDS.notify.find((f) => f.k === "channel");
      expect(ch?.opts).toEqual(expect.arrayContaining(["slack", "discord", "telegram", "webhook"]));
    });

    it("cost_gate action select limits to known actions", () => {
      const action = PRETOOL_FIELDS.cost_gate.find((f) => f.k === "action");
      expect(action?.opts).toEqual(["warn", "skip", "downgrade"]);
    });

    it("current_datetime format select limits to known formats", () => {
      const fmt = PRETOOL_FIELDS.current_datetime.find((f) => f.k === "format");
      expect(fmt?.opts).toEqual(["iso", "locale", "unix"]);
    });

    it("textarea fields are reserved for multi-line content", () => {
      // Sanity: only fields whose intent is clearly multi-line use `textarea`.
      const textareaKeys: string[] = [];
      for (const fields of Object.values(PRETOOL_FIELDS)) {
        for (const f of fields) if (f.type === "textarea") textareaKeys.push(f.k);
      }
      // We don't enforce an exact list, but each textarea key should look multi-line-ish.
      for (const k of textareaKeys) {
        expect(k).toMatch(/^(urls|template|html|content|body|message|description)$/);
      }
    });
  });

  describe("TOOL_LIST integrity", () => {
    it("entries are unique non-empty strings", () => {
      for (const t of TOOL_LIST) {
        expect(typeof t).toBe("string");
        expect(t.length).toBeGreaterThan(0);
      }
      const set = new Set(TOOL_LIST);
      expect(set.size).toBe(TOOL_LIST.length);
    });

    it("uses PascalCase identifiers (matches Claude Code tool names)", () => {
      for (const t of TOOL_LIST) {
        expect(t, `tool "${t}" should start with an uppercase letter`).toMatch(/^[A-Z]/);
      }
    });
  });

  describe("MODELS integrity", () => {
    it("entries follow the claude-{family}-{major}-{minor} shape", () => {
      for (const m of MODELS) {
        expect(m).toMatch(/^claude-[a-z]+-\d+-\d+$/);
      }
    });

    it("entries are unique", () => {
      expect(new Set(MODELS).size).toBe(MODELS.length);
    });
  });

  describe("STEP_TYPES integrity", () => {
    it("entries are unique non-empty lowercase identifiers", () => {
      const set = new Set(STEP_TYPES);
      expect(set.size).toBe(STEP_TYPES.length);
      for (const t of STEP_TYPES) {
        expect(t).toMatch(/^[a-z_]+$/);
      }
    });
  });
});
