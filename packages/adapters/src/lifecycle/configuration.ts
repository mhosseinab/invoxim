import type { AuthBindings } from "../auth/configuration";
import { createCredentialCipher } from "../security/cipher";
import { createDeletionJournal } from "./journal";
import { createGoogleCredentialRevoker } from "./revocation";
export interface LifecycleBindings extends AuthBindings {
  LIFECYCLE_ENABLED?: string;
  DELETION_JOURNAL?: Fetcher;
  DELETION_JOURNAL_SECRET?: string;
  LIFECYCLE_GOOGLE_REVOCATION_ENABLED?: string;
  CREDENTIAL_KEYRING?: string;
}
export function lifecycleDependencies(
  db: D1Database,
  bindings: LifecycleBindings,
) {
  const journal = createDeletionJournal(
    bindings.DELETION_JOURNAL,
    bindings.DELETION_JOURNAL_SECRET,
  );
  let revoker: ReturnType<typeof createGoogleCredentialRevoker> | null = null;
  if (bindings.LIFECYCLE_GOOGLE_REVOCATION_ENABLED === "true") {
    try {
      revoker = createGoogleCredentialRevoker(
        db,
        createCredentialCipher(
          JSON.parse(bindings.CREDENTIAL_KEYRING ?? "null"),
        ),
      );
    } catch {
      /* Revocation unavailable must never obstruct local fencing. */
    }
  }
  return { journal, revoker };
}
