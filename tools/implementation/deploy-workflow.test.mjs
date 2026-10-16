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
 * - only main-reachable history and strict `vX.Y.Z` tags may deploy;
 * - deploy targets and the production branch come from environment variables;
 * - the Pages production branch is verified before anything deploys;
 * - Cloudflare credentials reach only the wrangler/API steps;
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

/** The script of the named step, so literals cannot pass from a comment. */
function stepScript(id) {
  const marker = `\n        id: ${id}\n`;
  const start = deploy.indexOf(marker);
  assert.ok(start >= 0);
  const run = deploy.indexOf("\n        run: |", start);
  assert.ok(run > start);
  const end = deploy.indexOf("\n      - ", run);
  return deploy.slice(run, end < 0 ? deploy.length : end);
}

test("semantic deploy reuses the foundation verification gate", () => {
  assert.ok(verify.includes("\n  workflow_call:\n"));
  assert.ok(deploy.includes("uses: ./.github/workflows/verify.yml"));
  assert.ok(deploy.includes("needs: verify"));
});

test("deployment keeps read-only Git permissions and an approval gate", () => {
  assert.ok(deploy.includes("permissions:\n  contents: read"));
  assert.equal(deploy.includes("contents: write"), false);
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
  assert.ok(deploy.includes("\n  workflow_dispatch:\n"));
  assert.ok(deploy.includes('- "v*.*.*"'));
  assert.ok(deploy.includes("      - main"));
  const script = stepScript("version");
  assert.ok(
    script.includes('commit="$(git rev-parse "$GITHUB_SHA^{commit}")"'),
  );
  assert.ok(
    script.includes(
      'if ! git merge-base --is-ancestor "$commit" origin/main; then',
    ),
  );
  assert.ok(
    script.includes(
      '[[ ! "$GITHUB_REF_NAME" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
    ),
  );
  // The peeled commit, not the raw ref, identifies the deploy.
  assert.ok(script.includes(`version="main-\${commit:0:7}"`));
});

test("deployment credentials reach only the wrangler and check steps", () => {
  const job = jobEnvBlock();
  assert.equal(job.includes("CLOUDFLARE_API_TOKEN"), false);
  assert.equal(job.includes("CLOUDFLARE_ACCOUNT_ID"), false);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    assert.equal(
      deploy.split(`${name}: \${{ secrets.${name} }}`).length - 1,
      4,
      `${name} must be scoped to exactly four steps`,
    );
});

test("remote migrations, secrets and releases stay operator steps", () => {
  assert.ok(
    deploy.includes('wrangler d1 migrations list "$D1_DATABASE_NAME" --remote'),
  );
  assert.equal(deploy.includes("migrations apply"), false);
  assert.equal(deploy.includes("secret put"), false);
  assert.equal(deploy.includes("gh release"), false);
  assert.equal(deploy.includes("continue-on-error"), false);
});

test("deploy targets come from environment variables", () => {
  const job = jobEnvBlock();
  for (const name of [
    "WORKER_NAME",
    "PAGES_PROJECT_NAME",
    "PAGES_PRODUCTION_BRANCH",
    "D1_DATABASE_NAME",
  ])
    assert.ok(
      job.includes(`${name}: \${{ vars.${name} }}`),
      `${name} must come from a repository or environment variable, without an in-file default`,
    );
  // No Cloudflare resource name may be hardcoded anywhere in the workflow.
  assert.equal(deploy.includes("invoxim-"), false);
  assert.ok(
    deploy.includes(
      `url: \${{ vars.PAGES_URL || format('https://{0}.pages.dev/', vars.PAGES_PROJECT_NAME) }}`,
    ),
    "the environment URL must come from variables too",
  );
  const preflight = stepScript("config");
  assert.ok(preflight.includes("Missing Actions variables"));
  assert.ok(preflight.includes("exit 1"));
  assert.ok(deploy.includes('exec wrangler deploy --name "$WORKER_NAME"'));
  assert.ok(
    deploy.includes(
      'exec wrangler pages deploy dist --project-name "$PAGES_PROJECT_NAME" --branch "$PAGES_PRODUCTION_BRANCH" --commit-hash',
    ),
  );
});

test("the Pages production branch is verified before deploying", () => {
  const script = stepScript("pages-project");
  assert.ok(script.includes("pages/projects/$PAGES_PROJECT_NAME"));
  assert.ok(script.includes("production_branch"));
  assert.ok(script.includes('[ "$branch" != "$PAGES_PRODUCTION_BRANCH" ]'));
  assert.ok(script.includes("exit 1"));
  const check = deploy.indexOf("id: pages-project");
  const worker = deploy.indexOf("exec wrangler deploy");
  assert.ok(check > 0 && worker > check);
});

test("the API Worker deploys before the Pages frontend", () => {
  assert.ok(deploy.includes("pnpm install --frozen-lockfile --ignore-scripts"));
  const worker = deploy.indexOf("exec wrangler deploy");
  const pages = deploy.indexOf("exec wrangler pages deploy");
  assert.ok(worker > 0);
  assert.ok(pages > worker);
  // The deployed commit is the peeled one resolved by the version step.
  assert.ok(
    deploy.includes(
      `--branch "$PAGES_PRODUCTION_BRANCH" --commit-hash "\${{ steps.version.outputs.commit }}"`,
    ),
  );
});
