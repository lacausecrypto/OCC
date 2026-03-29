/**
 * Shared utilities used by executor.ts and pipeline-executor.ts.
 * Extracted to eliminate code duplication.
 */

/**
 * Evaluate a condition expression against resolved values.
 *
 * Supported syntax:
 *   'value == "expected"'      — equality
 *   'value != "expected"'      — inequality
 *   'value contains "substr"'  — substring match
 *   'value > 5'                — numeric greater than
 *   'value < 5'                — numeric less than
 *   'truthy_value'             — truthy (non-empty, non-false, non-zero)
 */
export function evaluateCondition(expr: string): boolean {
  const trimmed = expr.trim();

  // equality: left == "right"
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*"([^"]*)"$/);
  if (eqMatch) return eqMatch[1].trim() === eqMatch[2];

  // inequality: left != "right"
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*"([^"]*)"$/);
  if (neqMatch) return neqMatch[1].trim() !== neqMatch[2];

  // contains: left contains "right"
  const containsMatch = trimmed.match(/^(.+?)\s+contains\s+"([^"]*)"$/);
  if (containsMatch) return containsMatch[1].trim().includes(containsMatch[2]);

  // numeric: left > N, left < N
  const gtMatch = trimmed.match(/^(.+?)\s*>\s*(\d+)$/);
  if (gtMatch) return Number(gtMatch[1].trim()) > Number(gtMatch[2]);

  const ltMatch = trimmed.match(/^(.+?)\s*<\s*(\d+)$/);
  if (ltMatch) return Number(ltMatch[1].trim()) < Number(ltMatch[2]);

  // truthy: non-empty string = true
  return trimmed !== "" && trimmed !== "false" && trimmed !== "0";
}

/**
 * Resolve {variable} placeholders in a string.
 *
 * Supports:
 *   {key}            — simple variable
 *   {key.subkey}     — compound key (e.g. {input.topic})
 *   {key|"fallback"} — fallback if key is undefined
 */
export function resolveVariables(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{(\w+)(?:\.(\w+))?(?:\|"?([^"}\s]*)"?)?\}/g,
    (_match, key: string, subkey: string | undefined, fallback: string | undefined) => {
      if (subkey) {
        const compound = `${key}.${subkey}`;
        if (vars[compound] !== undefined) return vars[compound];
      }
      if (vars[key] !== undefined) return vars[key];
      if (fallback !== undefined && fallback !== "") return fallback;
      return _match; // keep original if no match
    }
  );
}
