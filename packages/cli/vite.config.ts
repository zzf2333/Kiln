import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        index: "src/index.ts",
        bin: "src/bin.ts",
      },
      outDir: "dist",
      format: ["esm"],
      dts: true,
      clean: true,
      fixedExtension: false,
      deps: {
        alwaysBundle: [/^@kiln\//, "@agentclientprotocol/sdk"],
        neverBundle: ["bun:sqlite", "node:sqlite", "bun:ffi"],
        onlyBundle: false,
        dts: {
          alwaysBundle: [/^@kiln\//],
        },
      },
    },
    {
      entry: {
        bin: "../mcp/src/bin.ts",
      },
      outDir: "mcp/dist",
      format: ["esm"],
      dts: false,
      clean: true,
      fixedExtension: false,
      deps: {
        alwaysBundle: [/^@kiln\//],
        neverBundle: ["bun:sqlite", "node:sqlite", "bun:ffi"],
        onlyBundle: false,
      },
    },
  ],
});
