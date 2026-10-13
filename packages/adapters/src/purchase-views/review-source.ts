import { reviewSourceSchema } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { z } from "zod";
import type { GmailConfiguration } from "../mailbox/configuration";
import { createGmailAuthorization } from "../mailbox/gmail";
import { createMailboxService } from "../mailbox/service";
import { createCredentialVault } from "../security/vault";

export class ReviewSourceError extends Error {
  constructor(
    public readonly code: "not_found" | "source_unavailable" | "source_changed",
  ) {
    super(code);
  }
}
interface Source {
  connectionId: string;
  generation: number;
  providerMessageId: string;
  mailboxAddress: string;
  receivedAt: number;
  consentId: string;
}
const headersSchema = z.object({
  id: z.string(),
  payload: z.object({
    headers: z
      .array(
        z.object({ name: z.string().max(100), value: z.string().max(998) }),
      )
      .max(20),
  }),
});

/** Only requested headers are fetched. Header text never enters persistence. */
export async function loadGmailReviewHeaders(
  messageId: string,
  accessToken: string,
  mailboxAddress: string,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(messageId))
    throw new ReviewSourceError("source_unavailable");
  const signal = AbortSignal.timeout(10000);
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set("format", "metadata");
  for (const header of ["Subject", "From", "Message-ID"])
    url.searchParams.append("metadataHeaders", header);
  url.searchParams.set("fields", "id,payload(headers)");
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual",
    signal,
  });
  if (!response.ok || !response.body)
    throw new ReviewSourceError("source_unavailable");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) throw new ReviewSourceError("source_unavailable");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result = headersSchema.safeParse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (!result.success || result.data.id !== messageId)
    throw new ReviewSourceError("source_unavailable");
  function header(name: string) {
    const rows = result.success
      ? result.data.payload.headers.filter(
          (item) => item.name.toLowerCase() === name,
        )
      : [];
    return rows.length === 1 ? (rows[0]?.value ?? null) : null;
  }
  const message = header("message-id");
  // RFC822 search accepts an identifier; reject whitespace/search syntax rather than interpolating arbitrary mail text.
  const identifier = message?.match(
    /^<?([a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+)>?$/,
  )?.[1];
  return {
    subject: header("subject"),
    sender: header("from"),
    originalUrl: identifier
      ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailboxAddress)}#search/${encodeURIComponent(`rfc822msgid:${identifier}`)}`
      : null,
  };
}
export function createReviewSourceReader(
  db: D1Database,
  configuration: GmailConfiguration,
  fetcher: typeof fetch = fetch,
) {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    createGmailAuthorization(configuration),
  );
  async function source(tenant: TenantContext, id: string) {
    return db
      .prepare(
        "SELECT c.id AS connectionId,c.generation,s.provider_message_id AS providerMessageId,c.display_address AS mailboxAddress,s.received_at AS receivedAt,pc.id AS consentId FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id AND pc.revoked_at IS NULL AND pc.background_authorized=1 WHERE r.user_id=? AND r.id=? AND r.status='open' AND c.provider='gmail' AND c.state='connected' AND s.available=1 AND s.generation=c.generation AND EXISTS(SELECT 1 FROM profiles WHERE user_id=r.user_id AND status='active') ORDER BY pc.accepted_at DESC,pc.id LIMIT 1",
      )
      .bind(tenant.userId, id)
      .first<Source>();
  }
  return {
    async read(tenant: TenantContext, id: string) {
      const initial = await source(tenant, id);
      if (!initial) throw new ReviewSourceError("not_found");
      const target = {
        kind: "connection" as const,
        id: initial.connectionId,
        generation: initial.generation,
      };
      let credentials = await vault.read(tenant, target);
      if (
        credentials &&
        "expiresAt" in credentials.secret &&
        (credentials.secret.expiresAt ?? 0) <= Date.now() + 30000
      ) {
        await mailbox.refresh(tenant, initial.connectionId, initial.generation);
        credentials = await vault.read(tenant, target);
      }
      if (
        !credentials ||
        !("accessToken" in credentials.secret) ||
        !credentials.secret.accessToken ||
        (credentials.secret.expiresAt ?? 0) <= Date.now() + 30000
      )
        throw new ReviewSourceError("source_unavailable");
      const before = await source(tenant, id);
      if (JSON.stringify(before) !== JSON.stringify(initial))
        throw new ReviewSourceError("source_changed");
      const headers = await loadGmailReviewHeaders(
        initial.providerMessageId,
        credentials.secret.accessToken,
        initial.mailboxAddress,
        fetcher,
      );
      const after = await source(tenant, id);
      const latestCredentials = await vault.read(
        tenant,
        target,
        credentials.version,
      );
      if (
        !latestCredentials ||
        latestCredentials.version !== credentials.version
      )
        throw new ReviewSourceError("source_changed");
      if (JSON.stringify(after) !== JSON.stringify(initial))
        throw new ReviewSourceError("source_changed");
      return reviewSourceSchema.parse({
        mailboxAddress: initial.mailboxAddress,
        receivedAt: initial.receivedAt,
        ...headers,
      });
    },
  };
}
