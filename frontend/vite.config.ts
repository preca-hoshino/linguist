import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:9527",
      "/icons": "http://127.0.0.1:9527",
      "/healthz": "http://127.0.0.1:9527"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
