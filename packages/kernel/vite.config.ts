import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    fixedExtension: false,
    deps: {
      neverBundle: ["bun:sqlite", "node:sqlite", "bun:ffi"],
    },
  },
});
