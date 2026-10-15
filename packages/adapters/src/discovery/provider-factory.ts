import type {
  OnboardingStartDiscoveryFactory,
  TenantContext,
} from "@invoxim/core";
import { DiscoveryError, MailboxError } from "@invoxim/core";
import type { GmailConfiguration } from "../mailbox/configuration";
import { openMailboxCredential, RECONNECT_CODES } from "../mailbox/credentials";
import { createGmailAuthorization } from "../mailbox/gmail";
import { createMailboxService } from "../mailbox/service";
import { activeProfile } from "../pipeline/repository-guards";
import { CredentialError } from "../security/cipher";
import { createCredentialVault } from "../security/vault";
import { createGmailDiscovery } from "./gmail";
/** Receives the same invocation-guarded D1 handle as jobs and discovery. */
export function createGmailDiscoveryProviderFactory(
  db: D1Database,
  configuration: GmailConfiguration,
): OnboardingStartDiscoveryFactory {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createGmailAuthorization(configuration),
  );
  async function openSnapshot(
    context: TenantContext,
    input: { connectionId: string; generation: number },
    signal: AbortSignal,
    reviewed?: { credentialVersion: number; scopes: string },
  ) {
    let stage: "credential_read" | "credential_refresh" = "credential_read";
    try {
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      async function pin(version: number, scopes: string) {
        const current = await db
          .prepare(
            `SELECT credential_version FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider='gmail' AND state='connected' AND generation=? AND credential_version=? AND scopes=? AND ${activeProfile("connections")}`,
          )
          .bind(
            context.userId,
            input.connectionId,
            input.generation,
            version,
            scopes,
          )
          .first<{ credential_version: number }>();
        if (!current) throw new DiscoveryError("CONFLICT");
      }
      if (reviewed) {
        if (
          !Number.isSafeInteger(reviewed.credentialVersion) ||
          reviewed.credentialVersion < 0
        )
          throw new DiscoveryError("CONFLICT");
        await pin(reviewed.credentialVersion, reviewed.scopes);
      }
      let expectedVersion = reviewed?.credentialVersion;
      const target = {
        kind: "connection" as const,
        id: input.connectionId,
        generation: input.generation,
      };
      const credential = await openMailboxCredential({
        read: () => vault.read(context, target, expectedVersion),
        refresh: async () => {
          stage = "credential_refresh";
          if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
          const refreshed = await mailbox.refresh(
            context,
            input.connectionId,
            input.generation,
            expectedVersion,
          );
          if (
            reviewed &&
            (reviewed.credentialVersion >= Number.MAX_SAFE_INTEGER ||
              refreshed.credentialVersion !== reviewed.credentialVersion + 1)
          )
            throw new DiscoveryError("CONFLICT");
          expectedVersion = reviewed ? refreshed.credentialVersion : undefined;
        },
        settled: () => {
          if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
        },
        fail: () => new DiscoveryError("AUTH_REQUIRED"),
      });
      if (reviewed) await pin(credential.version, reviewed.scopes);
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      return {
        provider: createGmailDiscovery(credential.accessToken),
        credentialVersion: credential.version,
      };
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
      if (cause instanceof MailboxError && cause.code === "CONFLICT")
        throw new DiscoveryError("CONFLICT");
      if (cause instanceof MailboxError && RECONNECT_CODES.includes(cause.code))
        throw new DiscoveryError("AUTH_REQUIRED");
      throw new DiscoveryError("UNAVAILABLE");
    }
  }
  return {
    async open(context, input, signal) {
      return (await openSnapshot(context, input, signal)).provider;
    },
    async openForStart(context, input, signal) {
      return openSnapshot(context, input, signal, input);
    },
  };
}
