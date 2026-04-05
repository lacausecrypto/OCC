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
    it("has all 11 step types", () => {
      expect(STEP_TYPES).toHaveLength(11);
      expect(STEP_TYPES).toContain("agent");
      expect(STEP_TYPES).toContain("router");
      expect(STEP_TYPES).toContain("evaluator");
      expect(STEP_TYPES).toContain("gate");
      expect(STEP_TYPES).toContain("transform");
      expect(STEP_TYPES).toContain("loop");
      expect(STEP_TYPES).toContain("merge");
      expect(STEP_TYPES).toContain("webhook");
      expect(STEP_TYPES).toContain("subchain");
      expect(STEP_TYPES).toContain("debate");
      expect(STEP_TYPES).toContain("browser");
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
});
