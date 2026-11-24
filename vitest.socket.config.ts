import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.socket.test.ts", "apps/*/src/**/*.socket.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
