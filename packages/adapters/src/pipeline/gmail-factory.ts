import type { GmailConfiguration } from "../mailbox/configuration";
import { createGmailAuthorization } from "../mailbox/gmail";
import { createMailboxService } from "../mailbox/service";
import { createCredentialVault } from "../security/vault";
import { ContentError, createGmailContentReader } from "./gmail-content";
import type { TransientContentFactory } from "./types";

/** Credentials remain inside the concrete adapter; core receives no access token. */
export function createGmailContentFactory(
  db: D1Database,
  configuration: GmailConfiguration,
): TransientContentFactory {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createGmailAuthorization(configuration),
  );
  return {
    async open(lease, control) {
      if (control.signal.aborted || !(await control.checkpoint()))
        throw new ContentError("CONTENT_AUTH_CHANGED");
      const target = {
        kind: "connection" as const,
        id: lease.connectionId,
        generation: lease.generation,
      };
      let credentials = await vault.read(lease.context, target);
      if (
        !credentials ||
        !("accessToken" in credentials.secret) ||
        !credentials.secret.accessToken ||
        !credentials.secret.expiresAt
      )
        throw new ContentError("CONTENT_AUTH_REQUIRED");
      if (credentials.secret.expiresAt <= Date.now() + 30000) {
        await mailbox.refresh(
          lease.context,
          lease.connectionId,
          lease.generation,
        );
        credentials = await vault.read(lease.context, target);
      }
      if (control.signal.aborted || !(await control.checkpoint()))
        throw new ContentError("CONTENT_AUTH_CHANGED");
      if (
        !credentials ||
        !("accessToken" in credentials.secret) ||
        !credentials.secret.accessToken ||
        !credentials.secret.expiresAt ||
        credentials.secret.expiresAt <= Date.now() + 30000
      )
        throw new ContentError("CONTENT_AUTH_REQUIRED");
      return createGmailContentReader(credentials.secret.accessToken);
    },
  };
}
