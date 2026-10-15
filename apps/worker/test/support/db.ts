import { env } from "cloudflare:workers";

/**
 * Applies the full current schema (packages/adapters/migrations/0001–0007).
 * Replaces the 73 hand-rolled partial schemas (X1). Safe to call when a prior
 * fixture already applied an earlier migration — each statement is applied
 * with "IF NOT EXISTS" semantics for objects created by 0001 so the full set
 * can land after a partial application (O12: outlook-runtime raw 0004).
 */
import m0001 from "../../../../packages/adapters/migrations/0001_initial.sql?raw";
import m0002 from "../../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import m0003 from "../../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import m0004 from "../../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import m0005 from "../../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import m0006 from "../../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import m0007 from "../../../../packages/adapters/migrations/0007_archive_document_order.sql?raw";

const migrations: readonly string[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
];

let applied = new WeakSet<D1Database>();

/** Forget which databases have the schema; fresh-d1.ts wipes D1 per test file. */
export function forgetAppliedSchema(): void {
  applied = new WeakSet<D1Database>();
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n")
    .trim();
}

/**
 * Split a migration file into executable statements. Trigger bodies contain
 * semicolons so CREATE TRIGGER … END; is kept whole; everything else splits
 * on `;`. Comments are stripped first so a `;` inside a comment cannot
 * fragment a statement.
 */
export function splitSqlStatements(sql: string): string[] {
  const cleaned = stripComments(sql);
  const statements: string[] = [];
  const triggerRe = /CREATE TRIGGER[\s\S]*?END;/gi;
  let lastIndex = 0;
  let match = triggerRe.exec(cleaned);
  while (match !== null) {
    const before = cleaned.slice(lastIndex, match.index);
    for (const part of before.split(";")) {
      const trimmed = part.trim();
      if (trimmed) statements.push(trimmed);
    }
    const trigger = match[0].trim();
    if (trigger) statements.push(trigger);
    lastIndex = match.index + match[0].length;
    match = triggerRe.exec(cleaned);
  }
  for (const part of cleaned.slice(lastIndex).split(";")) {
    const trimmed = part.trim();
    if (trimmed) statements.push(trimmed);
  }
  return statements;
}

export async function useCurrentSchema(
  database: D1Database = env.DB,
): Promise<void> {
  if (applied.has(database)) return;
  applied.add(database);
  for (const migration of migrations) {
    for (const statement of splitSqlStatements(migration)) {
      try {
        await database.prepare(statement).run();
      } catch (error) {
        // A prior fixture may have applied 0001 already; tolerate
        // "already exists" (CREATE) and UNIQUE constraint (INSERT) re-runs.
        const message = `${error}`;
        if (
          !message.includes("already exists") &&
          !message.includes("UNIQUE constraint")
        )
          throw error;
      }
    }
  }
}
