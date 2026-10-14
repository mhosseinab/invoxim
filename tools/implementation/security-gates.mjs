import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const securityTests = Object.freeze(
  [
    "auth-adversarial",
    "ai-adversarial",
    "ai-budget-adversarial",
    "mailbox-adversarial",
    "vault-adversarial",
    "jobs-adversarial",
    "pipeline-adversarial",
    "discovery-adversarial",
    "corrections-adversarial",
    "purchase-adversarial",
    "lifecycle-adversarial",
    "database-adversarial",
    "documents-adversarial",
    "security-headers",
    "proxy",
    "onboarding-adversarial",
    "lifecycle-actor",
    "workspace-token",
    "storage-token",
    "storage-routes",
    "drive-service-adversarial",
    "drive-consent",
    "drive-lifecycle",
    "archive-objects",
    "archive-objects-adversarial",
    "drive-refresh",
    "drive-folders",
    "baseline",
    "historical-upgrade",
    "m1-lifecycle",
  ].map((name) => `test/${name}.test.ts`),
);
const ignored = new Set([
  ".git",
  ".pnpm-store",
  "node_modules",
  ".turbo",
  ".wrangler",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  "__pycache__",
]);
function recognizedBinary(name, header) {
  const extension = path.extname(name).toLowerCase();
  const starts = (bytes) =>
    header.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const ascii = header.toString("latin1");
  if (extension === ".wasm") return starts([0, 97, 115, 109, 1, 0, 0, 0]);
  if (extension === ".png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if ([".jpg", ".jpeg"].includes(extension)) return starts([255, 216, 255]);
  if (extension === ".gif") return /^GIF8[79]a/.test(ascii);
  if (extension === ".webp")
    return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  if (extension === ".ico") return starts([0, 0, 1, 0]);
  if (extension === ".pdf") return /^%PDF-[12]\.[0-9]/.test(ascii);
  if (extension === ".woff") return ascii.startsWith("wOFF");
  if (extension === ".woff2") return ascii.startsWith("wOF2");
  if (extension === ".ttf") return starts([0, 1, 0, 0]);
  if (extension === ".zip")
    return (
      starts([80, 75, 3, 4]) || starts([80, 75, 5, 6]) || starts([80, 75, 7, 8])
    );
  if (extension === ".gz") return starts([31, 139, 8]);
  if ([".sqlite", ".db"].includes(extension))
    return ascii.startsWith("SQLite format 3\0");
  return false;
}
const credential =
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{24,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{24,}|GOCSPX-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----)/g;
const assignment =
  /\b(?:AUTH_SECRET|AI_HOSTED_KEY|[A-Z_]*(?:API_KEY|CLIENT_SECRET)|apiKey|accessToken|refreshToken|clientSecret|password|privateKey|secret)\b["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']/g;
const environmentAssignment =
  /^(?:AUTH_SECRET|AI_HOSTED_KEY|[A-Z_]*(?:API_KEY|CLIENT_SECRET))=([^\s"']{16,})$/gm;
function fixture(file) {
  return (
    ["apps/worker/test/onboarding-qa-fixture.ts"].includes(file) ||
    /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\.example$|(?:^|\/)testkit\/|^evidence\/implementation\/)/.test(
      file,
    )
  );
}
export function secretFindings(text, file) {
  const findings = [];
  for (const [rule, pattern] of [
    ["credential-signature", credential],
    ["credential-assignment", assignment],
    ["environment-assignment", environmentAssignment],
  ]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[0];
      if (
        rule !== "credential-signature" &&
        fixture(file) &&
        (/^(?:synthetic-|qa-|fake-)/.test(value) ||
          (file === "apps/worker/test/auth.test.ts" &&
            ["must-not-persist", "new-must-not-persist"].includes(value)))
      )
        continue;
      findings.push({
        line: text.slice(0, match.index).split("\n").length,
        rule,
      });
    }
  }
  return findings;
}
// Normalize paths and redact recognizable credential signatures in filenames.
export async function scanSecrets(root, limits = {}) {
  const bound = {
    files: 10000,
    fileBytes: 2 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    depth: 24,
    ...limits,
  };
  const result = {
    scannedFiles: 0,
    skippedBinaryFiles: 0,
    bytes: 0,
    findings: [],
  };
  let nodes = 0;
  async function visit(directory, depth) {
    if (depth > bound.depth) throw new Error("scan-depth-limit");
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++nodes > bound.files) throw new Error("scan-file-limit");
      if (ignored.has(item.name)) continue;
      const absolute = path.join(directory, item.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("scan-symlink");
      if (stat.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error("scan-special-file");
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let content;
      try {
        const header = Buffer.alloc(64);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (recognizedBinary(item.name, header.subarray(0, bytesRead))) {
          result.skippedBinaryFiles++;
          continue;
        }
        const openedStat = await handle.stat();
        if (
          openedStat.size > bound.fileBytes ||
          result.bytes + openedStat.size > bound.totalBytes
        )
          throw new Error("scan-byte-limit");
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (
        content.length > bound.fileBytes ||
        result.bytes + content.length > bound.totalBytes
      )
        throw new Error("scan-byte-limit");
      if (content.includes(0)) throw new Error("scan-unrecognized-binary");
      result.bytes += content.length;
      result.scannedFiles++;
      const found = secretFindings(
        content.toString("utf8"),
        path.relative(root, absolute).split(path.sep).join("/"),
      );
      result.findings.push(
        ...found.map((finding) => ({
          path: path
            .relative(root, absolute)
            .split(path.sep)
            .join("/")
            .replace(credential, "[redacted]")
            .replace(/[\p{Cc}\p{Cf}]/gu, "?")
            .slice(0, 300),
          ...finding,
        })),
      );
      if (result.findings.length > 100) throw new Error("scan-finding-limit");
    }
  }
  await visit(root, 0);
  return result;
}

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2");
export function parsePolicyLock(text) {
  const importers = new Map();
  const packages = new Map();
  let section, folder, group, name, packageName;
  let documents = 0;
  for (const line of text.split("\n")) {
    if (
      line.startsWith("lockfileVersion:") &&
      !/^lockfileVersion: ['"]?9\.0['"]?$/.test(line)
    )
      throw new Error("lock-version");
    if (/^lockfileVersion: ['"]?9\.0['"]?$/.test(line)) documents++;
    if (/^[a-zA-Z]+:/.test(line)) {
      section = line.split(":")[0];
      folder = group = name = packageName = undefined;
      continue;
    }
    if (line === "---") {
      section = undefined;
      continue;
    }
    const heading = /^ {2}([^ ].*):$/.exec(line);
    const grouping =
      /^ {4}(dependencies|devDependencies|optionalDependencies|packageManagerDependencies):$/.exec(
        line,
      );
    const dependency = /^ {6}([^ ].*):$/.exec(line);
    const value = /^ {8}(specifier|version): (.+)$/.exec(line);
    if (section === "importers") {
      if (heading) {
        folder = unquote(heading[1]);
        group = name = undefined;
      } else if (grouping) group = grouping[1];
      else if (dependency) {
        if (!folder || !group) throw new Error("lock-importer-format");
        name = unquote(dependency[1]);
        const key = `${folder}\0${group}\0${name}`;
        if (importers.has(key)) throw new Error("lock-duplicate-dependency");
        importers.set(key, {});
      } else if (value) {
        if (!name) throw new Error("lock-value-format");
        importers.get(`${folder}\0${group}\0${name}`)[value[1]] = unquote(
          value[2],
        );
      } else if (line.trim() && !/^ {4}configDependencies: \{\}$/.test(line))
        throw new Error("lock-unsupported-importer-format");
    } else if (section === "packages") {
      if (heading) {
        packageName = unquote(heading[1]);
        if (packages.has(packageName))
          throw new Error("lock-duplicate-package");
        packages.set(packageName, false);
      } else if (
        /^ {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}$/.test(
          line,
        ) &&
        packageName
      )
        packages.set(packageName, true);
    }
  }
  if (!documents || !importers.size || !packages.size)
    throw new Error("lock-version-or-structure");
  return { importers, packages };
}
export function dependencyFindings(manifests, lockText) {
  const { importers, packages } = parsePolicyLock(lockText);
  const findings = [];
  if ([...packages.values()].some((valid) => !valid))
    findings.push({ rule: "lock-package-integrity" });
  const names = new Map(
    manifests.map(({ folder, manifest }) => [manifest.name, folder]),
  );
  const expected = new Set();
  for (const { folder, manifest } of manifests) {
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
        const key = `${folder}\0${group}\0${name}`;
        expected.add(key);
        const entry = importers.get(key);
        let valid = entry?.specifier === specifier;
        if (specifier === "workspace:*")
          valid &&=
            names.has(name) &&
            entry?.version ===
              `link:${path.posix.relative(folder === "." ? "" : folder, names.get(name))}`;
        else
          valid &&=
            /^\d+\.\d+\.\d+$/.test(specifier) &&
            entry?.version?.split("(")[0] === specifier &&
            packages.get(`${name}@${specifier}`) === true;
        if (!valid) findings.push({ rule: "dependency-pin-or-lock-mismatch" });
      }
    }
  }
  const root = manifests.find((item) => item.folder === ".")?.manifest;
  const manager = root?.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  const bootstrap = importers.get(".\0packageManagerDependencies\0pnpm");
  if (
    !manager ||
    root.engines?.pnpm !== manager ||
    bootstrap?.specifier !== manager ||
    bootstrap?.version !== manager ||
    !packages.get(`pnpm@${manager}`)
  )
    findings.push({ rule: "package-manager-pin" });
  for (const key of importers.keys())
    if (!expected.has(key) && key !== ".\0packageManagerDependencies\0pnpm")
      findings.push({ rule: "lock-extra-dependency" });
  return findings;
}
export async function checkDependencies(root) {
  const folders = ["."];
  for (const parent of ["apps", "packages"]) {
    for (const item of await readdir(path.join(root, parent), {
      withFileTypes: true,
    })) {
      if (item.isSymbolicLink()) throw new Error("dependency-symlink");
      if (item.isDirectory()) folders.push(`${parent}/${item.name}`);
      if (folders.length > 50) throw new Error("dependency-manifest-limit");
    }
  }
  const manifests = [];
  for (const folder of folders) {
    const file = path.join(root, folder, "package.json");
    const stat = await lstat(file);
    if (stat.size > 256 * 1024)
      throw new Error("dependency-manifest-byte-limit");
    if (stat.isSymbolicLink()) throw new Error("dependency-symlink");
    manifests.push({
      folder,
      manifest: JSON.parse(await readFile(file, "utf8")),
    });
  }
  const lock = path.join(root, "pnpm-lock.yaml");
  const lockStat = await lstat(lock);
  if (lockStat.size > 2 * 1024 * 1024)
    throw new Error("dependency-lock-byte-limit");
  if (lockStat.isSymbolicLink()) throw new Error("dependency-symlink");
  return {
    manifests: manifests.length,
    findings: dependencyFindings(manifests, await readFile(lock, "utf8")),
  };
}
export async function runSecurityTests(root) {
  for (const file of securityTests) {
    const stat = await lstat(path.join(root, "apps/worker", file));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("security-test-path");
  }
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@invoxim/worker",
        "exec",
        "vitest",
        "run",
        ...securityTests,
      ],
      { cwd: root, stdio: "inherit", shell: false },
    );
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
async function main() {
  const root = process.cwd();
  if (process.argv[2] === "security-tests") {
    process.exitCode = await runSecurityTests(root);
    return;
  }
  const result =
    process.argv[2] === "secrets"
      ? await scanSecrets(root)
      : process.argv[2] === "deps"
        ? await checkDependencies(root)
        : undefined;
  if (!result) throw new Error("unsupported-gate");
  console.log(JSON.stringify(result));
  process.exitCode = result.findings.length ? 1 : 0;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Security gate failed closed: unreadable input, unsupported format, symlink, or scan bound.",
    );
    process.exitCode = 1;
  });
}
