/**
 * Structured logger for OCC.
 * Outputs JSON to stderr when LOG_FORMAT=json, otherwise human-readable.
 * Levels: debug, info, warn, error
 */

const LOG_FORMAT = process.env.LOG_FORMAT ?? "text";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const NO_COLOR = !!process.env.NO_COLOR;

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS: Record<string, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 1) >= (LEVELS[LOG_LEVEL] ?? 1);
}

/** Sanitize log strings to prevent log injection via newlines/control chars */
function sanitizeLogStr(s: string): string {
  return s.replace(/[\n\r\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ");
}

function log(level: string, component: string, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const safeMsg = sanitizeLogStr(message);
  const safeComponent = sanitizeLogStr(component);

  if (LOG_FORMAT === "json") {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: safeComponent,
      msg: safeMsg,
    };
    if (data) Object.assign(entry, data);
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    const color = NO_COLOR ? "" : (COLORS[level] ?? "");
    const reset = NO_COLOR ? "" : RESET;
    const prefix = `${color}[${safeComponent}]${reset}`;
    const extra = data ? " " + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? sanitizeLogStr(v) : JSON.stringify(v)}`).join(" ") : "";
    process.stderr.write(`${prefix} ${safeMsg}${extra}\n`);
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) => log("debug", component, msg, data),
  info:  (component: string, msg: string, data?: Record<string, unknown>) => log("info",  component, msg, data),
  warn:  (component: string, msg: string, data?: Record<string, unknown>) => log("warn",  component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) => log("error", component, msg, data),
};
