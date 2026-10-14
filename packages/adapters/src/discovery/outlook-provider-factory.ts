import type { TenantContext } from "@invoxim/core";
import { DiscoveryError, MailboxError } from "@invoxim/core";
import { z } from "zod";
import {
  createOutlookAuthorization,
  validateOutlookReadScopes,
} from "../mailbox/outlook";
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
      async function requireConnection() {
        active();
        const row = await db
          .prepare(
            "SELECT id,scopes FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider='outlook' AND state='connected' AND generation=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
          )
          .bind(
            context.userId,
            input.connectionId,
            input.generation,
            context.userId,
          )
          .first<{ id: string; scopes: string }>();
        active();
        if (!row) throw new DiscoveryError("AUTH_REQUIRED");
        let scopes: string[];
        try {
          scopes = z.array(z.string()).parse(JSON.parse(row.scopes));
        } catch {
          throw new DiscoveryError("AUTH_REQUIRED");
        }
        validateOutlookReadScopes(scopes.join(" "), true);
      }
      try {
        await requireConnection();
        const target = {
          kind: "connection" as const,
          id: input.connectionId,
          generation: input.generation,
        };
        let snapshot = await vault.read(context, target);
        active();
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        if (snapshot.secret.expiresAt <= Date.now() + 30000) {
          await mailbox.refresh(context, input.connectionId, input.generation);
          active();
          snapshot = await vault.read(context, target);
          active();
        }
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt ||
          snapshot.secret.expiresAt <= Date.now() + 30000
        )
          throw new DiscoveryError("AUTH_REQUIRED");
        await requireConnection();
        return createOutlookGraphDiscovery(snapshot.secret.accessToken, {
          pageSize: 1,
        });
      } catch (cause) {
        active();
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
