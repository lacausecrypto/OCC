/**
 * Adapter between the canonical `PreTool` shape used by the engine / YAML
 * and the editor-side `PreToolData` shape used by the StepEditModal state.
 *
 * Lives in its own module so it can be tested in isolation and so importing
 * it doesn't break React Fast Refresh's "components-only export" rule for
 * the modal file.
 */
import type { PreToolData } from "./PreToolCard";
import type { PreTool } from "../../types/chain";

/** Convert PreTool[] (string | object) to PreToolData[] for editing */
export function preToolsToData(preTools: PreTool[]): PreToolData[] {
  return preTools.map((pt) => {
    if (typeof pt === "string") {
      return { tool: pt, inject_as: pt + "_data" };
    }
    return {
      ...pt,
      tool: pt.tool,
      inject_as: pt.inject_as ?? pt.tool + "_data",
    } as PreToolData;
  });
}
