import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGraph } from "./boundaries.mjs";

const unit = (layer, dependencies = [], imports = []) => ({
  name: `@invoxim/${layer}`,
  layer,
  dependencies,
  imports,
});
test("FOUND-03 allows web/contracts and worker/core/adapters", () => {
  assert.deepEqual(
    validateGraph([
      unit("web", ["@invoxim/contracts"]),
      unit("worker", ["@invoxim/core", "@invoxim/adapters"]),
      unit("core"),
      unit("adapters", ["@invoxim/core"]),
      unit("contracts"),
    ]),
    [],
  );
});
test("FOUND-03 rejects unknown workspace dependency", () => {
  assert.match(
    validateGraph([unit("core", ["@invoxim/missing"])])[0],
    /unknown/,
  );
});
test("FOUND-03 rejects cycles", () => {
  assert.match(
    validateGraph([
      unit("core", ["@invoxim/contracts"]),
      unit("contracts", ["@invoxim/core"]),
    ]).join("\n"),
    /cycle/,
  );
});
test("FOUND-03 rejects infrastructure in core and production testkit", () => {
  for (const name of ["@prisma/client", "@prisma/adapter-d1", "prisma"]) {
    for (const layer of ["core", "contracts"])
      assert.match(
        validateGraph([unit(layer, [name])]).join("\n"),
        /forbidden infrastructure/,
      );
  }
  assert.match(
    validateGraph([unit("core", [], ["hono"])]).join("\n"),
    /forbidden/,
  );
  assert.match(
    validateGraph([
      unit("web", [], ["@invoxim/testkit"]),
      unit("testkit"),
    ]).join("\n"),
    /forbidden/,
  );
});
test("FOUND-03 rejects relative cross-layer bypass and undeclared imports", () => {
  assert.match(
    validateGraph([
      unit("core", [], ["@invoxim/adapters"]),
      unit("adapters"),
    ]).join("\n"),
    /forbidden/,
  );
  assert.match(
    validateGraph([
      unit("web", [], ["@invoxim/contracts"]),
      unit("contracts"),
    ]).join("\n"),
    /undeclared/,
  );
});

test("FOUND-03 CLI checks relative and workspace-subpath imports including re-exports", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "invoxim-boundaries-"));
  try {
    for (const layer of ["core", "adapters", "contracts"]) {
      await mkdir(path.join(root, "packages", layer), { recursive: true });
      await writeFile(
        path.join(root, "packages", layer, "package.json"),
        JSON.stringify({ name: `@invoxim/${layer}` }),
      );
    }
    await writeFile(
      path.join(root, "packages/core/index.ts"),
      'export { x } from "../adapters/index.js";\nimport "@invoxim/contracts/schema";',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["tools/implementation/check-boundaries.mjs", root],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /forbidden dependency @invoxim\/adapters/);
        assert.match(error.stderr, /undeclared dependency @invoxim\/contracts/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SW-2 CLI rejects deep relative imports that cross into another package", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "invoxim-boundaries-"));
  try {
    for (const layer of ["core", "adapters"]) {
      await mkdir(path.join(root, "packages", layer, "src"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "packages", layer, "package.json"),
        JSON.stringify({
          name: `@invoxim/${layer}`,
          dependencies:
            layer === "adapters" ? { "@invoxim/core": "workspace:*" } : {},
        }),
      );
    }
    await writeFile(
      path.join(root, "packages/core/src/index.ts"),
      "export const core = 1;\n",
    );
    await writeFile(
      path.join(root, "packages/adapters/src/index.ts"),
      'import { core } from "../../core/src/index";\nexport const adapter = core;\n',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["tools/implementation/check-boundaries.mjs", root],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(
          error.stderr,
          /deep relative import .* must go through package root @invoxim\/core/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SW-2 CLI rejects workspace subpath imports that bypass the package root", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "invoxim-boundaries-"));
  try {
    for (const layer of ["core", "adapters"]) {
      await mkdir(path.join(root, "packages", layer, "src"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "packages", layer, "package.json"),
        JSON.stringify({
          name: `@invoxim/${layer}`,
          dependencies:
            layer === "adapters" ? { "@invoxim/core": "workspace:*" } : {},
        }),
      );
    }
    await writeFile(
      path.join(root, "packages/core/src/index.ts"),
      "export const core = 1;\n",
    );
    await writeFile(
      path.join(root, "packages/adapters/src/index.ts"),
      'import { core } from "@invoxim/core/src/index";\nexport const adapter = core;\n',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["tools/implementation/check-boundaries.mjs", root],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(
          error.stderr,
          /subpath import @invoxim\/core\/src\/index must go through package root @invoxim\/core/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FOUND-03 CLI rejects import types, import-equals and declared external infrastructure", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "invoxim-boundaries-"));
  try {
    const folder = path.join(root, "packages/core");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "package.json"),
      JSON.stringify({
        name: "@invoxim/core",
        dependencies: { "drizzle-orm": "0.45.4" },
      }),
    );
    await writeFile(
      path.join(folder, "index.ts"),
      'type Env = import("cloudflare:workers").Env;\nimport auth = require("better-auth");',
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["tools/implementation/check-boundaries.mjs", root],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => {
        assert.equal(error.status, 1);
        for (const name of ["cloudflare:workers", "better-auth", "drizzle-orm"])
          assert.ok(
            error.stderr.includes(`forbidden infrastructure import ${name}`),
          );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
