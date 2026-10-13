import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
function check(source, directory = "apps/worker/test") {
  const fixture = resolve(root, `${directory}/biome-policy-${randomUUID()}.ts`);
  writeFileSync(fixture, source);
  try {
    return spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/@biomejs/biome/bin/biome"),
        "check",
        fixture,
        "--error-on-warnings",
      ],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
  } finally {
    rmSync(fixture, { force: true });
  }
}

test("verification and CI cannot omit the pinned Biome gate", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  assert.equal(
    manifest.scripts["lint:biome"],
    "biome check . --error-on-warnings",
  );
  assert.ok(manifest.scripts.verify.split(" && ").includes("pnpm lint:biome"));
  assert.doesNotMatch(manifest.scripts.verify, /\|\||;/);
  const workflow = readFileSync(
    resolve(root, ".github/workflows/verify.yml"),
    "utf8",
  );
  assert.match(workflow, /^ {6}- run: pnpm verify$/m);
  assert.equal(manifest.devDependencies["@biomejs/biome"], "2.5.15");
  const config = JSON.parse(readFileSync(resolve(root, "biome.json"), "utf8"));
  assert.equal(config.linter.enabled, true);
  assert.equal(config.linter.rules.preset, "recommended");
  assert.equal(config.linter.rules.style.noNonNullAssertion, "error");
  assert.equal(config.linter.rules.style.useTemplate, "error");
  assert.equal(
    config.linter.rules.suspicious.noControlCharactersInRegex,
    "error",
  );
  assert.equal(config.overrides, undefined);
  assert.equal(config.files.includes, undefined);
});
test("actual Biome rejects non-null assertions in test files", () => {
  for (const directory of [
    "apps/worker/test",
    "packages/core/test",
    "packages/contracts/test",
  ]) {
    const result = check(
      "declare const value: { id: string } | null;\nexport const id = value!.id;\n",
      directory,
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /noNonNullAssertion/);
  }
});
test("actual Biome rejects control-character regex diagnostics", () => {
  const result = check(
    String.raw`export const invalid = /[\u0000-\u001f\u007f]/;`,
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /noControlCharactersInRegex/);
});
