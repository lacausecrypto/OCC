import { describe, it, expect } from "vitest";
import { mdToHtml } from "../../src/utils/markdown";

describe("mdToHtml", () => {
  it("returns empty string for empty input", () => {
    expect(mdToHtml("")).toBe("");
  });

  it("returns empty string for null-ish input", () => {
    expect(mdToHtml(null as unknown as string)).toBe("");
  });

  // Headers
  it("converts h1", () => {
    expect(mdToHtml("# Hello")).toContain("<h1>Hello</h1>");
  });

  it("converts h2", () => {
    expect(mdToHtml("## Hello")).toContain("<h2>Hello</h2>");
  });

  it("converts h3", () => {
    expect(mdToHtml("### Hello")).toContain("<h3>Hello</h3>");
  });

  it("converts h4", () => {
    expect(mdToHtml("#### Hello")).toContain("<h4>Hello</h4>");
  });

  // Inline formatting
  it("converts bold with **", () => {
    expect(mdToHtml("**bold**")).toContain("<strong>bold</strong>");
  });

  it("converts bold with __", () => {
    expect(mdToHtml("__bold__")).toContain("<strong>bold</strong>");
  });

  it("converts italic with *", () => {
    expect(mdToHtml("*italic*")).toContain("<em>italic</em>");
  });

  it("converts italic with _", () => {
    expect(mdToHtml("_italic_")).toContain("<em>italic</em>");
  });

  it("converts inline code", () => {
    expect(mdToHtml("`code`")).toContain("<code>code</code>");
  });

  // Links
  it("converts safe HTTP links", () => {
    const html = mdToHtml("[click](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("blocks javascript: links", () => {
    const html = mdToHtml("[xss](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("xss");
  });

  it("blocks data: links", () => {
    const html = mdToHtml("[xss](data:text/html,<script>)");
    expect(html).not.toContain("data:");
  });

  // Code blocks
  it("converts fenced code blocks", () => {
    const md = "```\nconsole.log('hi');\n```";
    const html = mdToHtml(md);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("console.log(");
    expect(html).toContain("</code></pre>");
  });

  it("escapes HTML in code blocks", () => {
    const md = "```\n<script>alert('xss')</script>\n```";
    const html = mdToHtml(md);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  // Lists
  it("converts unordered lists with -", () => {
    const html = mdToHtml("- item 1\n- item 2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item 1</li>");
    expect(html).toContain("<li>item 2</li>");
    expect(html).toContain("</ul>");
  });

  it("converts unordered lists with *", () => {
    const html = mdToHtml("* item 1\n* item 2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item 1</li>");
  });

  it("converts ordered lists", () => {
    const html = mdToHtml("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
    expect(html).toContain("</ol>");
  });

  // Blockquotes
  it("converts blockquotes", () => {
    const html = mdToHtml("> quote here");
    expect(html).toContain("<blockquote>quote here</blockquote>");
  });

  it("converts multi-line blockquotes", () => {
    const html = mdToHtml("> line 1\n> line 2");
    expect(html).toContain("<blockquote>line 1<br>line 2</blockquote>");
  });

  // Horizontal rules
  it("converts --- to hr", () => {
    expect(mdToHtml("---")).toContain("<hr>");
  });

  it("converts *** to hr", () => {
    expect(mdToHtml("***")).toContain("<hr>");
  });

  it("converts ___ to hr", () => {
    expect(mdToHtml("___")).toContain("<hr>");
  });

  // Tables
  it("converts markdown tables", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = mdToHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<th>B</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("</table>");
  });

  // Paragraphs
  it("wraps plain text in paragraphs", () => {
    expect(mdToHtml("Hello world")).toContain("<p>Hello world</p>");
  });

  it("joins consecutive lines into a single paragraph", () => {
    const html = mdToHtml("line 1\nline 2");
    expect(html).toContain("<p>line 1 line 2</p>");
  });

  // XSS sanitization
  it("strips script tags", () => {
    const html = mdToHtml("<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
  });

  it("strips iframe tags", () => {
    const html = mdToHtml("<iframe src='evil.com'></iframe>");
    expect(html).not.toContain("<iframe");
  });

  it("strips event handlers", () => {
    const html = mdToHtml('<img onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: in href", () => {
    const html = mdToHtml('[xss](javascript:void(0))');
    expect(html).not.toContain("javascript:");
  });

  // Complex documents
  it("handles a mixed document", () => {
    const md = `# Title

Some text with **bold** and *italic*.

- Item 1
- Item 2

\`\`\`
code block
\`\`\`

> A quote

---

1. One
2. Two`;

    const html = mdToHtml(md);
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<ol>");
  });
});
