import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const OCC_BACKEND = "http://localhost:4242";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST API: /api/* -> backend with prefix rewrite
      "/api": {
        target: OCC_BACKEND,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Health check
      "/health": {
        target: OCC_BACKEND,
        changeOrigin: true,
      },
      // REST endpoints
      "/chains": { target: OCC_BACKEND, changeOrigin: true },
      "/pipelines": { target: OCC_BACKEND, changeOrigin: true },
      "/executions": { target: OCC_BACKEND, changeOrigin: true },
      "/execute": { target: OCC_BACKEND, changeOrigin: true },
      "/queue": { target: OCC_BACKEND, changeOrigin: true },
      "/schedules": { target: OCC_BACKEND, changeOrigin: true },
      "/config": { target: OCC_BACKEND, changeOrigin: true },
      "/blobs": { target: OCC_BACKEND, changeOrigin: true },
      "/knowledge": { target: OCC_BACKEND, changeOrigin: true },
      "/providers": { target: OCC_BACKEND, changeOrigin: true },
      "/mcp-servers": { target: OCC_BACKEND, changeOrigin: true },
      "/approvals": { target: OCC_BACKEND, changeOrigin: true },
      "/generate-chain": { target: OCC_BACKEND, changeOrigin: true },
      "/workflow-chat": { target: OCC_BACKEND, changeOrigin: true },
      "/download": { target: OCC_BACKEND, changeOrigin: true },
      "/cache": { target: OCC_BACKEND, changeOrigin: true },
      // SSE event stream
      "/events": {
        target: OCC_BACKEND,
        changeOrigin: true,
        ws: false,
      },
      // Utility proxies (served by Python dev server / backend)
      "/proxy": {
        target: OCC_BACKEND,
        changeOrigin: true,
      },
      "/extract-style": {
        target: OCC_BACKEND,
        changeOrigin: true,
      },
      "/extract-style-js": {
        target: OCC_BACKEND,
        changeOrigin: true,
      },
      "/yaml-to-json": {
        target: OCC_BACKEND,
        changeOrigin: true,
      },
    },
  },
});
