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
  // Limit input size to prevent ReDoS on pathological strings
  if (trimmed.length > 10000) return false;

  // Parse using indexOf-based splitting instead of regex to avoid ReDoS
  // equality: left == "right"
  const eqIdx = trimmed.indexOf('==');
  if (eqIdx > 0 && trimmed.indexOf('!=') !== eqIdx - 1) {
    const left = trimmed.slice(0, eqIdx).trim();
    const right = trimmed.slice(eqIdx + 2).trim();
    if (left && right.startsWith('"') && right.endsWith('"')) {
      return left === right.slice(1, -1);
    }
  }

  // inequality: left != "right"
  const neqIdx = trimmed.indexOf('!=');
  if (neqIdx > 0) {
    const left = trimmed.slice(0, neqIdx).trim();
    const right = trimmed.slice(neqIdx + 2).trim();
    if (left && right.startsWith('"') && right.endsWith('"')) {
      return left !== right.slice(1, -1);
    }
  }

  // contains: left contains "right"
  const containsIdx = trimmed.indexOf(' contains "');
  if (containsIdx !== -1) {
    const right = trimmed.slice(containsIdx + 11);
    if (right.endsWith('"')) {
      return trimmed.slice(0, containsIdx).trim().includes(right.slice(0, -1));
    }
  }

  // numeric: left > N, left < N
  const gtIdx = trimmed.indexOf('>');
  if (gtIdx > 0 && trimmed[gtIdx + 1] !== '=') {
    const rightStr = trimmed.slice(gtIdx + 1).trim();
    const right = Number(rightStr);
    if (!isNaN(right) && rightStr !== '') {
      const left = Number(trimmed.slice(0, gtIdx).trim());
      return !isNaN(left) ? left > right : false;
    }
  }

  const ltIdx = trimmed.indexOf('<');
  if (ltIdx > 0 && trimmed[ltIdx + 1] !== '=') {
    const rightStr = trimmed.slice(ltIdx + 1).trim();
    const right = Number(rightStr);
    if (!isNaN(right) && rightStr !== '') {
      const left = Number(trimmed.slice(0, ltIdx).trim());
      return !isNaN(left) ? left < right : false;
    }
  }

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
    /\{(\w+)(?:\.(\w+))?(?:\|"([^"]*)"|(\|[^}]*))?\}/g,
    (_match, key: string, subkey: string | undefined, quotedFallback: string | undefined, unquotedFallback: string | undefined) => {
      if (subkey) {
        const compound = `${key}.${subkey}`;
        if (vars[compound] !== undefined) return vars[compound];
      }
      if (vars[key] !== undefined) return vars[key];
      // Quoted fallback: {var|"hello world"}
      if (quotedFallback !== undefined) return quotedFallback;
      // Unquoted fallback: {var|default} (strip leading |)
      if (unquotedFallback !== undefined && unquotedFallback.length > 1) return unquotedFallback.slice(1);
      return _match; // keep original if no match
    }
  );
}
