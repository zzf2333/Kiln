import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/web.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
