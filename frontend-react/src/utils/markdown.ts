// ─── Lightweight Markdown to HTML parser ─────────────────────────────────────
// Supports: headers, code blocks, tables, lists (ul/ol), blockquotes, HR,
// links, bold, italic, inline code. Ported from the OCC Chimera frontend.

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(text: string): string {
  return escHtml(text)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m: string, linkText: string, url: string) => {
        // Only allow safe HTTP(S) URLs — block javascript:, data:, etc.
        const safeUrl = /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : null;
        return safeUrl
          ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`
          : linkText;
      },
    )
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function isBlockStart(l: string): boolean {
  if (/^#{1,4} /.test(l)) return true;
  if (/^[-*] /.test(l)) return true;
  if (/^> /.test(l)) return true;
  if (/^\|.+\|/.test(l)) return true;
  if (l.startsWith("```")) return true;
  if (/^\d+\. /.test(l)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())) return true;
  return false;
}

/** Convert Markdown string to HTML */
export function mdToHtml(md: string): string {
  if (!md) return "";

  const lines = md.split("\n");
  let html = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      let code = "";
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code += (code ? "\n" : "") + lines[i];
        i++;
      }
      i++; // skip closing ```
      html += `<pre><code>${escHtml(code)}</code></pre>`;
      continue;
    }

    // Table
    if (
      line.includes("|") &&
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s:-]+\|/.test(lines[i + 1])
    ) {
      const headers = line
        .split("|")
        .filter((c) => c.trim())
        .map((c) => c.trim());
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim().startsWith("|")
      ) {
        rows.push(
          lines[i]
            .split("|")
            .filter((c) => c.trim())
            .map((c) => c.trim()),
        );
        i++;
      }
      html +=
        "<table><thead><tr>" +
        headers.map((h) => `<th>${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>";
      for (const row of rows) {
        html += "<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      html += "</tbody></table>";
      continue;
    }

    // HR
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      html += "<hr>";
      i++;
      continue;
    }

    // Headers
    if (line.startsWith("#### ")) {
      html += `<h4>${inline(line.slice(5))}</h4>`;
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      html += `<h3>${inline(line.slice(4))}</h3>`;
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      html += `<h2>${inline(line.slice(3))}</h2>`;
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      html += `<h1>${inline(line.slice(2))}</h1>`;
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      let bq = "";
      while (i < lines.length && lines[i].startsWith("> ")) {
        bq += (bq ? "<br>" : "") + inline(lines[i].slice(2));
        i++;
      }
      html += `<blockquote>${bq}</blockquote>`;
      continue;
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^[-*] /, ""))}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\d+\. /, ""))}</li>`;
        i++;
      }
      html += "</ol>";
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-block lines
    let para = "";
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isBlockStart(lines[i])
    ) {
      para += (para ? " " : "") + lines[i];
      i++;
    }
    if (para) {
      html += `<p>${inline(para)}</p>`;
    } else {
      i++; // safety: always advance
    }
  }

  return sanitizeHtml(html);
}

/** Strip dangerous HTML elements and attributes from generated HTML */
function sanitizeHtml(html: string): string {
  return html
    // Remove script/iframe/object/embed/form tags and their content
    .replace(/<(script|iframe|object|embed|form|style|link|meta|base)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|form|style|link|meta|base)\b[^>]*\/?>/gi, "")
    // Remove event handler attributes (on*)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Remove javascript: and data: in href/src attributes
    .replace(/(href|src|action)\s*=\s*"(?:javascript|data|vbscript):[^"]*"/gi, '$1=""')
    .replace(/(href|src|action)\s*=\s*'(?:javascript|data|vbscript):[^']*'/gi, "$1=''");
}
