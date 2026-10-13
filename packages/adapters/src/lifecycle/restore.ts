import { hasControlCharacters } from "@invoxim/contracts";
import { z } from "zod";
import { createLifecycleCleanup } from "./cleanup";

export interface RestoreOperator {
  /** Trusted operator procedure verifies this database is not serving or consuming. */
  assertIsolated(): Promise<void>;
  /** Only returns pages from an independently authenticated, completeness-reviewed export. */
  readReviewedPage(cursor: string | null): Promise<unknown>;
}
export interface RestoreSnapshot {
  id: string;
  at: number;
  cutoff: number;
  exportId: string;
}
interface CheckpointIdentity {
  snapshotId: string;
  exportId: string;
}
export type RestoreCheckpoint = CheckpointIdentity &
  (
    | { phase: "invalidate"; afterUser: string | null }
    | {
        phase: "tombstones";
        cursor: string | null;
        markerIndex: number;
        pageNumber: number;
      }
    | { phase: "cleanup" }
    | { phase: "reconciled" }
  );

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.strictObject({
  id: identifier,
  at: timestamp,
  cutoff: timestamp,
  exportId: identifier,
});
const pageSchema = z.strictObject({
  snapshotId: identifier,
  snapshotAt: timestamp,
  exportId: identifier,
  completeThrough: timestamp,
  pageNumber: z.number().int().min(0).max(999),
  markers: z
    .array(
      z.strictObject({
        userId: identifier,
        requestId: identifier,
        deletedAt: timestamp,
      }),
    )
    .max(10),
  nextCursor: identifier.nullable(),
});
const identity = { snapshotId: identifier, exportId: identifier };
const checkpointSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...identity,
    phase: z.literal("invalidate"),
    afterUser: identifier.nullable(),
  }),
  z.strictObject({
    ...identity,
    phase: z.literal("tombstones"),
    cursor: identifier.nullable(),
    markerIndex: z.number().int().min(0).max(10),
    pageNumber: z.number().int().min(0).max(999),
  }),
  z.strictObject({ ...identity, phase: z.literal("cleanup") }),
  z.strictObject({ ...identity, phase: z.literal("reconciled") }),
]);

/** Dirty-row predicates make replay converge; every directly selected set is at most100. */
const invalidations = [
  "DELETE FROM oauth_states WHERE rowid IN(SELECT rowid FROM oauth_states WHERE user_id=? LIMIT 100)",
  "DELETE FROM session WHERE rowid IN(SELECT rowid FROM session WHERE userId=? AND NOT EXISTS(SELECT 1 FROM oauth_states os WHERE os.user_id=session.userId AND os.session_id=session.id) LIMIT 100)",
  "UPDATE account SET accessToken=NULL,refreshToken=NULL,idToken=NULL,accessTokenExpiresAt=NULL,refreshTokenExpiresAt=NULL WHERE rowid IN(SELECT rowid FROM account WHERE userId=? AND (accessToken IS NOT NULL OR refreshToken IS NOT NULL OR idToken IS NOT NULL OR accessTokenExpiresAt IS NOT NULL OR refreshTokenExpiresAt IS NOT NULL) LIMIT 100)",
  "UPDATE connections SET state=CASE WHEN state='disconnected' THEN 'disconnected' ELSE 'needs_reconnect' END,scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=CASE WHEN generation<9007199254740991 THEN generation+1 ELSE generation END,credential_version=CASE WHEN credential_version<9007199254740991 THEN credential_version+1 ELSE credential_version END WHERE rowid IN(SELECT rowid FROM connections WHERE user_id=? AND (state='connected' OR credential_ciphertext IS NOT NULL OR credential_key_version IS NOT NULL OR scheduling_state!='paused' OR next_sync_at IS NOT NULL) LIMIT 100)",
  "UPDATE ai_settings SET encrypted_key=NULL,key_version=NULL,status='deleted',generation=CASE WHEN generation<9007199254740991 THEN generation+1 ELSE generation END WHERE rowid IN(SELECT rowid FROM ai_settings WHERE user_id=? AND (encrypted_key IS NOT NULL OR key_version IS NOT NULL OR status!='deleted') LIMIT 100)",
  "UPDATE processing_consents SET revoked_at=? WHERE rowid IN(SELECT rowid FROM processing_consents WHERE user_id=? AND revoked_at IS NULL LIMIT 100)",
  "UPDATE jobs SET status='canceled',lease_id=NULL,lease_expires_at=NULL,fence=CASE WHEN fence<9007199254740991 THEN fence+1 ELSE fence END,outcome_code='restore_reauthorization' WHERE rowid IN(SELECT rowid FROM jobs WHERE user_id=? AND (status NOT IN ('completed','terminal','canceled') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL) LIMIT 100)",
  "UPDATE sync_states SET stage='canceled' WHERE rowid IN(SELECT rowid FROM sync_states WHERE user_id=? AND stage!='canceled' LIMIT 100)",
  "UPDATE archive_settings SET enabled=0,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL,version=CASE WHEN version<2147483646 THEN version+1 ELSE version END WHERE rowid IN(SELECT rowid FROM archive_settings WHERE user_id=? AND enabled=1 LIMIT 100)",
] as const;

