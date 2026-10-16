import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * RELEASE-07 (task OPS-SEMANTIC-DEPLOY-01): the semantic deploy workflow is
 * production automation, so its safety contract is pinned here the same way
 * `biome-policy.test.mjs` and `security-gates.test.mjs` pin the verification
 * workflow:
 * - it reuses the single foundation verification gate rather than redefining it;
 * - deployment is read-only in Git and gated behind the `production` environment;
 * - only main-reachable history may deploy;
 * - Cloudflare resource names come from the checked-in wrangler.jsonc files;
 * - Cloudflare credentials reach only the wrangler steps;
 * - remote migrations, secret changes and releases stay operator steps;
 * - the Worker deploys before the Pages frontend that binds to it.
 */
const root = new URL("../../", import.meta.url).pathname;
const deploy = readFileSync(
  `${root}.github/workflows/semantic-deploy.yml`,
  "utf8",
);
const verify = readFileSync(`${root}.github/workflows/verify.yml`, "utf8");

/** The job-level env block, which must not see deployment credentials. */
function jobEnvBlock() {
  const start = deploy.indexOf("\n    env:\n");
  const end = deploy.indexOf("\n    steps:\n");
  assert.ok(start >= 0 && end > start);
  return deploy.slice(start, end);
}

test("semantic deploy reuses the foundation verification gate", () => {
  assert.ok(verify.includes("\n  workflow_call:\n"));
  assert.ok(deploy.includes("uses: ./.github/workflows/verify.yml"));
  assert.ok(deploy.includes("needs: verify"));
});

test("deployment keeps read-only Git permissions and an approval gate", () => {
  assert.ok(deploy.includes("permissions:\n  contents: read"));
  assert.equal(deploy.includes("contents: write"), false);
  assert.match(deploy, /environment: production\n/);
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

test("only tags and manual runs of main-reachable history can deploy", () => {
  assert.ok(deploy.includes("\n  workflow_dispatch:\n"));
  assert.ok(deploy.includes('- "v*.*.*"'));
  assert.equal(deploy.includes("branches:"), false);
  assert.ok(deploy.includes("fetch-depth: 0"));
  assert.ok(deploy.includes("git merge-base --is-ancestor HEAD origin/main"));
});

test("deployment credentials reach only the wrangler steps", () => {
  const job = jobEnvBlock();
  assert.equal(job.includes("CLOUDFLARE_API_TOKEN"), false);
  assert.equal(job.includes("CLOUDFLARE_ACCOUNT_ID"), false);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    assert.equal(
      deploy.split(`${name}: \${{ secrets.${name} }}`).length - 1,
      3,
      `${name} must be scoped to exactly three steps`,
    );
});

test("remote migrations, secrets and releases stay operator steps", () => {
  assert.ok(deploy.includes("wrangler d1 migrations list DB --remote"));
  assert.equal(deploy.includes("migrations apply"), false);
  assert.equal(deploy.includes("secret put"), false);
  assert.equal(deploy.includes("gh release"), false);
  assert.equal(deploy.includes("continue-on-error"), false);
});

test("resource names come from wrangler.jsonc, not the workflow", () => {
  assert.equal(deploy.includes("vars."), false);
  assert.equal(deploy.includes("--name"), false);
  assert.equal(deploy.includes("--project-name"), false);
  assert.equal(deploy.includes("invoxim-"), false);
});

test("the API Worker deploys before the Pages production branch", () => {
  assert.ok(deploy.includes("pnpm install --frozen-lockfile --ignore-scripts"));
  const worker = deploy.indexOf("exec wrangler deploy\n");
  const pages = deploy.indexOf("exec wrangler pages deploy --branch main\n");
  assert.ok(worker > 0);
  assert.ok(pages > worker);
});
