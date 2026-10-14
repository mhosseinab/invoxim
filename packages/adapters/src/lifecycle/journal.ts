import { hasControlCharacters } from "@invoxim/contracts";
import type { DeletionJournal, DeletionMarker } from "@invoxim/core";
import { LifecycleError } from "@invoxim/core";
import { sha256Hex } from "../hash";
/** Operator-managed independently durable service; this application never provisions it. */
export function createDeletionJournal(
  binding: Fetcher | undefined,
  secret: string | undefined,
): DeletionJournal | null {
  if (
    !binding ||
    !secret ||
    secret.length < 32 ||
    secret.length > 1024 ||
    hasControlCharacters(secret)
  )
    return null;
  return {
    async append(marker: DeletionMarker) {
      const signal = AbortSignal.timeout(5000);
      const identity = JSON.stringify([
        marker.userId,
        marker.requestId,
        marker.deletedAt,
      ]);
      const requestKey = await sha256Hex(identity);
      const response = await binding.fetch(
        "https://deletion-journal.invalid/v1/deletions",
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
            "Idempotency-Key": requestKey,
          },
          body: JSON.stringify({ schemaVersion: 1, ...marker }),
        },
      );
      // 204 means independently durable acceptance under the operator's reviewed service contract.
      await response.body?.cancel();
      if (response.status !== 204) throw new LifecycleError("UNAVAILABLE");
    },
  };
}
