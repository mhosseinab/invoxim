import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { synchronizeAiVariables } from "./sync-ai-config.mjs";

const preset = JSON.parse(
  await readFile(
    new URL("../../config/ai.abacus.production.json", import.meta.url),
    "utf8",
  ),
);
const wrangler = await readFile(
  new URL("../../apps/worker/wrangler.jsonc", import.meta.url),
  "utf8",
);
test("runtime AI fields match the canonical preset", () => {
  assert.equal(synchronizeAiVariables(preset, wrangler), wrangler);
});
test("changing a model generates its escaped runtime fields while preserving OAuth and resource configuration", () => {
  const changed = {
    ...preset,
    variables: { ...preset.variables, AI_HOSTED_MODEL: "synthetic-model" },
  };
  const generated = synchronizeAiVariables(changed, wrangler);
  assert.notEqual(generated, wrangler);
  assert.equal(
    generated.replace(
      '"AI_HOSTED_MODEL": "synthetic-model"',
      '"AI_HOSTED_MODEL": "gpt-6-luna"',
    ),
    wrangler,
  );
  assert.equal(synchronizeAiVariables(changed, generated), generated);
});
test("missing or duplicate fields fail before overwriting configuration", () => {
  assert.throws(
    () =>
      synchronizeAiVariables(
        preset,
        wrangler.replace(/.*"AI_ENABLED".*\n/, ""),
      ),
    /Expected one existing/,
  );
  assert.throws(
    () =>
      synchronizeAiVariables(
        preset,
        `${wrangler}\n    "AI_ENABLED": "true",\n`,
      ),
    /Expected one existing/,
  );
});
test("plaintext credentials and unapproved variable names cannot enter the public preset", () => {
  assert.throws(
    () =>
      synchronizeAiVariables(
        { ...preset, apiKey: "synthetic-forbidden-key" },
        wrangler,
      ),
    /credentials belong/,
  );
  assert.throws(
    () =>
      synchronizeAiVariables(
        {
          ...preset,
          variables: {
            ...preset.variables,
            AI_HOSTED_KEY: "synthetic-forbidden-key",
          },
        },
        wrangler,
      ),
    /credentials belong/,
  );
});
