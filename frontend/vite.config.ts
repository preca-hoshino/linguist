import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const nodeModulesDir = fileURLToPath(new URL("./node_modules", import.meta.url));
const pkgJsonPath = fileURLToPath(new URL("./package.json", import.meta.url));

function collectThirdPartyNotices(): string {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const seeds = Object.keys(pkg.dependencies ?? {});
  const visited = new Set<string>();
  const queue = [...seeds, "scheduler", "@remix-run/route-pattern", "cookie-es", "dompurify", "marked"];
  const sections: string[] = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || visited.has(name)) continue;
    visited.add(name);

    const pkgDir = join(nodeModulesDir, name);
    if (!existsSync(pkgDir)) continue;

    const subPkgPath = join(pkgDir, "package.json");
    if (existsSync(subPkgPath)) {
      try {
        const subPkg = JSON.parse(readFileSync(subPkgPath, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        for (const dep of Object.keys(subPkg.dependencies ?? {})) {
          if (!visited.has(dep)) queue.push(dep);
        }
      } catch {
        // Ignore malformed package manifests during license scan.
      }
    }

    const entries = readdirSync(pkgDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/^(licen[cs]e|thirdparty|notice)/i.test(entry.name)) {
        const content = readFileSync(join(pkgDir, entry.name), "utf8");
        sections.push(`${name}/${entry.name}\n\n${content}`);
      }
    }
  }

  return sections.join("\n\n");
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "embedded-third-party-notices",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "third-party-notices.txt",
          source: collectThirdPartyNotices(),
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:9527",
      "/auth": "http://127.0.0.1:9527",
      "/icons": "http://127.0.0.1:9527",
      "/healthz": "http://127.0.0.1:9527",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) {
            return "charts";
          }
          if (id.includes("node_modules/@tanstack/")) return "tanstack";
          if (id.includes("node_modules/@radix-ui/")) return "radix";
          return undefined;
        },
      },
    },
  },
});
