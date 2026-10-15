import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkDependencies,
  dependencyFindings,
  scanSecrets,
  secretFindings,
  securityTests,
} from "./security-gates.mjs";

const token = ["ghp", "_", "A".repeat(36)].join("");
async function temporary(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "security-policy-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("untracked source and tests are scanned without Git and credential values/filenames are redacted", async () =>
  temporary(async (root) => {
    await writeFile(
      path.join(root, `${token}.test.ts`),
      `const apiKey = '${token}';`,
    );
    const result = await scanSecrets(root);
    assert.ok(result.findings.length);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(result.scannedFiles, 1);
  }));
test("synthetic assignment exemption is narrow and never exempts structured keys", () => {
  assert.equal(
    secretFindings('apiKey: "synthetic-model-key-fixture"', "a.test.ts").length,
    0,
  );
  assert.ok(
    secretFindings('apiKey: "synthetic-model-key-fixture"', "src/a.ts").length,
  );
  assert.ok(secretFindings(`apiKey: "${token}"`, "a.test.ts").length);
  assert.ok(
    secretFindings(`apiKey: "${"actual-" + "secret-value-12345"}"`, "a.test.ts")
      .length,
  );
});
test("nested test-run evidence output gets the root evidence synthetic exemption only", () => {
  const synthetic = 'apiKey = "synthetic-model-key-fixture"';
  for (const file of [
    "evidence/implementation/error-context.md",
    "apps/web/evidence/implementation/error-context.md",
  ])
    assert.deepEqual(secretFindings(synthetic, file), []);
  assert.ok(
    secretFindings(synthetic, "apps/web/evidence-notes/implementation/a.md")
      .length,
  );
  assert.ok(
    secretFindings(
      `apiKey = "${token}"`,
      "apps/web/evidence/implementation/error-context.md",
    ).length,
  );
});
test("symlinks and exceeded scan bounds fail closed", async () =>
  temporary(async (root) => {
    await writeFile(path.join(root, "source.ts"), "123456789");
    await assert.rejects(
      scanSecrets(root, { fileBytes: 4 }),
      /scan-byte-limit/,
    );
    await symlink("/tmp", path.join(root, "outside"));
    await assert.rejects(scanSecrets(root), /scan-symlink/);
  }));
test("generated dependencies skipped, evidence and untracked implementation retained", async () =>
  temporary(async (root) => {
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "package.js"), token);
    await writeFile(path.join(root, "implementation.ts"), token);
    assert.equal((await scanSecrets(root)).findings.length, 1);
  }));
test("other agents' .claude/worktrees checkouts are skipped; the rest of .claude is scanned", async () =>
  temporary(async (root) => {
    await mkdir(path.join(root, ".claude", "worktrees", "agent-a"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".claude", "worktrees", "agent-a", "copy.ts"),
      token,
    );
    await mkdir(path.join(root, ".claude", "agents"));
    await writeFile(path.join(root, ".claude", "agents", "role.md"), token);
    await mkdir(path.join(root, "apps", "worktrees"), { recursive: true });
    await writeFile(path.join(root, "apps", "worktrees", "source.ts"), token);
    const { findings } = await scanSecrets(root);
    assert.equal(findings.length, 2);
  }));
