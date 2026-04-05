/**
 * Tests for Claude stream-json Zod schemas defined in claude-runner.ts.
 *
 * These schemas are used to parse stream events from the Claude CLI.
 * We test them directly to cover the Zod validation code.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Recreate the schemas from claude-runner.ts ─────────────────────────────
// (These are not exported, so we recreate them identically for testing)

const UsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
}).passthrough();

const ContentBlockDeltaSchema = z.object({
  type: z.literal("content_block_delta"),
  delta: z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
});

const ContentBlock = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const AssistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(ContentBlock).optional(),
    usage: UsageSchema.optional(),
  }).passthrough(),
});

const ResultSchema = z.object({
  type: z.literal("result"),
  result: z.string().optional(),
  usage: UsageSchema.optional(),
}).passthrough();

const MessageDeltaSchema = z.object({
  type: z.literal("message_delta"),
  usage: UsageSchema.optional(),
}).passthrough();

const MessageSchema = z.object({
  type: z.literal("message"),
  message: z.object({
    content: z.array(ContentBlock).optional(),
    usage: UsageSchema.optional(),
  }).passthrough(),
});

// ─── UsageSchema ─────────────────────────────────────────────────────────────

describe("UsageSchema", () => {
  it("accepts full usage object", () => {
    const result = UsageSchema.safeParse({ input_tokens: 100, output_tokens: 200 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.input_tokens).toBe(100);
      expect(result.data.output_tokens).toBe(200);
    }
  });

  it("accepts partial usage (input only)", () => {
    const result = UsageSchema.safeParse({ input_tokens: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.input_tokens).toBe(50);
      expect(result.data.output_tokens).toBeUndefined();
    }
  });

  it("accepts partial usage (output only)", () => {
    const result = UsageSchema.safeParse({ output_tokens: 150 });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = UsageSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("allows extra fields (passthrough)", () => {
    const result = UsageSchema.safeParse({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).cache_creation_input_tokens).toBe(5);
    }
  });

  it("rejects non-number tokens", () => {
    const result = UsageSchema.safeParse({ input_tokens: "not a number" });
    expect(result.success).toBe(false);
  });
});

// ─── ContentBlockDeltaSchema ─────────────────────────────────────────────────

describe("ContentBlockDeltaSchema", () => {
  it("accepts text delta event", () => {
    const result = ContentBlockDeltaSchema.safeParse({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello " },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delta.text).toBe("Hello ");
    }
  });

  it("accepts delta without text (e.g., input_json_delta)", () => {
    const result = ContentBlockDeltaSchema.safeParse({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"key":' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delta.text).toBeUndefined();
    }
  });

  it("rejects wrong type literal", () => {
    const result = ContentBlockDeltaSchema.safeParse({
      type: "content_block_start",
      delta: { type: "text_delta", text: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing delta field", () => {
    const result = ContentBlockDeltaSchema.safeParse({
      type: "content_block_delta",
    });
    expect(result.success).toBe(false);
  });

  it("accepts delta with extra fields", () => {
    const result = ContentBlockDeltaSchema.safeParse({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "x", index: 0 },
      index: 1,
    });
    expect(result.success).toBe(true);
  });
});

// ─── AssistantSchema ─────────────────────────────────────────────────────────

describe("AssistantSchema", () => {
  it("accepts assistant event with text content", () => {
    const result = AssistantSchema.safeParse({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, I can help." }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.content![0].text).toBe("Hello, I can help.");
      expect(result.data.message.usage!.input_tokens).toBe(10);
    }
  });

  it("accepts assistant event with empty content", () => {
    const result = AssistantSchema.safeParse({
      type: "assistant",
      message: { content: [] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts assistant event without content", () => {
    const result = AssistantSchema.safeParse({
      type: "assistant",
      message: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.content).toBeUndefined();
    }
  });

  it("accepts assistant with tool_use content", () => {
    const result = AssistantSchema.safeParse({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.content).toHaveLength(2);
    }
  });

  it("rejects wrong type", () => {
    const result = AssistantSchema.safeParse({
      type: "user",
      message: { content: [] },
    });
    expect(result.success).toBe(false);
  });
});

// ─── ResultSchema ────────────────────────────────────────────────────────────

describe("ResultSchema", () => {
  it("accepts result with text and usage", () => {
    const result = ResultSchema.safeParse({
      type: "result",
      result: "Final answer text here.",
      usage: { input_tokens: 500, output_tokens: 200 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBe("Final answer text here.");
      expect(result.data.usage!.input_tokens).toBe(500);
    }
  });

  it("accepts result without usage", () => {
    const result = ResultSchema.safeParse({
      type: "result",
      result: "Done.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts result without result field", () => {
    const result = ResultSchema.safeParse({
      type: "result",
      usage: { input_tokens: 100 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBeUndefined();
    }
  });

  it("allows extra fields (passthrough)", () => {
    const result = ResultSchema.safeParse({
      type: "result",
      result: "text",
      subtype: "success",
      session_id: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-string result", () => {
    const result = ResultSchema.safeParse({
      type: "result",
      result: 42,
    });
    expect(result.success).toBe(false);
  });
});

// ─── MessageDeltaSchema ──────────────────────────────────────────────────────

describe("MessageDeltaSchema", () => {
  it("accepts message_delta with output usage", () => {
    const result = MessageDeltaSchema.safeParse({
      type: "message_delta",
      usage: { output_tokens: 150 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.usage!.output_tokens).toBe(150);
    }
  });

  it("accepts message_delta without usage", () => {
    const result = MessageDeltaSchema.safeParse({
      type: "message_delta",
    });
    expect(result.success).toBe(true);
  });

  it("allows extra fields", () => {
    const result = MessageDeltaSchema.safeParse({
      type: "message_delta",
      usage: { output_tokens: 50 },
      stop_reason: "end_turn",
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong type", () => {
    const result = MessageDeltaSchema.safeParse({
      type: "content_block_delta",
    });
    expect(result.success).toBe(false);
  });
});

// ─── MessageSchema ───────────────────────────────────────────────────────────

describe("MessageSchema", () => {
  it("accepts message with content and usage", () => {
    const result = MessageSchema.safeParse({
      type: "message",
      message: {
        content: [{ type: "text", text: "Some output" }],
        usage: { input_tokens: 80, output_tokens: 120 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.content![0].text).toBe("Some output");
    }
  });

  it("accepts message with empty content", () => {
    const result = MessageSchema.safeParse({
      type: "message",
      message: { content: [] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts message without content", () => {
    const result = MessageSchema.safeParse({
      type: "message",
      message: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong type", () => {
    const result = MessageSchema.safeParse({
      type: "result",
      message: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing message field", () => {
    const result = MessageSchema.safeParse({
      type: "message",
    });
    expect(result.success).toBe(false);
  });
});

// ─── ContentBlock ────────────────────────────────────────────────────────────

describe("ContentBlock", () => {
  it("accepts text block", () => {
    const result = ContentBlock.safeParse({ type: "text", text: "Hello" });
    expect(result.success).toBe(true);
  });

  it("accepts tool_use block", () => {
    const result = ContentBlock.safeParse({
      type: "tool_use",
      id: "tool_1",
      name: "bash",
      input: { command: "ls" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_result block", () => {
    const result = ContentBlock.safeParse({
      type: "tool_result",
      tool_use_id: "tool_1",
      content: "file1.txt\nfile2.txt",
    });
    expect(result.success).toBe(true);
  });

  it("accepts block without text", () => {
    const result = ContentBlock.safeParse({ type: "image" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBeUndefined();
    }
  });

  it("requires type field", () => {
    const result = ContentBlock.safeParse({ text: "hello" });
    expect(result.success).toBe(false);
  });
});

// ─── Simulated stream parsing ────────────────────────────────────────────────

describe("Simulated stream parsing", () => {
  it("parses a realistic stream sequence", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "" }], usage: { input_tokens: 100 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      { type: "message_delta", usage: { output_tokens: 15 } },
      { type: "result", result: "Hello world", usage: { input_tokens: 100, output_tokens: 15 } },
    ];

    let fullText = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (const raw of events) {
      const cbd = ContentBlockDeltaSchema.safeParse(raw);
      if (cbd.success) {
        fullText += cbd.data.delta.text ?? "";
        continue;
      }

      const asst = AssistantSchema.safeParse(raw);
      if (asst.success) {
        for (const block of asst.data.message.content ?? []) {
          if (block.type === "text" && block.text) fullText += block.text;
        }
        inputTokens = asst.data.message.usage?.input_tokens ?? inputTokens;
        continue;
      }

      const res = ResultSchema.safeParse(raw);
      if (res.success) {
        inputTokens = res.data.usage?.input_tokens ?? inputTokens;
        outputTokens = res.data.usage?.output_tokens ?? outputTokens;
        if (res.data.result && res.data.result.length > fullText.length) {
          fullText = res.data.result;
        }
        continue;
      }

      const md = MessageDeltaSchema.safeParse(raw);
      if (md.success) {
        if (md.data.usage?.output_tokens) outputTokens = md.data.usage.output_tokens;
        continue;
      }
    }

    expect(fullText).toBe("Hello world");
    expect(inputTokens).toBe(100);
    expect(outputTokens).toBe(15);
  });

  it("handles message event type in stream", () => {
    const events = [
      { type: "message", message: { content: [{ type: "text", text: "Response via message event" }], usage: { input_tokens: 50, output_tokens: 30 } } },
    ];

    let fullText = "";
    for (const raw of events) {
      const msg = MessageSchema.safeParse(raw);
      if (msg.success) {
        for (const block of msg.data.message.content ?? []) {
          if (block.type === "text" && block.text) fullText += block.text;
        }
      }
    }

    expect(fullText).toBe("Response via message event");
  });
});
