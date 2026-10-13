import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectProductionArtifacts } from "./production-artifacts.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "invoxim-production-"));
  const artifact = path.join(root, "dist");
  const graph = path.join(root, "graph.json");
  await mkdir(artifact);
  await writeFile(path.join(artifact, "index.js"), "export default {};");
  await writeFile(
    graph,
    JSON.stringify({
      inputs: { "src/index.ts": {} },
      outputs: { "dist/index.js": { imports: [] } },
    }),
  );
  try {
    await run({ root, artifact, graph });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("PROD-01 permits runtime artifacts and legitimate debug function names", async () => {
  await fixture(async ({ artifact, graph }) => {
    await writeFile(
      path.join(artifact, "index.js"),
      "function debug(){}; debug();",
    );
    assert.deepEqual(
      await inspectProductionArtifacts({
        artifacts: [artifact],
        graphs: [graph],
      }),
      [],
    );
  });
});

test("PROD-01 rejects forbidden module origins despite minified output", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const input of [
      "node_modules/.pnpm/@playwright+test@1.64.0/node_modules/@playwright/test/index.js",
      "node_modules/vitest/dist/index.js",
      "packages/testkit/src/index.ts",
      "node_modules/@axe-core/playwright/index.js",
      "node_modules/react-devtools-core/index.js",
      "node_modules/node-inspect/index.js",
      "apps/web/tests/login.spec.ts",
      "node_modules/.pnpm/vite@8.3.4/node_modules/vite/dist/client/client.mjs",
      "node_modules/@biomejs/biome/bin/biome",
      "@vite/client",
      "node_modules/typescript/lib/typescript.js",
    ]) {
      await writeFile(
        graph,
        JSON.stringify({
          inputs: { [input]: {} },
          outputs: { "dist/index.js": { imports: [] } },
        }),
      );
      assert.match(
        (
          await inspectProductionArtifacts({
            artifacts: [artifact],
            graphs: [graph],
          })
        ).join("\n"),
        /forbidden build input/,
      );
    }
  });
});

test("PROD-01 rejects external testing or inspector imports", async () => {
  await fixture(async ({ artifact, graph }) => {
    await writeFile(
      graph,
      JSON.stringify({
        inputs: { "src/index.ts": {} },
        outputs: {
          "dist/index.js": {
            imports: [{ path: "node:inspector", external: true }],
          },
        },
      }),
    );
    assert.match(
      (
        await inspectProductionArtifacts({
          artifacts: [artifact],
          graphs: [graph],
        })
      ).join("\n"),
      /forbidden external import/,
    );
  });
});

test("PROD-01 rejects source maps, test reports, dependencies and browser binaries", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const name of [
      "index.js.map",
      "playwright-report/index.html",
      "test-results/trace.zip",
      "node_modules/pkg/index.js",
      "chromium-123/chrome",
      "vitest.config.ts",
      "src/example.test.js",
      ".vite/manifest.json",
    ]) {
      const file = path.join(artifact, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "synthetic");
      assert.match(
        (
          await inspectProductionArtifacts({
            artifacts: [artifact],
            graphs: [graph],
          })
        ).join("\n"),
        /forbidden published artifact/,
      );
      await rm(file);
    }
  });
});

test("PROD-01 rejects symlink publication escapes", async () => {
  await fixture(async ({ root, artifact, graph }) => {
    await writeFile(path.join(root, "outside.js"), "synthetic");
    await symlink(
      path.join(root, "outside.js"),
      path.join(artifact, "escaped.js"),
    );
    assert.match(
      (
        await inspectProductionArtifacts({
          artifacts: [artifact],
          graphs: [graph],
        })
      ).join("\n"),
      /symlink/,
    );
  });
});

test("PROD-01 fails closed for absent or invalid build evidence", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const content of [
      "{}",
      "{",
      '{"inputs":[]}',
      '{"inputs":{"src/index.ts":null}}',
    ]) {
      await writeFile(graph, content);
      assert.notDeepEqual(
        await inspectProductionArtifacts({
          artifacts: [artifact],
          graphs: [graph],
        }),
        [],
      );
    }
    assert.notDeepEqual(
      await inspectProductionArtifacts({ artifacts: [artifact], graphs: [] }),
      [],
    );
    assert.notDeepEqual(
      await inspectProductionArtifacts({
        artifacts: [path.join(artifact, "missing")],
        graphs: [graph],
      }),
      [],
    );
  });
});

test("PROD-01 accepts Vite module evidence and rejects embedded graph publication", async () => {
  await fixture(async ({ artifact, graph }) => {
    await writeFile(
      graph,
      JSON.stringify({
        inputs: [
          "/project/apps/web/src/app.tsx",
          "\u0000vite/preload-helper.js",
        ],
        outputs: { "assets/index.js": { imports: [] } },
      }),
    );
    assert.deepEqual(
      await inspectProductionArtifacts({
        artifacts: [artifact],
        graphs: [graph],
      }),
      [],
    );
    const publicGraph = path.join(artifact, "graph.json");
    await writeFile(
      publicGraph,
      await (await import("node:fs/promises")).readFile(graph),
    );
    assert.match(
      (
        await inspectProductionArtifacts({
          artifacts: [artifact],
          graphs: [publicGraph],
        })
      ).join("\n"),
      /graph must be outside/,
    );
  });
});

test("PROD-02 requires emitted output proof for both build graph formats", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const inputs of [{ "src/index.ts": {} }, ["src/index.ts"]]) {
      for (const outputs of [undefined, {}, { "dist/index.js": {} }]) {
        await writeFile(graph, JSON.stringify({ inputs, outputs }));
        assert.notDeepEqual(
          await inspectProductionArtifacts({
            artifacts: [artifact],
            graphs: [graph],
          }),
          [],
        );
      }
    }
  });
});

test("PROD-02 checks Vite static and dynamic external chunk imports", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const kind of ["import", "dynamic-import"]) {
      await writeFile(
        graph,
        JSON.stringify({
          inputs: ["src/index.ts"],
          outputs: {
            "assets/index.js": {
              imports: [{ path: "playwright-core", kind, external: true }],
            },
          },
        }),
      );
      assert.match(
        (
          await inspectProductionArtifacts({
            artifacts: [artifact],
            graphs: [graph],
          })
        ).join("\n"),
        /forbidden external import playwright-core/,
      );
    }
  });
});

test("PROD-02 distinguishes internal output chunk names from external packages", async () => {
  await fixture(async ({ artifact, graph }) => {
    await writeFile(
      graph,
      JSON.stringify({
        inputs: ["src/index.ts"],
        outputs: {
          "assets/index.js": {
            imports: [
              {
                path: "vitest/chunk.js",
                kind: "dynamic-import",
                external: false,
              },
            ],
          },
        },
      }),
    );
    assert.deepEqual(
      await inspectProductionArtifacts({
        artifacts: [artifact],
        graphs: [graph],
      }),
      [],
    );
  });
});

test("PROD-03 fails closed for missing or malformed external import classification", async () => {
  await fixture(async ({ artifact, graph }) => {
    for (const external of [undefined, null, "true", 0, {}]) {
      for (const inputs of [{ "src/index.ts": {} }, ["src/index.ts"]]) {
        await writeFile(
          graph,
          JSON.stringify({
            inputs,
            outputs: {
              "assets/index.js": {
                imports: [
                  { path: "playwright-core", kind: "dynamic-import", external },
                ],
              },
            },
          }),
        );
        assert.match(
          (
            await inspectProductionArtifacts({
              artifacts: [artifact],
              graphs: [graph],
            })
          ).join("\n"),
          /invalid build import/,
        );
      }
    }
  });
});
