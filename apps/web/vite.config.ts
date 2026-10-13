import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const metadataDirectory = fileURLToPath(
  new URL("./.production/", import.meta.url),
);

export default defineConfig({
  build: { sourcemap: false },
  plugins: [
    {
      name: "production-module-inventory",
      apply: "build",
      async generateBundle(_options, bundle) {
        const inputs = new Set<string>();
        const outputs: Record<
          string,
          { imports: { path: string; kind: string; external: boolean }[] }
        > = {};
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            for (const id of Object.keys(output.modules)) inputs.add(id);
            outputs[output.fileName] = {
              imports: [
                ...output.imports.map((path) => ({
                  path,
                  kind: "import-statement",
                  external: !(path in bundle),
                })),
                ...output.dynamicImports.map((path) => ({
                  path,
                  kind: "dynamic-import",
                  external: !(path in bundle),
                })),
              ],
            };
          }
        }
        await mkdir(metadataDirectory, { recursive: true });
        await writeFile(
          `${metadataDirectory}/web.json`,
          JSON.stringify({ inputs: [...inputs].sort(), outputs }),
        );
      },
    },
  ],
});
