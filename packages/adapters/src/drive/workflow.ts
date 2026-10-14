import type { ArchiveAuthorizationPort, TenantContext } from "@invoxim/core";
import {
  ArchiveServiceError,
  DOCUMENT_LIMITS,
  OriginalReadError,
} from "@invoxim/core";
import type {
  ArchiveCredentialFences,
  ArchiveObjectLease,
  ArchiveUploadPlan,
} from "../../../core/src/archive/objects";
import { createArchiveWorkflow } from "../../../core/src/archive/workflow";
import type {
  ArchiveOriginalResult,
  ArchiveWorkflowPorts,
  ArchiveWorkflowResult,
} from "../../../core/src/archive/workflow-types";
import {
  MAX_ARCHIVE_ORIGINAL_BYTES,
  MAX_MULTIPART_ORIGINAL_BYTES,
} from "../../../core/src/archive/workflow-types";
import { createOriginalMailReader } from "../documents/original-mail";
import {
  ContentError,
  createGmailContentReader,
} from "../pipeline/gmail-content";
import { createOutlookContentReader } from "../pipeline/outlook-content";
import { sha256Hex } from "../security/helpers";
import type { CredentialCipher, ProviderCredentials } from "../security/types";
import { createCredentialVault } from "../security/vault";
import { createArchiveFolderStore } from "./folders";
import { createArchiveObjectStore } from "./objects";
import { createDriveCredentialRefresher } from "./refresh";
import { createDriveResumableTransport } from "./resumable";
import { createDriveResumableWorkflow } from "./resumable-workflow";
import { scopesInclude } from "./scopes";
import { createArchiveUploadSessionStore } from "./session-store";
import { createDriveArchiveTransport } from "./transport";
import { DriveArchiveError, type DriveHttpTransport } from "./types";

