import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const kilndTarget = process.env.KILND_URL?.trim() || "http://127.0.0.1:4310";
const devPort = Number(process.env.KILN_UI_DEV_PORT) || 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../packages/kernel/public",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    proxy: {
      "/api": {
        target: kilndTarget,
        changeOrigin: true,
        // Never inject X-Forwarded-* headers: kilnd :4310 rejects proxy headers with 403 remote_port_required.
        xfwd: false,
      },
    },
  },
});
