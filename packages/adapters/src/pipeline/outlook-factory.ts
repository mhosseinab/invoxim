import { MailboxError } from "@invoxim/core";
import { z } from "zod";
import {
  createOutlookAuthorization,
  validateOutlookReadScopes,
} from "../mailbox/outlook";
import type { OutlookConfiguration } from "../mailbox/outlook-configuration";
import { createMailboxService } from "../mailbox/service";
import { createCredentialVault } from "../security/vault";
import { ContentError } from "./gmail-content";
import { createOutlookContentReader } from "./outlook-content";
import type { TransientContentFactory } from "./types";

/** Credentials stay in the adapter; lease/checkpoint authority comes from the job runner. */
export function createOutlookContentFactory(
  db: D1Database,
  configuration: OutlookConfiguration,
): TransientContentFactory {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createOutlookAuthorization(configuration),
  );
  return {
    async open(lease, control) {
      async function active() {
        if (
          control.signal.aborted ||
          !(await control.checkpoint()) ||
          control.signal.aborted
        )
          throw new ContentError("CONTENT_AUTH_CHANGED");
      }
      async function requireConnection() {
        const row = await db
          .prepare(
            "SELECT id,scopes FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider='outlook' AND state='connected' AND generation=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
          )
          .bind(
            lease.context.userId,
            lease.connectionId,
            lease.generation,
            lease.context.userId,
          )
          .first<{ id: string; scopes: string }>();
        if (!row) throw new ContentError("CONTENT_AUTH_REQUIRED");
        let scopes: string[];
        try {
          scopes = z.array(z.string()).parse(JSON.parse(row.scopes));
        } catch {
          throw new ContentError("CONTENT_AUTH_REQUIRED");
        }
        validateOutlookReadScopes(scopes.join(" "), true);
      }
      try {
        await active();
        await requireConnection();
        const target = {
          kind: "connection" as const,
          id: lease.connectionId,
          generation: lease.generation,
        };
        let snapshot = await vault.read(lease.context, target);
        if (control.signal.aborted)
          throw new ContentError("CONTENT_AUTH_CHANGED");
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt
        )
          throw new ContentError("CONTENT_AUTH_REQUIRED");
        if (snapshot.secret.expiresAt <= Date.now() + 30000) {
          await mailbox.refresh(
            lease.context,
            lease.connectionId,
            lease.generation,
          );
          await active();
          snapshot = await vault.read(lease.context, target);
          await active();
          await requireConnection();
        }
        if (
          !snapshot ||
          !("accessToken" in snapshot.secret) ||
          !snapshot.secret.accessToken ||
          !snapshot.secret.expiresAt ||
          snapshot.secret.expiresAt <= Date.now() + 30000
        )
          throw new ContentError("CONTENT_AUTH_REQUIRED");
        if (control.signal.aborted)
          throw new ContentError("CONTENT_AUTH_CHANGED");
        return createOutlookContentReader(snapshot.secret.accessToken);
      } catch (cause) {
        if (control.signal.aborted)
          throw new ContentError("CONTENT_AUTH_CHANGED");
        if (cause instanceof ContentError) throw cause;
        if (
          cause instanceof MailboxError &&
          [
            "RECONNECT_REQUIRED",
            "ACCOUNT_MISMATCH",
            "MISSING_PERMISSION",
          ].includes(cause.code)
        )
          throw new ContentError("CONTENT_AUTH_REQUIRED");
        throw new ContentError("CONTENT_UNAVAILABLE");
      }
    },
  };
}
