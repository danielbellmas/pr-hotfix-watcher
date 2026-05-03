import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "**/node_modules/**"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 40,
        branches: 38,
        functions: 40,
        lines: 40,
      },
    },
  },
});
