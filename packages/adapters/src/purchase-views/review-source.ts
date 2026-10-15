import { reviewSourceSchema } from "@invoxim/contracts";
import { DiscoveryError, type TenantContext } from "@invoxim/core";
import { z } from "zod";
import type { GmailConfiguration } from "../mailbox/configuration";
import { createGmailAuthorization } from "../mailbox/gmail";
import {
  createOutlookAuthorization,
  validateOutlookReadScopes,
} from "../mailbox/outlook";
import type { OutlookConfiguration } from "../mailbox/outlook-configuration";
import { createMailboxService } from "../mailbox/service";
import { createCredentialVault } from "../security/vault";
import { loadOutlookReviewMetadata } from "./outlook-review-metadata";

/**
 * `source_unavailable` is transient (network, deadline, provider 429/5xx) and
 * stays retryable. `source_unreadable` is a provider answer a retry cannot
 * change (message gone, access revoked, response over the cap or off-schema).
 */
export class ReviewSourceError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "source_unavailable"
      | "source_unreadable"
      | "source_changed",
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
  scopes: string;
}
const metadataPartSchema = z.object({
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  body: z
    .object({
      size: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .optional(),
  parts: z.array(z.unknown()).max(64).optional(),
});
const headersSchema = z.object({
  id: z.string(),
  payload: metadataPartSchema.extend({
    headers: z
      .array(
        z.object({ name: z.string().max(100), value: z.string().max(998) }),
      )
      .max(100),
  }),
});

/** Explicit inspection fetches headers and MIME metadata, never body or attachment bytes. */
export async function loadGmailReviewHeaders(
  messageId: string,
  accessToken: string,
  mailboxAddress: string,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(messageId))
    throw new ReviewSourceError("source_unreadable");
  const deadline = Date.now() + 10000;
  const signal = AbortSignal.timeout(10000);
  function assertWithinDeadline() {
    if (signal.aborted || Date.now() > deadline)
      throw new ReviewSourceError("source_unavailable");
  }
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set("format", "full");
  let partFields = "filename,mimeType,body(size)";
  for (let depth = 0; depth < 8; depth++)
    partFields = `filename,mimeType,body(size),parts(${partFields})`;
  url.searchParams.set("fields", `id,payload(headers,${partFields})`);
  let response: Response;
  try {
    assertWithinDeadline();
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal,
    });
  } catch {
    throw new ReviewSourceError("source_unavailable");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ReviewSourceError(
      [401, 403, 404, 410].includes(response.status)
        ? "source_unreadable"
        : "source_unavailable",
    );
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunkCount = 0;
  let emptyChunks = 0;
  try {
    for (;;) {
      assertWithinDeadline();
      const next = await reader.read();
      assertWithinDeadline();
      if (next.done) break;
      if (++chunkCount > 4096)
        throw new ReviewSourceError("source_unavailable");
      if (next.value.byteLength === 0) {
        if (++emptyChunks > 32)
          throw new ReviewSourceError("source_unavailable");
        continue;
      }
      size += next.value.byteLength;
      if (size > 65536) throw new ReviewSourceError("source_unreadable");
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof ReviewSourceError) throw cause;
    throw new ReviewSourceError("source_unavailable");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  assertWithinDeadline();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new ReviewSourceError("source_unreadable");
  }
  const result = headersSchema.safeParse(decoded);
  if (!result.success || result.data.id !== messageId)
    throw new ReviewSourceError("source_unreadable");
  function header(name: string) {
    const rows = result.success
      ? result.data.payload.headers.filter(
          (item) => item.name.toLowerCase() === name,
        )
      : [];
    return rows.length === 1 ? (rows[0]?.value ?? null) : null;
  }
  const attachments: {
    filename: string;
    mimeType: string;
    size: number | null;
  }[] = [];
  let partCount = 0;
  function collect(value: unknown, depth: number) {
    if (++partCount > 64 || depth > 8)
      throw new ReviewSourceError("source_unreadable");
    const checked = metadataPartSchema.safeParse(value);
    if (!checked.success) throw new ReviewSourceError("source_unreadable");
    const part = checked.data;
    if (part.filename)
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? null,
      });
    for (const child of part.parts ?? []) collect(child, depth + 1);
  }
  collect(result.data.payload, 0);
  const message = header("message-id");
  // RFC822 search accepts an identifier; reject whitespace/search syntax rather than interpolating arbitrary mail text.
  const identifier = message?.match(
    /^<?([a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+)>?$/,
  )?.[1];
  return {
    attachments,
    subject: header("subject"),
    sender: header("from"),
    originalUrl: identifier
      ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailboxAddress)}#search/${encodeURIComponent(`rfc822msgid:${identifier}`)}`
      : null,
  };
}
/**
 * Outlook metadata failures a retry cannot change: Graph 404/401/403, or a
 * response that fails the metadata schema/identity checks. Generic transport
 * `UNAVAILABLE` (network, deadline, redirect, size) and `RATE_LIMITED` stay
 * transient because the transport does not distinguish them.
 */
