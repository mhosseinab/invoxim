import { connectionsResponseSchema } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { activeProfileSql } from "./pipeline/repository-guards";

interface ConnectionRow {
  id: string;
  kind: string;
  provider: string;
  display_address: string;
  state: string;
  generation: number;
  credential_version: number;
  credential_ciphertext: string | null;
  credential_key_version: number | null;
  scheduling_state: string;
  archiving_enabled: number;
}
/**
 * S11: the archive_settings probe is stable for a database handle, so it is
 * memoized instead of running on every `list` call.
 */
const archivingSqlByDb = new WeakMap<D1Database, Promise<string>>();
function archivingEnabledSql(db: D1Database) {
  let cached = archivingSqlByDb.get(db);
  if (!cached) {
    cached = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='archive_settings' LIMIT 1",
      )
      .first()
      .then((storageSchema) =>
        storageSchema
          ? "EXISTS(SELECT 1 FROM archive_settings a WHERE a.user_id=c.user_id AND a.enabled=1 AND a.connection_id=c.id AND a.connection_generation=c.generation)"
          : "0",
      );
    archivingSqlByDb.set(db, cached);
  }
  return cached;
}
/** Current tenant metadata only; viewing or unlinking a grant does not require a provider to be enabled. */
export function createConnectionsViewRepository(db: D1Database) {
  return {
    async list(context: TenantContext) {
      const archived = await archivingEnabledSql(db);
      const result = await db
        .prepare(
          `SELECT c.id,c.kind,c.provider,c.display_address,c.state,c.generation,c.credential_version,c.credential_ciphertext,c.credential_key_version,c.scheduling_state,${archived} AS archiving_enabled FROM connections c WHERE c.user_id=? AND ((c.kind='mailbox' AND c.provider IN('gmail','outlook')) OR (c.kind='storage' AND c.provider='google-drive')) AND ${activeProfileSql} ORDER BY CASE c.state WHEN 'disconnected' THEN 1 ELSE 0 END,c.id LIMIT 11`,
        )
        .bind(context.userId, context.userId)
        .all<ConnectionRow>();
      return connectionsResponseSchema.parse({
        connections: result.results.slice(0, 10).map((row) => {
          const configured =
            row.state === "connected" &&
            row.credential_ciphertext !== null &&
            row.credential_key_version !== null;
          const common = {
            id: row.id,
            kind: row.kind,
            provider: row.provider,
            address: row.display_address,
            state: row.state,
            generation: row.generation,
            credentialVersion: row.credential_version,
            configured,
          };
          return row.kind === "storage"
            ? {
                ...common,
                archivingEnabled: configured && row.archiving_enabled === 1,
              }
            : { ...common, schedulingState: row.scheduling_state };
        }),
        hasMore: result.results.length > 10,
      });
    },
  };
}
