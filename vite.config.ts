import { defineConfig } from "vite-plus";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "scripts/probes/**", "**/*.socket.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "packages/cli/mcp/dist/**",
      "packages/kernel/public/**",
      "packages/cli/public/**",
      "apps/desktop/src-tauri/target/**",
      "release-artifacts/**",
      "prototype/**",
      "scripts/probes/**",
      "**/*.generated.ts",
    ],
  },
  fmt: {
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    printWidth: 100,
    ignorePatterns: [
      "**/dist/**",
      "packages/cli/mcp/dist/**",
      "packages/kernel/public/**",
      "packages/cli/public/**",
      "apps/desktop/src-tauri/target/**",
      "release-artifacts/**",
      "pnpm-lock.yaml",
      "**/*.generated.ts",
    ],
  },
});
