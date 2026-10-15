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
 * `source_unavailable` is transient (network, deadline, provider 429/5xx,
 * Gmail 403 rate limits) and stays retryable. `source_reauthorization_required`
 * is a rejected mailbox authorization (Gmail 401/auth 403, Outlook
 * AUTH_REQUIRED) that reconnecting the mailbox fixes; a retry does not.
 * `source_unreadable` is a provider answer neither a retry nor a reconnect can
 * change (message gone, admin policy, response over the cap or off-schema).
 */
export class ReviewSourceError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "source_unavailable"
      | "source_unreadable"
      | "source_reauthorization_required"
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
/** Gmail 403 reasons that are quota/rate limits: transient, not an authorization failure. */
const GMAIL_RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
]);
/** A Workspace admin policy blocks API access; reconnecting the mailbox cannot change it. */
const GMAIL_POLICY_REASONS = new Set(["domainPolicy"]);
const GMAIL_ERROR_BODY_LIMIT = 4096;
const gmailErrorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string().max(64) })).max(8),
  }),
});
/**
 * Reads at most 4 KiB of a Gmail 403 body and returns only the machine
 * `reason` values (zod strips everything else). Provider message text is never
 * returned, logged or thrown. `null` means the body could not be read in time
 * (transport trouble); an oversized or off-schema body has no usable reason.
 */
async function gmailForbiddenReasons(
  response: Response,
  assertWithinDeadline: () => void,
): Promise<string[] | null> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let reads = 0; reads < 64; reads++) {
      assertWithinDeadline();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > GMAIL_ERROR_BODY_LIMIT) return [];
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = gmailErrorSchema.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    return parsed.success
      ? parsed.data.error.errors.map((item) => item.reason)
      : [];
  } catch {
    return [];
  }
}
/** Gmail failure status → review-source code. 403 needs the bounded reason. */
async function gmailFailureCode(
  response: Response,
  assertWithinDeadline: () => void,
): Promise<ReviewSourceError["code"]> {
  if (response.status === 401) return "source_reauthorization_required";
  if (response.status === 403) {
    const reasons = await gmailForbiddenReasons(response, assertWithinDeadline);
    if (reasons === null) return "source_unavailable";
    if (reasons.some((reason) => GMAIL_RATE_LIMIT_REASONS.has(reason)))
      return "source_unavailable";
    if (reasons.some((reason) => GMAIL_POLICY_REASONS.has(reason)))
      return "source_unreadable";
    return "source_reauthorization_required";
  }
  return [404, 410].includes(response.status)
    ? "source_unreadable"
    : "source_unavailable";
}
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
    const code = response.ok
      ? "source_unavailable"
      : await gmailFailureCode(response, assertWithinDeadline);
    await response.body?.cancel().catch(() => {});
    throw new ReviewSourceError(code);
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
 * Outlook metadata failure → review-source code. Graph 401/403
 * (`AUTH_REQUIRED`) needs a mailbox reconnect. Graph 404 or a response that
 * fails the metadata schema/identity checks is permanently unreadable. Generic
 * transport `UNAVAILABLE` (network, deadline, redirect, size) and
 * `RATE_LIMITED` stay transient because the transport does not distinguish them.
 */
function outlookFailureCode(cause: unknown): ReviewSourceError["code"] {
  if (cause instanceof DiscoveryError) {
    if (cause.code === "AUTH_REQUIRED")
      return "source_reauthorization_required";
    if (cause.code === "SOURCE_UNAVAILABLE") return "source_unreadable";
    return "source_unavailable";
  }
  return cause instanceof z.ZodError ||
    (cause instanceof Error && cause.message === "OUTLOOK_REVIEW_METADATA")
    ? "source_unreadable"
    : "source_unavailable";
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
        throw new ReviewSourceError(outlookFailureCode(cause));
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
