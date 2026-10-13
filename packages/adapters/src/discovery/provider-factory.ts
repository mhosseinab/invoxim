import type { DiscoveryProviderFactory } from "@invoxim/core";
import { DiscoveryError, MailboxError } from "@invoxim/core";
import type { GmailConfiguration } from "../mailbox/configuration";
import { createGmailAuthorization } from "../mailbox/gmail";
import { createMailboxService } from "../mailbox/service";
import { CredentialError } from "../security/cipher";
import { createCredentialVault } from "../security/vault";
import { createGmailDiscovery } from "./gmail";
/** Receives the same invocation-guarded D1 handle as jobs and discovery. */
export function createGmailDiscoveryProviderFactory(
  db: D1Database,
  configuration: GmailConfiguration,
): DiscoveryProviderFactory {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createGmailAuthorization(configuration),
  );
  return {
    async open(context, input, signal) {
      let stage: "credential_read" | "credential_refresh" = "credential_read";
      try {
        if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
        const target = {
          kind: "connection" as const,
          id: input.connectionId,
          generation: input.generation,
        };
        let snapshot = await vault.read(context, target);
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        if (snapshot.secret.expiresAt <= Date.now() + 30000) {
          stage = "credential_refresh";
          if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
          await mailbox.refresh(context, input.connectionId, input.generation);
          snapshot = await vault.read(context, target);
        }
        if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt ||
          snapshot.secret.expiresAt <= Date.now() + 30000
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        return createGmailDiscovery(snapshot.secret.accessToken);
      } catch (cause) {
        console.warn("gmail_preparation_failed", {
          stage,
          code:
            cause instanceof DiscoveryError ||
            cause instanceof MailboxError ||
            cause instanceof CredentialError
              ? cause.code
              : "UNEXPECTED",
        });
        if (cause instanceof DiscoveryError) throw cause;
        if (
          cause instanceof MailboxError &&
          [
            "RECONNECT_REQUIRED",
            "ACCOUNT_MISMATCH",
            "MISSING_PERMISSION",
          ].includes(cause.code)
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        throw new DiscoveryError("UNAVAILABLE");
      }
    },
  };
}
