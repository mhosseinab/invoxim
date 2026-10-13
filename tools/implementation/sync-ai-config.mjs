import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const variableNames = [
  "AI_ENABLED",
  "AI_HOSTED_DESTINATION",
  "AI_HOSTED_MODEL",
];
/** Updates only existing AI variable lines; OAuth, bindings and secrets stay untouched. */
export function synchronizeAiVariables(preset, wrangler) {
  if (
    !preset?.variables ||
    !Array.isArray(preset.registry) ||
    !preset.budget ||
    Object.keys(preset.variables).sort().join() !==
      [...variableNames].sort().join() ||
    variableNames.some((name) => typeof preset.variables[name] !== "string") ||
    /"(?:apiKey|AI_HOSTED_KEY|CREDENTIAL_KEYRING)"\s*:/.test(
      JSON.stringify(preset),
    )
  ) {
    throw new Error(
      "Invalid public AI preset; credentials belong in platform secrets",
    );
  }
  const values = {
    ...preset.variables,
    AI_REGISTRY_JSON: JSON.stringify(preset.registry),
    AI_BUDGET_JSON: JSON.stringify(preset.budget),
  };
  let result = wrangler;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(
      `^([ \t]*)"${name}":[ \t]*"(?:[^"\\\\]|\\\\.)*"(,?)[ \t]*$`,
      "gm",
    );
    const matches = [...result.matchAll(line)];
    if (matches.length !== 1)
      throw new Error(`Expected one existing ${name} variable line`);
    result = result.replace(
      line,
      (_, indent, comma) =>
        `${indent}"${name}": ${JSON.stringify(value)}${comma}`,
    );
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || !["--check", "--write"].includes(mode[0]))
    throw new Error("Use --check or --write");
  const preset = JSON.parse(
    await readFile("config/ai.abacus.production.json", "utf8"),
  );
  const target = "apps/worker/wrangler.jsonc";
  const current = await readFile(target, "utf8");
  const generated = synchronizeAiVariables(preset, current);
  if (mode[0] === "--write") {
    await writeFile(target, generated);
    console.info("AI runtime variables generated from the public preset");
  } else {
    if (current !== generated)
      throw new Error("AI configuration drift: run pnpm ai:config");
    console.info("AI runtime variables match the public preset");
  }
}
