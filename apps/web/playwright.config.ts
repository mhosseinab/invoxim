import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "../../evidence/implementation/t28-browser-results",
  fullyParallel: false,
  // Spec files run in parallel; every test mocks the API in its own browser
  // context against a stateless Vite dev server. Half the cores is stable
  // (122/122 twice at 2 workers and twice at 4); more saves little.
  workers: "50%",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4175", headless: true },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4175",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
  },
});
