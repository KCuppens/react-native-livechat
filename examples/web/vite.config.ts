import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  // Serve the built script widget at /widget.js for the plain-HTML demo (build packages/widget first).
  publicDir: "public",
});