export interface DriveArchiveWorkflowOptions {
  db: D1Database;
  remainingStatements(): number;
  onClaim?(lease: ArchiveObjectLease): void;
  cipher: CredentialCipher;
  driveAuthorization(authorize: () => Promise<void>): ArchiveAuthorizationPort;
  refreshMailbox(
    context: TenantContext,
    connectionId: string,
    generation: number,
    provider: "gmail" | "outlook",
    authorize: () => Promise<void>,
  ): Promise<void>;
  driveHttp?: DriveHttpTransport;
  mailFetcher?: typeof fetch;
}
interface Connections {
  mail_provider: string;
  mail_subject: string;
  mail_version: number;
  mail_scopes: string;
  storage_subject: string;
  storage_version: number;
  storage_scopes: string;
}
function usable(
  value: ProviderCredentials | { key: string },
): ProviderCredentials & { accessToken: string; expiresAt: number } {
  if (
    !("accessToken" in value) ||
    typeof value.accessToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(value.accessToken) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !value.expiresAt ||
    value.expiresAt < 1
  )
    throw new ArchiveServiceError("RECONNECT_REQUIRED");
  return {
    ...value,
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
  };
}
function originalName(plan: ArchiveUploadPlan) {
  const extension = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "message/rfc822": "eml",
  }[plan.mimeType];
  return { ...plan, name: `receipt-${plan.fileId}.${extension}` };
}
/** Operator composition supplies approved adapters; tokens never reach core or durable plans. */
export function createDriveArchiveWorkflow(
  options: DriveArchiveWorkflowOptions,
) {
  async function run(
    context: TenantContext,
    objectId: string,
    signal: AbortSignal,
  ): Promise<ArchiveWorkflowResult> {
    const objects = createArchiveObjectStore(options.db);
    const vault = createCredentialVault(options.db, options.cipher);
    let fences: ArchiveCredentialFences | undefined;
    let mailbox:
      | {
          provider: "gmail" | "outlook";
          credentials: ReturnType<typeof usable>;
        }
      | undefined;
    let storage: ReturnType<typeof usable> | undefined;
    const ports: ArchiveWorkflowPorts = {
      reserve(requiredStatements) {
        const remaining = options.remainingStatements();
        if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 40)
          throw new ArchiveServiceError("INVALID_INPUT");
        // One fenced object-lease release and three queue settlement statements stay unspent.
        return remaining >= requiredStatements + 4;
      },
      objects: {
        ...objects,
        async claim(owner, id) {
          const claimed = await objects.claim(owner, id);
          if (claimed && options.onClaim) {
            try {
              options.onClaim(claimed.lease);
            } catch {
              if (!(await objects.release(owner, claimed.lease)))
                throw new ArchiveServiceError("CONFLICT");
              throw new ArchiveServiceError("UNAVAILABLE");
            }
          }
          return claimed;
        },
        authorized: (owner, lease) => objects.authorized(owner, lease, fences),
        savePlan: (owner, lease, plan) =>
          objects.savePlan(owner, lease, plan, fences),
        complete: (owner, lease) => objects.complete(owner, lease, fences),
      },
      folders: createArchiveFolderStore(options.db),
      workspaceMarker: async () => crypto.randomUUID(),
      async openRemote(owner, work, control) {
        const current = await options.db
          .prepare(
            `SELECT m.provider AS mail_provider,m.provider_subject AS mail_subject,m.credential_version AS mail_version,m.scopes AS mail_scopes,c.provider_subject AS storage_subject,c.credential_version AS storage_version,c.scopes AS storage_scopes FROM connections m JOIN connections c ON c.user_id=m.user_id WHERE m.user_id=? AND m.id=? AND m.kind='mailbox' AND m.state='connected' AND m.generation=? AND c.id=? AND c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.generation=? AND c.provider_subject=?`,
          )
          .bind(
            owner.userId,
            work.mailboxConnectionId,
            work.mailboxGeneration,
            work.storageConnectionId,
            work.storageGeneration,
            work.storageSubject,
          )
          .first<Connections>();
        if (!current || !["gmail", "outlook"].includes(current.mail_provider))
          throw new ArchiveServiceError("CONFLICT");
        const provider =
          current.mail_provider === "gmail" ? "gmail" : "outlook";
        if (
          !scopesInclude(
            current.mail_scopes,
            provider === "gmail"
              ? "https://www.googleapis.com/auth/gmail.readonly"
              : "https://graph.microsoft.com/Mail.Read",
          ) ||
          !scopesInclude(
            current.storage_scopes,
            "https://www.googleapis.com/auth/drive.file",
          )
        )
          throw new ArchiveServiceError("MISSING_PERMISSION");
        fences = {
          mailbox: {
            subject: current.mail_subject,
            credentialVersion: current.mail_version,
            scopes: current.mail_scopes,
          },
          storage: {
            subject: current.storage_subject,
            credentialVersion: current.storage_version,
            scopes: current.storage_scopes,
          },
        };
        await control.authorize();
        const mailSnapshot = await vault.read(
          owner,
          {
            kind: "connection",
            id: work.mailboxConnectionId,
            generation: work.mailboxGeneration,
          },
          current.mail_version,
        );
        const driveSnapshot = await vault.read(
          owner,
          {
            kind: "connection",
            id: work.storageConnectionId,
            generation: work.storageGeneration,
          },
          current.storage_version,
        );
        if (
          !mailSnapshot ||
          !driveSnapshot ||
          mailSnapshot.keyVersion > options.cipher.activeVersion ||
          driveSnapshot.keyVersion > options.cipher.activeVersion
        )
          throw new ArchiveServiceError("RECONNECT_REQUIRED");
        mailbox = { provider, credentials: usable(mailSnapshot.secret) };
        storage = usable(driveSnapshot.secret);
        await control.authorize();
        if (mailbox.credentials.expiresAt <= Date.now() + 30000) {
          await options.refreshMailbox(
            owner,
            work.mailboxConnectionId,
            work.mailboxGeneration,
            provider,
            control.authorize,
          );
          return { status: "deferred" };
        }
        if (storage.expiresAt <= Date.now() + 30000) {
          const authorization = options.driveAuthorization(control.authorize);
          await createDriveCredentialRefresher(
            options.db,
            options.cipher,
            authorization,
          ).refresh(owner, work.storageConnectionId, {
            generation: work.storageGeneration,
            credentialVersion: current.storage_version,
          });
          return { status: "deferred" };
        }
        const accessToken = storage.accessToken;
        const expiresAt = storage.expiresAt;
        const authorize = async () => {
          await control.authorize();
          if (expiresAt <= Date.now())
            throw new ArchiveServiceError("RECONNECT_REQUIRED");
        };
        const transport = createDriveArchiveTransport(
          options.driveHttp,
          10000,
          {
            signal: control.signal,
            authorize,
          },
        );
        const captured = fences;
        if (!captured?.mailbox || !captured.storage)
          throw new ArchiveServiceError("CONFLICT");
        const resumable = createDriveResumableWorkflow({
          context: owner,
          lease: work.lease,
          credentials: { mailbox: captured.mailbox, storage: captured.storage },
          cipher: options.cipher,
          sessions: createArchiveUploadSessionStore(options.db),
          metadata: transport,
          transport: createDriveResumableTransport(options.driveHttp, {
            authorize,
            signal: control.signal,
          }),
          accessToken,
        });
        return {
          generateFileId: () => transport.generateFileId(accessToken),
          ensureFolder: (plan) =>
            transport.ensureFolder(accessToken, {
              fileId: plan.fileId,
              workspaceMarker: plan.workspaceMarker,
              name: plan.name,
            }),
          inspectOriginal: (plan) =>
            transport.inspectOriginal(accessToken, originalName(plan)),
          uploadOriginal: (plan, bytes) =>
            plan.size > MAX_MULTIPART_ORIGINAL_BYTES
              ? resumable.uploadOriginal(originalName(plan), bytes)
              : transport.uploadOriginal(
                  accessToken,
                  originalName(plan),
                  bytes,
                ),
        };
      },
      originals: {
        async read(_owner, work, control): Promise<ArchiveOriginalResult> {
          if (!mailbox || !storage || !fences)
            throw new ArchiveServiceError("CONFLICT");
          const selected = mailbox;
          let refusal: ArchiveServiceError | undefined;
          const fetcher: typeof fetch = async (input, init) => {
            try {
              await control.authorize();
              if (control.signal.aborted || init?.signal?.aborted)
                throw new ArchiveServiceError("CONFLICT");
              if (selected.credentials.expiresAt <= Date.now())
                throw new ArchiveServiceError("RECONNECT_REQUIRED");
            } catch (error) {
              if (error instanceof ArchiveServiceError) refusal = error;
              throw error;
            }
            return (options.mailFetcher ?? fetch)(input, init);
          };
          try {
            const reader =
              selected.provider === "gmail"
                ? createGmailContentReader(selected.credentials.accessToken, {
                    fetcher,
                  })
                : createOutlookContentReader(selected.credentials.accessToken, {
                    fetcher,
                  });
            const content = await reader.load({
              connectionId: work.mailboxConnectionId,
              providerMessageId: work.providerMessageId,
              partKey: work.partKey,
              signal: control.signal,
              checkpoint: async () => true,
            });
            if (content.status !== "ready") return { status: "unsupported" };
            if (
              content.input.connectionId !== work.mailboxConnectionId ||
              content.input.providerMessageId !== work.providerMessageId ||
              content.input.root.partId !== work.partKey ||
              !content.input.root.bytes
            )
              throw new ArchiveServiceError("CONFLICT");
            const part = content.input.root;
            const sourceBytes = new Uint8Array(content.input.root.bytes);
            const mimeType =
              part.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
            const sourceIdentity = {
              providerMessageId: content.input.providerMessageId,
              partKey: part.partId,
              sha256: await sha256Hex(sourceBytes),
              mimeType,
              size: sourceBytes.length,
            };
            if (
              sourceIdentity.sha256 !== work.documentHash ||
              mimeType !== work.documentMime ||
              sourceBytes.length !== work.documentSize
            )
              throw new ArchiveServiceError("CONFLICT");
            const body =
              ["text/plain", "text/html"].includes(mimeType) &&
              !part.filename &&
              part.disposition !== "attachment";
            if (body) {
              const original = await createOriginalMailReader(
                {
                  provider: selected.provider,
                  accessToken: selected.credentials.accessToken,
                  policy: {
                    maxOriginalBytes: DOCUMENT_LIMITS.bytes,
                    deadlineMs: 10000,
                  },
                },
                { fetcher, archiveByteLimit: MAX_ARCHIVE_ORIGINAL_BYTES },
              ).read({
                providerMessageId: work.providerMessageId,
                signal: control.signal,
              });
              if (original.status !== "ready")
                return {
                  status:
                    original.status === "source_unavailable"
                      ? "source_unavailable"
                      : "unsupported",
                };
              if (original.providerMessageId !== work.providerMessageId)
                throw new ArchiveServiceError("CONFLICT");
              return {
                status: "ready",
                bytes: original.bytes,
                mimeType: "message/rfc822",
                sourceIdentity,
              };
            }
            if (
              !["application/pdf", "image/png", "image/jpeg"].includes(mimeType)
            )
              return { status: "unsupported" };
            return {
              status: "ready",
              bytes: sourceBytes,
              mimeType: mimeType as ArchiveUploadPlan["mimeType"],
              sourceIdentity,
            };
          } catch (error) {
            if (refusal) throw refusal;
            if (
              error instanceof ContentError &&
              error.code === "CONTENT_SOURCE_UNAVAILABLE"
            )
              return { status: "source_unavailable" };
            if (error instanceof ContentError) {
              if (error.code === "CONTENT_BYTE_LIMIT")
                return { status: "unsupported" };
              throw new ArchiveServiceError(
                error.code === "CONTENT_AUTH_CHANGED"
                  ? "CONFLICT"
                  : error.code === "CONTENT_AUTH_REQUIRED"
                    ? "RECONNECT_REQUIRED"
                    : "UNAVAILABLE",
              );
            }
            if (error instanceof OriginalReadError) {
              if (error.code === "RATE_LIMITED")
                throw new DriveArchiveError("rate_limited");
              throw new ArchiveServiceError(
                error.code === "CANCELED"
                  ? "CONFLICT"
                  : error.code === "AUTH_REQUIRED"
                    ? "RECONNECT_REQUIRED"
                    : "UNAVAILABLE",
              );
            }
            throw error;
          }
        },
      },
    };
    try {
      return await createArchiveWorkflow(ports).run(context, objectId, signal);
    } catch (error) {
      if (
        error instanceof ArchiveServiceError ||
        error instanceof DriveArchiveError
      )
        throw error;
      throw new ArchiveServiceError("UNAVAILABLE");
    }
  }
  return { run };
}
