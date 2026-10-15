import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * TOOL-1/TOOL-6: every `pnpm <script>` shown as a command in README.md or
 * docs/*.md must exist in root package.json, or in the named package's
 * package.json for `pnpm --filter <name> <script>`. Only code spans and
 * fenced blocks count, so prose such as "pnpm workspaces" is ignored.
 */
const root = new URL("../../", import.meta.url).pathname;
const builtins = new Set([
  "install",
  "i",
  "add",
  "exec",
  "dlx",
  "audit",
  "why",
  "list",
  "outdated",
  "update",
  "store",
]);

function packageScripts() {
  const byName = new Map();
  for (const dir of ["apps", "packages"])
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try {
        manifest = JSON.parse(
          readFileSync(join(root, dir, entry.name, "package.json"), "utf8"),
        );
      } catch {
        continue;
      }
      byName.set(manifest.name, manifest.scripts ?? {});
    }
  return byName;
}

export function codeSegments(markdown) {
  const segments = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const match of markdown.matchAll(fence)) segments.push(match[1]);
  const prose = markdown.replace(fence, "");
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) segments.push(match[1]);
  return segments;
}

/** Returns `{ filter, script }` for each script-invoking pnpm command. */
export function pnpmScriptReferences(segment) {
  const references = [];
  for (const match of segment.matchAll(
    /(?:^|[\s;&|(])pnpm((?:\s+--?[\w-]+(?:[ =](?!-)[^\s]+)?)*)\s+([a-z][\w:.-]*)/g,
  )) {
    const flags = match[1] ?? "";
    let script = match[2];
    if (script === "run") {
      const after = segment.slice(match.index + match[0].length);
      const next = /^\s+([a-z][\w:.-]*)/.exec(after);
      if (!next) continue;
      script = next[1];
    }
    if (builtins.has(script)) continue;
    const filter = /--filter[ =](\S+)/.exec(flags)?.[1] ?? null;
    references.push({ filter, script });
  }
  return references;
}

test("TOOL-6 parser finds root, run and --filter scripts but not exec or prose", () => {
  assert.deepEqual(
    pnpmScriptReferences(
      "pnpm verify && pnpm run dev; pnpm --filter @invoxim/web dev; pnpm --filter @invoxim/worker exec vitest run",
    ),
    [
      { filter: null, script: "verify" },
      { filter: null, script: "dev" },
      { filter: "@invoxim/web", script: "dev" },
    ],
  );
  assert.deepEqual(
    codeSegments(
      "Use pnpm workspaces.\n\n`pnpm lint`\n\n```sh\npnpm build\n```\n",
    ),
    ["pnpm build\n", "pnpm lint"],
  );
});

test("TOOL-1/TOOL-6 every pnpm script named in README.md and docs/*.md exists", () => {
  const rootScripts =
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const packages = packageScripts();
  const files = [
    "README.md",
    ...readdirSync(join(root, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  const missing = [];
  for (const file of files)
    for (const segment of codeSegments(readFileSync(join(root, file), "utf8")))
      for (const { filter, script } of pnpmScriptReferences(segment)) {
        if (filter?.startsWith("<")) continue; // placeholder such as <pkg>
        const scripts = filter ? packages.get(filter) : rootScripts;
        if (!scripts || !Object.hasOwn(scripts, script))
          missing.push(
            `${file}: pnpm ${filter ? `--filter ${filter} ` : ""}${script}`,
          );
      }
  assert.deepEqual(missing, []);
});
