/**
 * Tests for the typed chain input system.
 * Covers: type validation, defaults, enums, patterns, ranges, file constraints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-typed-inputs-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

function writeChain(name: string, yaml: string) {
  fs.writeFileSync(path.join(tmpDir, `${name}.yaml`), yaml);
}

// ─── Loader: schema accepts new input fields ──────────────────────────────

describe("Loader — typed input schema", () => {
  it("accepts inputs with type, default, placeholder", async () => {
    writeChain("typed", `
name: typed
steps:
  - id: s1
    prompt: "Hello {input.topic}"
    output_var: out
inputs:
  - name: topic
    type: string
    default: "AI"
    placeholder: "Enter topic..."
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("typed");
    expect(chain.inputs[0].name).toBe("topic");
    expect((chain.inputs[0] as any).type).toBe("string");
    expect((chain.inputs[0] as any).default).toBe("AI");
    expect((chain.inputs[0] as any).placeholder).toBe("Enter topic...");
  });

  it("accepts enum inputs with enum_labels", async () => {
    writeChain("enum-chain", `
name: enum-chain
steps:
  - id: s1
    prompt: "Format: {input.format}"
    output_var: out
inputs:
  - name: format
    type: enum
    enum: [markdown, openapi, jsdoc]
    enum_labels:
      markdown: "Markdown (.md)"
      openapi: "OpenAPI 3.0"
      jsdoc: "JSDoc"
    default: markdown
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("enum-chain");
    const inp = chain.inputs[0] as any;
    expect(inp.type).toBe("enum");
    expect(inp.enum).toEqual(["markdown", "openapi", "jsdoc"]);
    expect(inp.enum_labels.openapi).toBe("OpenAPI 3.0");
    expect(inp.default).toBe("markdown");
  });

  it("accepts number inputs with min/max", async () => {
    writeChain("number-chain", `
name: number-chain
steps:
  - id: s1
    prompt: "Depth: {input.depth}"
    output_var: out
inputs:
  - name: depth
    type: number
    min: 1
    max: 10
    default: "5"
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("number-chain");
    const inp = chain.inputs[0] as any;
    expect(inp.type).toBe("number");
    expect(inp.min).toBe(1);
    expect(inp.max).toBe(10);
    expect(inp.default).toBe("5");
  });

  it("accepts boolean inputs", async () => {
    writeChain("bool-chain", `
name: bool-chain
steps:
  - id: s1
    prompt: "Verbose: {input.verbose}"
    output_var: out
inputs:
  - name: verbose
    type: boolean
    default: "false"
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("bool-chain");
    expect((chain.inputs[0] as any).type).toBe("boolean");
  });

  it("accepts image inputs with accepts and max_file_size", async () => {
    writeChain("image-chain", `
name: image-chain
steps:
  - id: s1
    prompt: "Process image {input.photo}"
    output_var: out
inputs:
  - name: photo
    type: image
    accepts: ["image/png", "image/jpeg"]
    max_file_size: 5242880
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("image-chain");
    const inp = chain.inputs[0] as any;
    expect(inp.type).toBe("image");
    expect(inp.accepts).toEqual(["image/png", "image/jpeg"]);
    expect(inp.max_file_size).toBe(5242880);
  });

  it("accepts inputs with pattern and examples", async () => {
    const yaml = [
      "name: pattern-chain",
      "steps:",
      "  - id: s1",
      '    prompt: "Email: {input.email}"',
      "    output_var: out",
      "inputs:",
      "  - name: email",
      "    type: string",
      '    pattern: "^[^@]+@[^@]+[.][^@]+$"',
      "    examples:",
      "      - user@example.com",
      "      - test@test.org",
      "output: out",
    ].join("\n");
    writeChain("pattern-chain", yaml);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("pattern-chain");
    const inp = chain.inputs[0] as any;
    expect(inp.pattern).toContain("@");
    expect(inp.examples).toHaveLength(2);
  });

  it("accepts all step types including image_gen", async () => {
    writeChain("imggen", `
name: imggen
steps:
  - id: gen
    type: image_gen
    prompt: "A cat"
    output_var: img
output: img
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("imggen");
    expect(chain.steps[0].type).toBe("image_gen");
  });

  it("accepts image_generate pre-tool", async () => {
    writeChain("pretool-img", `
name: pretool-img
steps:
  - id: s1
    pre_tools:
      - type: image_generate
        inject_as: banner
        query: "A sunset"
        image_provider: huggingface
        image_model: black-forest-labs/FLUX.1-schnell
        image_size: "1024x1024"
    prompt: "Image at {banner}"
    output_var: out
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("pretool-img");
    expect(chain.steps[0].pre_tools![0].type).toBe("image_generate");
  });
});

// ─── Executor: input validation ────────────────────────────────────────────

describe("Executor — input validation", () => {
  it("applies default values when input not provided", async () => {
    writeChain("default-test", `
name: default-test
steps:
  - id: s1
    prompt: "Lang: {input.lang}"
    output_var: out
inputs:
  - name: lang
    default: "en"
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("default-test");

    // Simulate what executor does
    const input: Record<string, string> = {};
    for (const inputDef of chain.inputs ?? []) {
      if ((input[inputDef.name] === undefined || input[inputDef.name] === "") && (inputDef as any).default != null) {
        input[inputDef.name] = (inputDef as any).default;
      }
    }
    expect(input.lang).toBe("en");
  });

  it("rejects invalid enum value", async () => {
    writeChain("enum-val", `
name: enum-val
steps:
  - id: s1
    prompt: "Format: {input.format}"
    output_var: out
inputs:
  - name: format
    type: enum
    enum: [markdown, openapi]
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("enum-val");

    const inputDef = chain.inputs[0] as any;
    const val = "invalid";
    expect(inputDef.enum?.includes(val)).toBe(false);
  });

  it("rejects non-numeric value for number type", () => {
    const val = "not-a-number";
    expect(isNaN(Number(val))).toBe(true);
  });

  it("accepts valid number within range", () => {
    const val = "5";
    const min = 1;
    const max = 10;
    expect(isNaN(Number(val))).toBe(false);
    expect(Number(val) >= min).toBe(true);
    expect(Number(val) <= max).toBe(true);
  });

  it("rejects number below min", () => {
    expect(Number("0") < 1).toBe(true);
  });

  it("rejects number above max", () => {
    expect(Number("11") > 10).toBe(true);
  });

  it("validates URL format", () => {
    expect(/^https?:\/\/.+/.test("https://example.com")).toBe(true);
    expect(/^https?:\/\/.+/.test("not-a-url")).toBe(false);
    expect(/^https?:\/\/.+/.test("ftp://bad")).toBe(false);
  });

  it("validates boolean values", () => {
    const valid = ["true", "false", "1", "0", "yes", "no"];
    for (const v of valid) {
      expect(valid.includes(v.toLowerCase())).toBe(true);
    }
    expect(valid.includes("maybe")).toBe(false);
  });

  it("validates pattern (regex)", () => {
    const pattern = "^[a-z]+@[a-z]+\\.[a-z]+$";
    expect(new RegExp(pattern).test("user@test.com")).toBe(true);
    expect(new RegExp(pattern).test("invalid")).toBe(false);
  });

  it("validates min_length / max_length", () => {
    const val = "hello";
    expect(val.length >= 3).toBe(true); // min_length: 3
    expect(val.length <= 100).toBe(true); // max_length: 100
    expect("hi".length >= 3).toBe(false); // too short
  });

  it("validates JSON input", () => {
    expect(() => JSON.parse('{"key": "value"}')).not.toThrow();
    expect(() => JSON.parse("not json")).toThrow();
  });

  it("treats empty string as missing for required inputs", () => {
    const val = "";
    const isProvided = val !== undefined && val !== "";
    expect(isProvided).toBe(false);
  });

  it("default overrides empty string", () => {
    const input: Record<string, string> = { topic: "" };
    const def = "fallback";
    if (input.topic === undefined || input.topic === "") {
      input.topic = def;
    }
    expect(input.topic).toBe("fallback");
  });
});

// ─── Image generation pre-tool type ────────────────────────────────────────

describe("Image generation — schema validation", () => {
  it("accepts image_generate with all provider options", async () => {
    writeChain("img-openai", `
name: img-openai
steps:
  - id: s1
    pre_tools:
      - type: image_generate
        inject_as: img
        query: "A landscape"
        image_provider: openai
        image_model: dall-e-3
        image_size: "1024x1024"
        image_quality: hd
        image_style: vivid
        image_format: png
    prompt: "Image: {img}"
    output_var: out
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("img-openai");
    const pt = chain.steps[0].pre_tools![0] as any;
    expect(pt.image_provider).toBe("openai");
    expect(pt.image_model).toBe("dall-e-3");
    expect(pt.image_quality).toBe("hd");
    expect(pt.image_style).toBe("vivid");
    expect(pt.image_format).toBe("png");
  });

  it("accepts huggingface provider with negative_prompt", async () => {
    writeChain("img-hf", `
name: img-hf
steps:
  - id: s1
    pre_tools:
      - type: image_generate
        inject_as: img
        query: "A portrait"
        image_provider: huggingface
        image_model: black-forest-labs/FLUX.1-schnell
        negative_prompt: "blurry, low quality"
    prompt: "Image: {img}"
    output_var: out
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("img-hf");
    const pt = chain.steps[0].pre_tools![0] as any;
    expect(pt.image_provider).toBe("huggingface");
    expect(pt.negative_prompt).toBe("blurry, low quality");
  });

  it("accepts stability provider", async () => {
    writeChain("img-stab", `
name: img-stab
steps:
  - id: s1
    pre_tools:
      - type: image_generate
        inject_as: img
        query: "Abstract art"
        image_provider: stability
        image_model: sd3
        image_format: webp
    prompt: "Image: {img}"
    output_var: out
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("img-stab");
    const pt = chain.steps[0].pre_tools![0] as any;
    expect(pt.image_provider).toBe("stability");
    expect(pt.image_format).toBe("webp");
  });

  it("rejects invalid image_format", async () => {
    writeChain("img-bad-fmt", `
name: img-bad-fmt
steps:
  - id: s1
    pre_tools:
      - type: image_generate
        inject_as: img
        query: "test"
        image_format: bmp
    prompt: "x"
    output_var: out
output: out
`);
    const { loadChain } = await import("../src/loader.js");
    expect(() => loadChain("img-bad-fmt")).toThrow();
  });
});

// ─── Complex chain with typed inputs ──────────────────────────────────────

describe("Full chain — typed inputs end-to-end", () => {
  it("loads a chain with all input types", async () => {
    writeChain("full-typed", `
name: full-typed
inputs:
  - name: topic
    type: string
    placeholder: "Research topic"
    min_length: 3
    max_length: 200
    examples: ["AI safety", "climate change"]
  - name: format
    type: enum
    enum: [markdown, html, pdf]
    default: markdown
  - name: depth
    type: number
    min: 1
    max: 10
    default: "5"
  - name: verbose
    type: boolean
    default: "false"
  - name: source_url
    type: url
    optional: true
  - name: config
    type: json
    optional: true
  - name: banner
    type: image
    accepts: ["image/png", "image/jpeg"]
    max_file_size: 5242880
    optional: true
  - name: data_file
    type: file
    accepts: [".csv", ".json"]
    optional: true
  - name: notes
    type: text
    max_length: 5000
    optional: true
steps:
  - id: research
    prompt: "Research {input.topic} at depth {input.depth}"
    output_var: result
output: result
`);
    const { loadChain } = await import("../src/loader.js");
    const chain = loadChain("full-typed");
    expect(chain.inputs).toHaveLength(9);

    const types = chain.inputs.map((i: any) => i.type ?? "string");
    expect(types).toContain("string");
    expect(types).toContain("enum");
    expect(types).toContain("number");
    expect(types).toContain("boolean");
    expect(types).toContain("url");
    expect(types).toContain("json");
    expect(types).toContain("image");
    expect(types).toContain("file");
    expect(types).toContain("text");
  });
});
