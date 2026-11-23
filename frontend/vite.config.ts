import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const notices = [
  "react/LICENSE",
  "react-dom/LICENSE",
  "scheduler/LICENSE",
  "react-router/LICENSE.md",
  "@remix-run/route-pattern/LICENSE",
  "cookie-es/LICENSE",
  "monaco-editor/LICENSE",
  "monaco-editor/ThirdPartyNotices.txt",
  "dompurify/LICENSE",
  "marked/LICENSE.md",
];

export default defineConfig({
  plugins: [react(), {
    name: "embedded-third-party-notices",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "third-party-notices.txt",
        source: notices.map((path) => (
          `${path}\n\n${readFileSync(new URL(`./node_modules/${path}`, import.meta.url), "utf8")}`
        )).join("\n\n"),
      });
    },
  }],
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
