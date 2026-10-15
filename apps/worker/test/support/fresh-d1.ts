import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { forgetAppliedSchema } from "./db";

/**
 * Test files share one workerd runtime per Vitest worker (`isolate: false`),
 * so they also share its D1 database. Every file builds its own schema, so
 * each one must start from an empty database: drop every trigger, view and
 * table before the file's own hooks run. Indexes go with their tables.
 *
 * Mocks, global stubs and env stubs a previous file failed to undo are also
 * cleared here, before this file starts; nothing inside a file is affected.
 *
 * DROP TABLE runs the parent's ON DELETE actions, which fail once a child
 * table is gone, so tables are dropped child-first: each pass drops what it
 * can and retries the rest until none remain.
 */
vi.restoreAllMocks();
vi.unstubAllGlobals();
vi.unstubAllEnvs();

type SchemaObject = { type: "table" | "view" | "trigger"; name: string };
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function objects(): Promise<SchemaObject[]> {
  const rows = await env.DB.prepare(
    "SELECT type,name FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  ).all<SchemaObject>();
  return rows.results;
}

const initial = await objects();
for (const object of initial.filter((item) => item.type !== "table"))
  await env.DB.prepare(
    `DROP ${object.type.toUpperCase()} IF EXISTS ${quoted(object.name)}`,
  ).run();
let tables = initial.filter((item) => item.type === "table");
while (tables.length) {
  const remaining: SchemaObject[] = [];
  for (const table of tables) {
    try {
      await env.DB.prepare(`DROP TABLE IF EXISTS ${quoted(table.name)}`).run();
    } catch {
      remaining.push(table);
    }
  }
  if (remaining.length === tables.length)
    throw new Error(
      `fresh-d1: could not drop ${remaining.map((table) => table.name).join(", ")}`,
    );
  tables = remaining;
}
forgetAppliedSchema();