/** Internal nonserving recovery tool; a caller-supplied JSON flag never establishes trust. */
export function createRestoreSuppression(options: {
  db: D1Database;
  operator: RestoreOperator;
  snapshot: RestoreSnapshot;
}) {
  let capturedSnapshot: Readonly<RestoreSnapshot> | null = null;
  try {
    capturedSnapshot = Object.freeze(snapshotSchema.parse(options.snapshot));
  } catch {
    // Invalid descriptors fail closed when execution is attempted, without values.
  }
  return {
    async runOne(
      checkpoint?: RestoreCheckpoint,
    ): Promise<{ checkpoint: RestoreCheckpoint; servingAllowed: false }> {
      try {
        const snapshot = capturedSnapshot;
        if (!snapshot || snapshot.cutoff < snapshot.at)
          throw new Error("RESTORE_REFUSED");
        await options.operator.assertIsolated();
        const pinned = { snapshotId: snapshot.id, exportId: snapshot.exportId };
        const state = checkpointSchema.parse(
          checkpoint ?? { ...pinned, phase: "invalidate", afterUser: null },
        );
        if (
          state.snapshotId !== snapshot.id ||
          state.exportId !== snapshot.exportId
        )
          throw new Error("RESTORE_REFUSED");
        const cursor = state.phase === "tombstones" ? state.cursor : null;
        const page = pageSchema.parse(
          await options.operator.readReviewedPage(cursor),
        );
        if (
          page.snapshotId !== snapshot.id ||
          page.snapshotAt !== snapshot.at ||
          page.exportId !== snapshot.exportId ||
          page.completeThrough < snapshot.cutoff ||
          page.markers.some((marker) => marker.deletedAt > snapshot.cutoff) ||
          (page.nextCursor !== null && page.nextCursor === cursor) ||
          page.pageNumber !==
            (state.phase === "tombstones" ? state.pageNumber : 0)
        )
          throw new Error("RESTORE_REFUSED");
        // The trusted port may await journal I/O; verify actual isolation again before writes.
        await options.operator.assertIsolated();
        let next: RestoreCheckpoint = state;
        if (state.phase === "invalidate") {
          const user = await options.db
            .prepare(
              "SELECT id FROM user WHERE (? IS NULL OR id>?) ORDER BY id LIMIT 1",
            )
            .bind(state.afterUser, state.afterUser)
            .first<{ id: string }>();
          if (user) {
            const statements = invalidations.map((sql) => {
              const prepared = options.db.prepare(sql);
              return sql.startsWith("UPDATE processing_consents")
                ? prepared.bind(snapshot.cutoff, user.id)
                : prepared.bind(user.id);
            });
            const result = await options.db.batch(statements);
            next = {
              ...pinned,
              phase: "invalidate",
              afterUser: result.some((item) => item.meta.changes > 0)
                ? state.afterUser
                : user.id,
            };
          } else {
            // Anonymous pending login states have no tenant FK and must also be discarded.
            const removed = await options.db
              .prepare(
                "DELETE FROM verification WHERE rowid IN(SELECT rowid FROM verification LIMIT 100)",
              )
              .run();
            if (removed.meta.changes === 0)
              next = {
                ...pinned,
                phase: "tombstones",
                cursor: null,
                markerIndex: 0,
                pageNumber: 0,
              };
          }
        } else if (state.phase === "tombstones") {
          const marker = page.markers[state.markerIndex];
          if (state.markerIndex > page.markers.length)
            throw new Error("RESTORE_REFUSED");
          if (marker) {
            await options.db.batch([
              options.db
                .prepare(
                  "UPDATE profiles SET status='deleting',version=CASE WHEN version<2147483646 THEN version+1 ELSE version END,updated_at=? WHERE user_id=? AND status!='deleting'",
                )
                .bind(snapshot.cutoff, marker.userId),
              options.db
                .prepare(
                  "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) SELECT ?,'account','account',?,?,0,1 WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting') ON CONFLICT(user_id,scope,target_id) DO UPDATE SET request_id=excluded.request_id,deleted_at=excluded.deleted_at,stage=CASE WHEN excluded.deleted_at>lifecycle_deletions.deleted_at THEN 0 ELSE lifecycle_deletions.stage END,journal_ack=1 WHERE excluded.deleted_at>lifecycle_deletions.deleted_at OR (excluded.deleted_at=lifecycle_deletions.deleted_at AND excluded.request_id=lifecycle_deletions.request_id)",
                )
                .bind(
                  marker.userId,
                  marker.requestId,
                  marker.deletedAt,
                  marker.userId,
                ),
            ]);
            next = { ...state, markerIndex: state.markerIndex + 1 };
          } else if (page.nextCursor === null)
            next = { ...pinned, phase: "cleanup" };
          else {
            if (state.pageNumber >= 999) throw new Error("RESTORE_REFUSED");
            next = {
              ...state,
              cursor: page.nextCursor,
              pageNumber: state.pageNumber + 1,
              markerIndex: 0,
            };
          }
        } else if (state.phase === "cleanup") {
          const result = await createLifecycleCleanup(
            options.db,
            null,
          ).runOne();
          if (result.status === "awaiting_journal")
            throw new Error("RESTORE_REFUSED");
          if (
            result.status === "idle" &&
            (await options.db
              .prepare("SELECT 1 FROM profiles WHERE status='deleting' LIMIT 1")
              .first())
          )
            throw new Error("RESTORE_REFUSED");
          if (result.status === "idle")
            next = { ...pinned, phase: "reconciled" };
        }
        return { checkpoint: next, servingAllowed: false };
      } catch {
        // No SQL, private operator error, credential or journal marker enters diagnostics.
        throw new Error("RESTORE_REFUSED");
      }
    },
  };
}