function permanentOutlookFailure(cause: unknown): boolean {
  if (cause instanceof DiscoveryError)
    return (
      cause.code === "SOURCE_UNAVAILABLE" || cause.code === "AUTH_REQUIRED"
    );
  return (
    cause instanceof z.ZodError ||
    (cause instanceof Error && cause.message === "OUTLOOK_REVIEW_METADATA")
  );
}
/** O3: the one open-review→document→source→connection join. Bind order: userId, reviewId. */
const reviewConnectionJoin =
  "review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id";
const openReview = "r.user_id=? AND r.id=? AND r.status='open'";
/**
 * O3: provider lookup from the review→document→source→connection join shared
 * with `source()`. Purchase-routes uses this instead of duplicating the join.
 */
export async function lookupReviewProvider(
  db: D1Database,
  userId: string,
  reviewId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT c.provider FROM ${reviewConnectionJoin} WHERE ${openReview} AND c.kind='mailbox'`,
    )
    .bind(userId, reviewId)
    .first<string>("provider");
  return row ?? null;
}
export function createReviewSourceReader(
  db: D1Database,
  configuration: GmailConfiguration | OutlookConfiguration,
  fetcher: typeof fetch = fetch,
) {
  const vault = createCredentialVault(db, configuration.cipher);
  const mailbox = createMailboxService(
    db,
    configuration,
    configuration.provider === "outlook"
      ? createOutlookAuthorization(configuration)
      : createGmailAuthorization(configuration),
  );
  async function source(tenant: TenantContext, id: string) {
    const row = await db
      .prepare(
        `SELECT c.id AS connectionId,c.generation,s.provider_message_id AS providerMessageId,c.display_address AS mailboxAddress,s.received_at AS receivedAt,pc.id AS consentId,c.scopes FROM ${reviewConnectionJoin} JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id AND pc.revoked_at IS NULL AND pc.background_authorized=1 WHERE ${openReview} AND c.provider=? AND c.kind='mailbox' AND c.state='connected' AND s.available=1 AND s.generation=c.generation AND EXISTS(SELECT 1 FROM profiles WHERE user_id=r.user_id AND status='active') ORDER BY pc.accepted_at DESC,pc.id LIMIT 1`,
      )
      .bind(tenant.userId, id, configuration.provider)
      .first<Source>();
    if (row && configuration.provider === "outlook") {
      try {
        validateOutlookReadScopes(
          z.array(z.string()).parse(JSON.parse(row.scopes)).join(" "),
          true,
        );
      } catch {
        return null;
      }
    }
    return row;
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
      const credentialVersion = credentials.version;
      async function assertCurrent() {
        const current = await source(tenant, id);
        const snapshot = await vault.read(tenant, target, credentialVersion);
        if (
          !snapshot ||
          snapshot.version !== credentialVersion ||
          JSON.stringify(current) !== JSON.stringify(initial)
        )
          throw new ReviewSourceError("source_changed");
      }
      let headers: Awaited<ReturnType<typeof loadGmailReviewHeaders>>;
      try {
        headers =
          configuration.provider === "outlook"
            ? await loadOutlookReviewMetadata(
                initial.providerMessageId,
                credentials.secret.accessToken,
                assertCurrent,
                fetcher,
              )
            : await loadGmailReviewHeaders(
                initial.providerMessageId,
                credentials.secret.accessToken,
                initial.mailboxAddress,
                fetcher,
              );
      } catch (cause) {
        if (cause instanceof ReviewSourceError) throw cause;
        throw new ReviewSourceError(
          permanentOutlookFailure(cause)
            ? "source_unreadable"
            : "source_unavailable",
        );
      }
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
