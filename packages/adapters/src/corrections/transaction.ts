import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import { CorrectionError } from "@invoxim/core";
import { sha256Hex } from "../hash";
export type SqlValue = string | number | null;
export interface VersionCheck {
  sql: string;
  values: SqlValue[];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function commandRoute(command: CorrectionCommand) {
  return `${command.kind}:${"purchaseId" in command ? command.purchaseId : "entryId" in command ? command.entryId : "reviewId" in command ? command.reviewId : command.request.target.id}`;
}
export async function replayCorrection(
  db: D1Database,
  session: CorrectionSession,
  command: CorrectionCommand,
  key: string,
  clock: () => number,
) {
  const live = await db
    .prepare(
      "SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
    )
    .bind(
      session.sessionId,
      session.tenant.userId,
      clock(),
      session.tenant.userId,
    )
    .first();
  if (!live) throw new CorrectionError("CONFLICT");
  const bodyHash = await sha256Hex(JSON.stringify(canonical(command)));
  const route = commandRoute(command);
  const saved = await db
    .prepare(
      "SELECT body_hash,result_json FROM correction_commands WHERE user_id=? AND route=? AND key=?",
    )
    .bind(session.tenant.userId, route, key)
    .first<{ body_hash: string; result_json: string }>();
  if (saved && saved.body_hash !== bodyHash)
    throw new CorrectionError("CONFLICT");
  return {
    bodyHash,
    route,
    result: saved ? (JSON.parse(saved.result_json) as CorrectionResult) : null,
  };
}
export function correctionTransaction(
  db: D1Database,
  session: CorrectionSession,
  key: string,
  identity: { route: string; bodyHash: string },
  result: CorrectionResult,
  checks: VersionCheck[],
  clock: () => number,
) {
  const user = session.tenant.userId,
    executor = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  const guard =
    "EXISTS(SELECT 1 FROM correction_commands WHERE user_id=? AND route=? AND key=? AND executor=?) AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?)";
  const guardValues = [
    user,
    identity.route,
    key,
    executor,
    user,
    session.sessionId,
    user,
    clock(),
  ];
  statements.push(
    db
      .prepare(
        `INSERT INTO correction_commands(user_id,route,key,body_hash,executor,result_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?) ${checks.map((check) => `AND (${check.sql})`).join(" ")} ON CONFLICT DO NOTHING`,
      )
      .bind(
        user,
        identity.route,
        key,
        identity.bodyHash,
        executor,
        JSON.stringify(result),
        clock(),
        user,
        session.sessionId,
        user,
        clock(),
        ...checks.flatMap((check) => check.values),
      ),
  );
  return {
    guard,
    guardValues,
    add(sql: string, values: SqlValue[]) {
      statements.push(db.prepare(sql).bind(...values));
    },
    override(
      entity: "purchase" | "entry",
      entityId: string,
      field: string,
      before: unknown,
      after: unknown,
      revision: number,
    ) {
      statements.push(
        db
          .prepare(
            `INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(user_id,entity_kind,entity_id,field) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision`,
          )
          .bind(
            user,
            entity,
            entityId,
            field,
            JSON.stringify(before),
            JSON.stringify(after),
            revision,
            ...guardValues,
          ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,field,before_json,after_json,created_at) SELECT ?,?,?,?,'field-corrected',?,?,?,? WHERE ${guard}`,
          )
          .bind(
            crypto.randomUUID(),
            user,
            entity,
            entityId,
            field,
            JSON.stringify(before),
            JSON.stringify(after),
            clock(),
            ...guardValues,
          ),
      );
    },
    audit(
      entity: "purchase" | "entry" | "review",
      entityId: string,
      action: string,
      before: unknown,
      after: unknown,
    ) {
      statements.push(
        db
          .prepare(
            `INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
          )
          .bind(
            crypto.randomUUID(),
            user,
            entity,
            entityId,
            action,
            JSON.stringify(before),
            JSON.stringify(after),
            clock(),
            ...guardValues,
          ),
      );
    },
    async commit() {
      if (statements.length > 32) throw new CorrectionError("TOO_LARGE");
      try {
        await db.batch(statements);
      } catch {
        throw new CorrectionError("CONFLICT");
      }
      const saved = await db
        .prepare(
          "SELECT body_hash,result_json FROM correction_commands WHERE user_id=? AND route=? AND key=?",
        )
        .bind(user, identity.route, key)
        .first<{ body_hash: string; result_json: string }>();
      if (!saved || saved.body_hash !== identity.bodyHash)
        throw new CorrectionError("CONFLICT");
      return JSON.parse(saved.result_json) as CorrectionResult;
    },
  };
}
