import type { TenantContext } from "@invoxim/core";
import { DiscoveryError, MailboxError } from "@invoxim/core";
import {
  openMailboxCredential,
  RECONNECT_CODES,
  requireOutlookConnection,
} from "../mailbox/credentials";
import { createOutlookAuthorization } from "../mailbox/outlook";
import type { OutlookConfiguration } from "../mailbox/outlook-configuration";
import { createMailboxService } from "../mailbox/service";
import { createCredentialVault } from "../security/vault";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import { createOutlookGraphDiscovery } from "./outlook";

export interface OutlookDiscoveryProviderFactory {
  open(
    context: TenantContext,
    input: { connectionId: string; generation: number },
    signal: AbortSignal,
  ): Promise<OutlookGraphDiscoveryPort>;
}

/** Concrete Graph port: no Gmail history anchor or provider fallback. */
export function createOutlookDiscoveryProviderFactory(
  db: D1Database,
  configuration: OutlookConfiguration,
): OutlookDiscoveryProviderFactory {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createOutlookAuthorization(configuration),
  );
  return {
    async open(context, input, signal) {
      const active = () => {
        if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      };
      const authRequired = () => new DiscoveryError("AUTH_REQUIRED");
      async function requireConnection() {
        active();
        await requireOutlookConnection(
          db,
          context,
          input,
          authRequired,
          active,
        );
      }
      try {
        await requireConnection();
        const target = {
          kind: "connection" as const,
          id: input.connectionId,
          generation: input.generation,
        };
        const credential = await openMailboxCredential({
          read: async () => {
            const snapshot = await vault.read(context, target);
            active();
            return snapshot;
          },
          refresh: async () => {
            await mailbox.refresh(
              context,
              input.connectionId,
              input.generation,
            );
            active();
          },
          fail: authRequired,
        });
        await requireConnection();
        return createOutlookGraphDiscovery(credential.accessToken, {
          pageSize: 1,
        });
      } catch (cause) {
        active();
        if (cause instanceof DiscoveryError) throw cause;
        if (
          cause instanceof MailboxError &&
          RECONNECT_CODES.includes(cause.code)
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        throw new DiscoveryError("UNAVAILABLE");
      }
    },
  };
}
