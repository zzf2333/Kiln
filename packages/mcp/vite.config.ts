import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/bin.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
