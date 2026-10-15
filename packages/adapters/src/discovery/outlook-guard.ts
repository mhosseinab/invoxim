import type { JobLease } from "@invoxim/core";
import { leaseLive } from "../pipeline/repository-guards";

/**
 * G2 / ext#12: the one Outlook discovery lease guard. Built on the shared
 * `leaseLive` predicate (held lease, live connection with credentials, live
 * background consent) plus the Outlook provider/grant and the reviewed
 * processing selection that Gmail's consent check enforces: the active AI
 * selection still matches the consent's revision, destination and disclosure
 * version, and the consent carries its reviewed configuration digest.
 *
 * Bind order is `leaseLive`'s, then the sync-state id when `syncState` is set.
 */
export function outlookLeaseGuard(
  lease: JobLease,
  now: number,
  options: {
    types: readonly ("mailbox-backfill" | "discover" | "sync")[];
    syncState?: boolean;
  },
) {
  const sql = leaseLive({
    extras: [
      `j.type IN (${options.types.map((type) => `'${type}'`).join(",")})`,
      ...(options.syncState ? ["j.sync_state_id=?"] : []),
      "c.provider='outlook'",
      "EXISTS(SELECT 1 FROM ai_settings a WHERE a.user_id=p.user_id AND a.status='active' AND a.revision=pc.ai_settings_revision AND a.provider_id=pc.inference_destination AND a.consent_version=pc.disclosure_version)",
      "pc.accepted_configuration_digest IS NOT NULL",
      "EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='https://graph.microsoft.com/Mail.Read')",
    ],
  });
  return {
    sql: `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=j.user_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id WHERE ${sql})`,
    values: [
      lease.context.userId,
      lease.jobId,
      lease.leaseId,
      lease.fence,
      now,
      lease.connectionId,
      lease.generation,
      lease.consentId,
      now,
      ...(options.syncState ? [lease.syncStateId] : []),
    ],
  };
}
