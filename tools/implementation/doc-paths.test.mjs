import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";

/**
 * Docs must not point at repository paths under `evidence/` or `docs/` that
 * do not exist. Evidence records are kept outside git (removed in fe99887),
 * so a doc citing `evidence/...` would send a reader to a missing file.
 *
 * Deliberately narrow:
 * - only tracked *.md files outside `.agents/` (backlog history lives there);
 * - only file paths with an extension, or markdown link targets, so prose
 *   such as "evidence/ledger entries" is not a path;
 * - the plan's historical appendix (`# Appendix` onward) is skipped.
 */
const root = new URL("../../", import.meta.url).pathname;
const historicalFrom = new Map([
  ["docs/code-quality-refactor-plan.md", /^# Appendix\b/m],
]);
const prefix = String.raw`(?:\.\.\/)*(?:docs|evidence)\/`;
const linkTarget = new RegExp(String.raw`\]\((${prefix}[^)\s#]*)`, "g");
const filePath = new RegExp(
  String.raw`(?:^|[\s\x60(\["'])(${prefix}[A-Za-z0-9._/-]*\.[A-Za-z0-9]{1,6})(?![A-Za-z0-9_/-])`,
  "gm",
);

/** Repository path references in one markdown text, in source order. */
export function docPathReferences(markdown, file = "") {
  const cut = historicalFrom.get(file)?.exec(markdown);
  const text = cut ? markdown.slice(0, cut.index) : markdown;
  const found = new Set();
  for (const pattern of [linkTarget, filePath])
    for (const match of text.matchAll(pattern))
      found.add(match[1].replace(/[.,;:]+$/, ""));
  return [...found];
}

/** Root-relative candidates: file-relative for `../`, else either form. */
function candidates(file, reference) {
  const fromFile = normalize(join(dirname(file), reference));
  return reference.startsWith("../")
    ? [fromFile]
    : [normalize(reference), fromFile];
}

export function missingDocPaths(repositoryRoot, files, read) {
  const missing = [];
  for (const file of files)
    for (const reference of docPathReferences(read(file), file))
      if (
        !candidates(file, reference).some(
          (candidate) =>
            !candidate.startsWith("..") &&
            existsSync(join(repositoryRoot, candidate)),
        )
      )
        missing.push(`${file}: ${reference}`);
  return missing;
}

function trackedDocs() {
  return execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !file.startsWith(".agents/"));
}

test("docs reference only existing evidence/ and docs/ repository paths", () => {
  const files = trackedDocs();
  assert.ok(files.includes("DEPLOYMENT_CHECKLIST.md"));
  assert.deepEqual(
    missingDocPaths(root, files, (file) =>
      readFileSync(join(root, file), "utf8"),
    ),
    [],
  );
});

test("removed evidence records and missing docs are reported", () => {
  const docs = {
    "README.md":
      "See `evidence/implementation/gone.md` and [plan](docs/missing-plan.md).",
    "packages/adapters/README.md":
      "[gone](../../evidence/implementation/gone.md) [ok](../../docs/02-architecture.md)",
  };
  assert.deepEqual(
    missingDocPaths(root, Object.keys(docs), (file) => docs[file]),
    [
      "README.md: docs/missing-plan.md",
      "README.md: evidence/implementation/gone.md",
      "packages/adapters/README.md: ../../evidence/implementation/gone.md",
    ],
  );
});

test("prose, other prefixes and the plan's historical appendix are not flagged", () => {
  assert.deepEqual(
    docPathReferences(
      "Refunds use separate evidence/ledger entries; recompute evidence/eligibility. " +
        "The `evidence/` policy. See `apps/evidence/x.md` and `mydocs/x.md`.",
    ),
    [],
  );
  const plan =
    "Live `docs/02-architecture.md`.\n\n# Appendix: raw findings\n\n- `evidence/implementation/old.md`\n";
  assert.deepEqual(
    docPathReferences(plan, "docs/code-quality-refactor-plan.md"),
    ["docs/02-architecture.md"],
  );
  assert.deepEqual(docPathReferences(plan, "other.md"), [
    "docs/02-architecture.md",
    "evidence/implementation/old.md",
  ]);
});
