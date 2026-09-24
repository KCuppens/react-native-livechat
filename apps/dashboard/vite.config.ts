import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the API runs on `wrangler dev` (port 8787); in production the Worker serves this build.
const api = { target: "http://localhost:8787", changeOrigin: true, ws: true };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/agent": api, "/v1": api, "/files": api } },
  build: { outDir: "dist", sourcemap: true },
  test: { environment: "happy-dom" },
});
