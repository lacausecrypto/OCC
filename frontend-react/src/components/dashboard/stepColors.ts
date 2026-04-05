/** Step type → color mapping, reads from Design Space CSS variables in real-time. */
function cssVar(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

export function getStepTypeColors(): Record<string, string> {
  return {
    agent: cssVar("--icon-blue", "#0a84ff"),
    router: cssVar("--icon-purple", "#bf5af2"),
    evaluator: cssVar("--icon-red", "#ff375f"),
    gate: cssVar("--icon-orange", "#ff9f0a"),
    transform: cssVar("--icon-purple", "#5e5ce6"),
    loop: cssVar("--icon-cyan", "#64d2ff"),
    merge: cssVar("--icon-green", "#30d158"),
    webhook: cssVar("--c-warning", "#ffd60a"),
    subchain: cssVar("--icon-purple", "#6366f1"),
    debate: cssVar("--icon-pink", "#ff6482"),
    browser: cssVar("--m-text2", "#a1a1aa"),
  };
}

/** @deprecated Use getStepTypeColors() for live theme colors */
export const STEP_TYPE_COLORS: Record<string, string> = {
  agent: "#0a84ff", router: "#bf5af2", evaluator: "#ff375f", gate: "#ff9f0a",
  transform: "#5e5ce6", loop: "#64d2ff", merge: "#30d158", webhook: "#ffd60a",
  subchain: "#6366f1", debate: "#ff6482", browser: "#a1a1aa",
};
