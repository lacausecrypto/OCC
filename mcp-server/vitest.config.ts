import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["src/bin/**", "src/index.ts", "dist/**"],
      thresholds: {
        // Core modules (loader, storage, utils, linter, queue) have 90%+ coverage.
        // Executor, claude-runner, pretool-executor require Claude CLI mocking — tracked as tech debt.
        lines: 65,
      },
    },
  },
});
