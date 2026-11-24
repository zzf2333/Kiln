import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        main: "src/main.ts",
      },
      outDir: "dist",
      format: ["esm"],
      platform: "node",
      dts: false,
      clean: true,
      fixedExtension: false,
      deps: {
        alwaysBundle: [/^@kiln\//],
        neverBundle: ["electron", /^node:/],
        onlyBundle: false,
      },
    },
    {
      entry: {
        "kiln-cli": "../../packages/cli/src/bin.ts",
      },
      outDir: "runtime",
      format: ["esm"],
      platform: "node",
      dts: false,
      clean: false,
      fixedExtension: true,
      deps: {
        alwaysBundle: [/.*/],
        neverBundle: [/^node:/, "bun:sqlite", "bun:ffi"],
        onlyBundle: false,
      },
    },
    {
      entry: {
        "kiln-mcp": "../../packages/mcp/src/bin.ts",
      },
      outDir: "runtime",
      format: ["esm"],
      platform: "node",
      dts: false,
      clean: false,
      fixedExtension: true,
      deps: {
        alwaysBundle: [/.*/],
        neverBundle: [/^node:/, "bun:sqlite", "bun:ffi"],
        onlyBundle: false,
      },
    },
  ],
});
