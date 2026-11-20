import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "../../packages/kernel/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310",
    },
  },
});
