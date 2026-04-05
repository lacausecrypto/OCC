// ─── HTML escape utility ─────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS */
export function esc(s: unknown): string {
  return (s == null ? "" : String(s))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