const manifests = [
  {
    folder: ".",
    manifest: {
      name: "root",
      packageManager: "pnpm@12.6.0",
      engines: { pnpm: "12.6.0" },
      dependencies: { zod: "4.0.0" },
    },
  },
];
const integrity = `${"A".repeat(86)}==`;
const lock = `---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.6.0\n        version: 12.6.0\npackages:\n  pnpm@12.6.0:\n    resolution: {integrity: sha512-${integrity}}\n---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      zod:\n        specifier: 4.0.0\n        version: 4.0.0\npackages:\n  zod@4.0.0:\n    resolution: {integrity: sha512-${integrity}}\n`;
test("exact multi-document lock accepted; drift, ranges, missing integrity and extra deps rejected", () => {
  assert.deepEqual(dependencyFindings(manifests, lock), []);
  assert.ok(
    dependencyFindings(
      manifests,
      lock.replace("specifier: 4.0.0", "specifier: ^4.0.0"),
    ).length,
  );
  assert.ok(
    dependencyFindings(
      [
        {
          folder: ".",
          manifest: {
            ...manifests[0].manifest,
            dependencies: { zod: "^4.0.0" },
          },
        },
      ],
      lock,
    ).length,
  );
  assert.ok(
    dependencyFindings(
      manifests,
      lock.replace(`sha512-${integrity}`, "missing"),
    ).length,
  );
  assert.ok(
    dependencyFindings(
      [
        {
          folder: ".",
          manifest: { ...manifests[0].manifest, dependencies: {} },
        },
      ],
      lock,
    ).length,
  );
});
test("actual workspace pinned lock and integrated CI/security gates remain executable", async () => {
  assert.deepEqual((await checkDependencies(process.cwd())).findings, []);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    pkg.scripts["check:deps"],
    "pnpm check:dependency-policy && pnpm audit --json",
  );
  assert.equal(
    pkg.scripts["test:security"],
    "node tools/implementation/security-gates.mjs security-tests",
  );
  // ESLint is dropped (OD-5); `lint` delegates to the Biome gate.
  assert.equal(pkg.scripts.lint, "pnpm lint:biome");
  assert.equal(pkg.scripts["lint:biome"], "biome check . --error-on-warnings");
  // Prettier targets are derived from the tree minus .prettierignore, not a
  // hand-maintained path list in the script.
  assert.equal(
    pkg.scripts["format:check"],
    "prettier --check . --ignore-unknown --no-error-on-unmatched-pattern",
  );
  for (const gate of [
    "check:secrets",
    "check:dependency-policy",
    "lint:biome",
    "typecheck",
    "test:unit",
    "test:integration",
    "build",
    "test:e2e",
  ])
    assert.ok(pkg.scripts.verify.split(" && ").includes(`pnpm ${gate}`));
  assert.equal(pkg.scripts.verify.split(" && ").includes("pnpm lint"), false);
  const workflow = await readFile(".github/workflows/verify.yml", "utf8");
  // CI runs each gate once: verify covers dependency-policy and the security
  // suite (via test:integration); only the registry audit is added after it.
  assert.ok(workflow.includes("- run: pnpm verify\n"));
  assert.ok(workflow.includes("- run: pnpm audit --json\n"));
  assert.equal(workflow.includes("- run: pnpm check:deps\n"), false);
  assert.equal(workflow.includes("- run: pnpm test:security\n"), false);
  assert.equal(workflow.includes("continue-on-error"), false);
  for (const file of securityTests)
    assert.ok((await readFile(`apps/worker/${file}`, "utf8")).includes("test"));
});
test("quoted secrets that resemble variable expressions remain secrets", () => {
  assert.ok(
    secretFindings(
      `apiKey: "${"process." + "private-credential-12345"}"`,
      "src/runtime.ts",
    ).length,
  );
});
test("environment credentials and private keys fail regardless of fixture markers", () => {
  assert.ok(
    secretFindings(`AUTH_SECRET=${"operator-".repeat(4)}`, ".env").length,
  );
  const pem = [
    "-----BEGIN",
    "PRIVATE KEY-----\n",
    "A".repeat(64),
    "\n-----END",
    "PRIVATE KEY-----",
  ].join(" ");
  assert.ok(secretFindings(pem, "a.test.ts").length);
});
test("workspace links must resolve the named package; unsupported lock versions fail closed", () => {
  const input = [
    ...manifests,
    { folder: "packages/core", manifest: { name: "@project/core" } },
  ];
  input[0] = {
    folder: ".",
    manifest: {
      ...manifests[0].manifest,
      dependencies: {
        ...manifests[0].manifest.dependencies,
        "@project/core": "workspace:*",
      },
    },
  };
  const workspaceLock = lock.replace(
    "      zod:",
    "      '@project/core':\n        specifier: workspace:*\n        version: link:packages/core\n      zod:",
  );
  assert.deepEqual(dependencyFindings(input, workspaceLock), []);
  assert.ok(
    dependencyFindings(
      input,
      workspaceLock.replace("link:packages/core", "link:packages/other"),
    ).length,
  );
  assert.throws(
    () =>
      dependencyFindings(
        manifests,
        lock.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'"),
      ),
    /lock-version/,
  );
});
test("binary filenames cannot conceal plaintext vendor credentials or private keys", async () =>
  temporary(async (root) => {
    const pem = [
      "-----BEGIN",
      "PRIVATE KEY-----\n",
      "A".repeat(64),
      "\n-----END",
      "PRIVATE KEY-----",
    ].join(" ");
    await writeFile(path.join(root, "leak.png"), token);
    await writeFile(path.join(root, "leak.pdf"), pem);
    const result = await scanSecrets(root);
    assert.deepEqual(result.findings.map(({ path: file }) => file).sort(), [
      "leak.pdf",
      "leak.png",
    ]);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes(pem), false);
    assert.equal(result.skippedBinaryFiles, 0);
  }));
test("recognized PNG and PDF headers are excluded; oversized fake media fails closed", async () =>
  temporary(async (root) => {
    await writeFile(
      path.join(root, "real.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await writeFile(path.join(root, "real.pdf"), "%PDF-1.7\n");
    assert.equal((await scanSecrets(root)).skippedBinaryFiles, 2);
    await writeFile(path.join(root, "fake.png"), "x".repeat(40));
    await assert.rejects(
      scanSecrets(root, { fileBytes: 20 }),
      /scan-byte-limit/,
    );
  }));
test("encrypted PKCS8 and DSA private-key blocks are detected in source and synthetic fixtures", () => {
  for (const variant of ["ENCRYPTED", "DSA"]) {
    const pem = [
      `-----BEGIN ${variant}`,
      "PRIVATE KEY-----\n",
      "A".repeat(64),
      `\n-----END ${variant}`,
      "PRIVATE KEY-----",
    ].join(" ");
    for (const file of [
      "src/private.ts",
      "a.test.ts",
      "evidence/implementation/fixture.txt",
    ]) {
      const found = secretFindings(pem, file);
      assert.deepEqual(found, [{ line: 1, rule: "credential-signature" }]);
      assert.equal(JSON.stringify(found).includes(pem), false);
    }
  }
});

test("recognized WebAssembly header is binary; plaintext credentials with a wasm suffix remain scanned", async () =>
  temporary(async (root) => {
    await writeFile(
      path.join(root, "generated.wasm"),
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    assert.equal((await scanSecrets(root)).skippedBinaryFiles, 1);
    const token = ["sk-", "a".repeat(32)].join("");
    await writeFile(path.join(root, "fake.wasm"), token);
    const result = await scanSecrets(root);
    assert.equal(result.findings.length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  }));
