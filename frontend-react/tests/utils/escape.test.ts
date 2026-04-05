import { describe, it, expect } from "vitest";
import { esc } from "../../src/utils/escape";

describe("esc", () => {
  it("escapes ampersand", () => {
    expect(esc("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(esc("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes greater-than", () => {
    expect(esc("a>b")).toBe("a&gt;b");
  });

  it("escapes double quotes", () => {
    expect(esc('"hello"')).toBe("&quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(esc("it's")).toBe("it&#39;s");
  });

  it("handles null", () => {
    expect(esc(null)).toBe("");
  });

  it("handles undefined", () => {
    expect(esc(undefined)).toBe("");
  });

  it("handles numbers", () => {
    expect(esc(42)).toBe("42");
  });

  it("handles empty string", () => {
    expect(esc("")).toBe("");
  });

  it("escapes all special chars in one string", () => {
    expect(esc('<div class="a&b">it\'s</div>')).toBe(
      "&lt;div class=&quot;a&amp;b&quot;&gt;it&#39;s&lt;/div&gt;"
    );
  });

  it("preserves safe strings", () => {
    expect(esc("Hello World 123")).toBe("Hello World 123");
  });
});
