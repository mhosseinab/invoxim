import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * TOOL-2: the semantic deploy workflow is production automation, so its safety
 * contract is pinned here the same way `biome-policy.test.mjs` and
 * `security-gates.test.mjs` pin the verification workflow:
 * - it reuses the single foundation verification gate rather than redefining it;
 * - deployment is read-only in Git and gated behind the `production` environment;
 * - only main-reachable history and strict `vX.Y.Z` tags may deploy;
 * - remote migrations and secret mutation stay manual operator steps;
 * - the Worker deploys before the Pages frontend that binds to it.
 */
const root = new URL("../../", import.meta.url).pathname;
const deploy = readFileSync(
  `${root}.github/workflows/semantic-deploy.yml`,
  "utf8",
);
const verify = readFileSync(`${root}.github/workflows/verify.yml`, "utf8");

test("semantic deploy reuses the foundation verification gate", () => {
  assert.ok(verify.includes("\n  workflow_call:\n"));
  assert.ok(deploy.includes("uses: ./.github/workflows/verify.yml"));
  assert.ok(deploy.includes("needs: verify"));
});

test("deployment keeps read-only Git permissions and an approval gate", () => {
  assert.ok(deploy.includes("permissions:\n  contents: read"));
  assert.equal(deploy.includes("contents: write"), false);
  assert.ok(deploy.includes("environment:"));
  assert.match(deploy, /environment:\n {6}name: production\n/);
});

test("every action is pinned to an immutable revision", () => {
  const used = [...deploy.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map(
    (match) => match[1],
  );
  assert.ok(used.length > 0);
  for (const reference of used) {
    if (reference.startsWith("./")) continue;
    assert.match(reference, /@[0-9a-f]{40} # v/);
  }
});

test("only main history and strict vX.Y.Z tags can deploy", () => {
  assert.ok(deploy.includes("tags:"));
  assert.ok(deploy.includes('- "v*.*.*"'));
  assert.ok(deploy.includes("branches:"));
  assert.ok(deploy.includes("- main"));
  assert.ok(deploy.includes("git merge-base --is-ancestor"));
  assert.ok(
    deploy.includes("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"),
  );
});

test("remote migrations and secrets stay manual operator steps", () => {
  assert.ok(deploy.includes("migrations list invoxim-db --remote"));
  assert.equal(deploy.includes("migrations apply"), false);
  assert.equal(deploy.includes("secret put"), false);
  assert.equal(deploy.includes("continue-on-error"), false);
});

test("the API Worker deploys before the Pages frontend", () => {
  const worker = deploy.indexOf("exec wrangler deploy");
  const pages = deploy.indexOf("exec wrangler pages deploy");
  assert.ok(worker > 0);
  assert.ok(pages > worker);
});
