import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Explicit test/debugging runtimes. Ordinary runtime functions named debug and
// build-time tooling are not evidence that their packages were published.
const forbiddenPackages = new Set([
  "@playwright/test",
  "playwright",
  "playwright-core",
  "@axe-core/playwright",
  "axe-core",
  "vitest",
  "@vitest/runner",
  "@vitest/browser",
  "@vitest/ui",
  "@vitest/expect",
  "@vitest/spy",
  "@cloudflare/vitest-plugin",
  "jest",
  "jest-runtime",
  "@jest/core",
  "@jest/globals",
  "@invoxim/testkit",
  "react-devtools",
  "react-devtools-core",
  "react-devtools-inline",
  "node-inspect",
  "chrome-remote-interface",
  "puppeteer",
  "puppeteer-core",
  "@testing-library/react",
  "@testing-library/dom",
  "@testing-library/jest-dom",
  "@biomejs/biome",
  "eslint",
  "prettier",
  "turbo",
  "typescript",
  "typescript-eslint",
  "vite",
  "@vite/client",
  "@vite/env",
]);
const forbiddenDirectories =
  /^(?:tests?|__tests__|__mocks__|test-results|playwright-report|blob-report|coverage|node_modules|\.vite|\.turbo|\.wrangler|\.git|\.cache|ms-playwright|chromium(?:-\d+)?|firefox(?:-\d+)?|webkit(?:-\d+)?)$/i;
const forbiddenFiles =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\.map$|^(?:playwright|vitest|jest|vite)\.config\.|^(?:metafile|build-graph)\.json$)/i;

function normalized(value) {
  return value.replaceAll("\\", "/");
}
function packageName(value) {
  const source = normalized(value);
  const marker = source.lastIndexOf("/node_modules/");
  const bare =
    marker >= 0
      ? source.slice(marker + 14)
      : source.replace(/^node_modules\//, "");
  const parts = bare.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
function forbiddenInput(value) {
  const source = normalized(value);
  const name = packageName(source);
  return (
    forbiddenPackages.has(name) ||
    name.startsWith("@vitest/") ||
    name.startsWith("@jest/") ||
    name.startsWith("@types/") ||
    (source.startsWith("\u0000") &&
      /^vite\/(?:client|env|hmr)(?:[/.]|$)/.test(source.slice(1))) ||
    /(?:^|\/)packages\/testkit(?:\/|$)/.test(source) ||
    source
      .split("/")
      .some((part) => /^(?:tests?|__tests__|__mocks__)$/i.test(part)) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?(?:\?|$)/i.test(source) ||
    /^(?:node:)?inspector(?:\/|$)/.test(source)
  );
}
function inside(folder, file) {
  const relative = path.relative(folder, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function graphInputs(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
  if (
    !graph.outputs ||
    typeof graph.outputs !== "object" ||
    Array.isArray(graph.outputs)
  )
    return null;
  const outputs = Object.entries(graph.outputs);
  if (
    !outputs.length ||
    outputs.some(
      ([name, output]) =>
        !name ||
        !output ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        !Array.isArray(output.imports),
    )
  )
    return null;
  if (Array.isArray(graph.inputs)) {
    return graph.inputs.length > 0 &&
      graph.inputs.every(
        (entry) => typeof entry === "string" && entry.length > 0,
      )
      ? graph.inputs
      : null;
  }
  if (!graph.inputs || typeof graph.inputs !== "object") return null;
  const entries = Object.entries(graph.inputs);
  if (
    !entries.length ||
    entries.some(
      ([name, details]) =>
        !name ||
        !details ||
        typeof details !== "object" ||
        Array.isArray(details),
    )
  )
    return null;
  if (
    !graph.outputs ||
    typeof graph.outputs !== "object" ||
    Array.isArray(graph.outputs)
  )
    return null;
  return entries.map(([name]) => name);
}

async function inspectGraph(file, artifactRoots, errors) {
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new Error("not a regular file");
    const resolved = await realpath(file);
    if (artifactRoots.some((root) => inside(root, resolved)))
      errors.push(`${file}: graph must be outside publication directories`);
    const graph = JSON.parse(await readFile(file, "utf8"));
    const inputs = graphInputs(graph);
    if (!inputs) {
      errors.push(`${file}: missing or invalid build inputs`);
      return;
    }
    for (const input of inputs)
      if (forbiddenInput(input))
        errors.push(`${file}: forbidden build input ${input}`);
    for (const output of Object.values(graph.outputs ?? {})) {
      if (
        !output ||
        typeof output !== "object" ||
        (output.imports !== undefined && !Array.isArray(output.imports))
      ) {
        errors.push(`${file}: invalid build output`);
        continue;
      }
      for (const entry of output.imports ?? []) {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          !entry.path ||
          typeof entry.external !== "boolean"
        )
          errors.push(`${file}: invalid build import`);
        else if (entry.external === true && forbiddenInput(entry.path))
          errors.push(`${file}: forbidden external import ${entry.path}`);
      }
    }
  } catch {
    errors.push(`${file}: cannot read valid build graph`);
  }
}

async function inspectDirectory(folder, errors) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${file}: symlink in publication directory`);
      continue;
    }
    if (
      forbiddenDirectories.test(entry.name) ||
      forbiddenFiles.test(entry.name)
    )
      errors.push(`${file}: forbidden published artifact`);
    if (entry.isDirectory()) await inspectDirectory(file, errors);
    else if (!entry.isFile())
      errors.push(`${file}: unsupported published artifact`);
  }
}

export async function inspectProductionArtifacts({
  artifacts = [],
  graphs = [],
} = {}) {
  const errors = [];
  const artifactRoots = [];
  if (!artifacts.length)
    errors.push("At least one production artifact directory is required");
  if (!graphs.length)
    errors.push("At least one production build graph is required");
  for (const artifact of artifacts) {
    try {
      const stats = await lstat(artifact);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new Error("not a regular directory");
      artifactRoots.push(await realpath(artifact));
      const entries = await readdir(artifact);
      if (!entries.length)
        errors.push(`${artifact}: empty publication directory`);
      await inspectDirectory(artifact, errors);
    } catch {
      errors.push(`${artifact}: cannot inspect production artifact directory`);
    }
  }
  for (const graph of graphs) await inspectGraph(graph, artifactRoots, errors);
  return errors;
}

async function main(args) {
  const artifacts = [],
    graphs = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!value || !["--artifact", "--graph"].includes(flag))
      throw new Error(
        "Usage: production-artifacts.mjs --artifact <directory> --graph <json> (repeat flags for each build)",
      );
    (flag === "--artifact" ? artifacts : graphs).push(value);
  }
  const errors = await inspectProductionArtifacts({ artifacts, graphs });
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      "Production artifacts and build inputs passed the test/debug publication guard.\n",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
