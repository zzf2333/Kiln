import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      bin: "src/bin.ts",
    },
    outDir: "dist",
    format: ["esm"],
    dts: {
      resolve: [/^@kiln\//],
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@kiln/protocol": ["../protocol/dist/index.d.ts"],
          "@kiln/kernel": ["../kernel/dist/index.d.ts"],
          "@kiln/mcp": ["../mcp/dist/index.d.ts"],
        },
      },
    },
    clean: true,
    noExternal: [/^@kiln\//],
    external: ["bun:sqlite", "node:sqlite", "bun:ffi"],
  },
  {
    entry: {
      bin: "../mcp/src/bin.ts",
    },
    outDir: "mcp/dist",
    format: ["esm"],
    dts: false,
    clean: true,
    noExternal: [/^@kiln\//],
    external: ["bun:sqlite", "node:sqlite", "bun:ffi"],
  },
]);
