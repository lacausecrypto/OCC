import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "tests/**"],
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // Warn on unused vars but allow underscore-prefixed ones
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow console (CLI/server project)
      "no-console": "off",
      // Enforce const where possible
      "prefer-const": "error",
      // Relax strict any usage for existing code
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow require imports (dynamic imports)
      "@typescript-eslint/no-require-imports": "off",
      // Allow empty catch blocks (common pattern for best-effort operations)
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow control characters in regex (used for stripping ANSI codes)
      "no-control-regex": "off",
      // Allow useless escape (regex patterns from legacy code)
      "no-useless-escape": "warn",
      // Allow useless assignment (pre-tool result pattern)
      "no-useless-assignment": "warn",
      // Allow Function type (Express error handler signature)
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // Allow re-throwing without cause (common in error transformation)
      "preserve-caught-error": "off",
    },
  }
);
