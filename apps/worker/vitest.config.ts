import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: { AI_CLASSIFICATION_ENABLED: "false" },
        d1Databases: ["DB"],
        serviceBindings: {
          API: { name: "invoxim-api" },
          ASSETS: { name: "synthetic-transport" },
          ECHO: { name: "synthetic-transport" },
        },
        workers: [
          {
            name: "synthetic-transport",
            compatibilityDate: "2026-10-11",
            modules: true,
            script: `export default { async fetch(request) { const headers = new Headers({"Cache-Control":"no-store", "Location":"https://example.test/callback", "X-Probe-Url":request.url, "X-Probe-Method":request.method}); headers.append("Set-Cookie","one=1; Path=/; HttpOnly"); headers.append("Set-Cookie","two=2; Path=/; HttpOnly"); return new Response(JSON.stringify({body: await request.text(), headers: Object.fromEntries(request.headers)}), {status: request.method === "POST" ? 307 : 503, headers}); } };`,
          },
        ],
      },
    }),
  ],
  test: { fileParallelism: true },
});
