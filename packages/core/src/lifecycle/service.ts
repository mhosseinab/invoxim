import type {
  AccountDeleteRequest,
  DeleteDataRequest,
  DisconnectRequest,
} from "@invoxim/contracts";
import { LifecycleError } from "./export";
import type {
  CredentialRevoker,
  DeletionJournal,
  LifecycleRepository,
  LifecycleSession,
} from "./types";
export function createLifecycleService(
  repository: LifecycleRepository,
  journal: DeletionJournal | null,
  now: () => number = Date.now,
  revoker: CredentialRevoker | null = null,
) {
  function recent(session: LifecycleSession) {
    const age = now() - session.authenticatedAt;
    if (
      session.tenant.authority !== "session" ||
      !Number.isSafeInteger(age) ||
      age < 0 ||
      age > 3600000
    )
      throw new LifecycleError("INVALID_REQUEST");
  }
  function commandId(value: string) {
    if (!/^[A-Za-z0-9_-]{16,120}$/.test(value))
      throw new LifecycleError("INVALID_REQUEST");
    return value;
  }
  return {
    preview: repository.preview,
    async disconnect(
      session: LifecycleSession,
      id: string,
      request: DisconnectRequest,
      key: string,
    ) {
      recent(session);
      let prepared: Awaited<ReturnType<CredentialRevoker["prepare"]>> | null =
        null;
      try {
        prepared =
          (await (request.revokeProviderAccess
            ? revoker?.prepare(session.tenant, id)
            : null)) ?? null;
      } catch {
        /* Local removal must succeed independently. */
      }
      const result = await repository.disconnect(
        session,
        id,
        request,
        commandId(key),
      );
      let remoteRevocation: "not_attempted" | "accepted" | "failed" =
        "not_attempted";
      try {
        remoteRevocation = (await prepared?.revoke()) ?? "not_attempted";
      } catch {
        remoteRevocation = "failed";
      }
      return { ...result, remoteRevocation };
    },
    async deleteData(
      session: LifecycleSession,
      id: string,
      request: DeleteDataRequest,
      key: string,
    ) {
      recent(session);
      return repository.deleteData(session, id, request, commandId(key));
    },
    async deleteAccount(
      session: LifecycleSession,
      request: AccountDeleteRequest,
      key: string,
    ) {
      recent(session);
      const requestId = commandId(key);
      if (!journal) throw new LifecycleError("UNAVAILABLE");
      await repository.authorizeDeletion(session, request);
      let prepared: Awaited<ReturnType<CredentialRevoker["prepare"]>> | null =
        null;
      try {
        prepared =
          (await (request.revokeProviderAccess
            ? revoker?.prepare(session.tenant)
            : null)) ?? null;
      } catch {
        /* Access fences take precedence over remote revocation. */
      }
      const marker = await repository.beginDeletion(session, request, {
        userId: session.tenant.userId,
        deletedAt: now(),
        requestId,
      });
      let status: "cleanup_pending" | "awaiting_journal" = "awaiting_journal";
      try {
        await journal.append(marker);
        await repository.acknowledgeJournal(marker);
        status = "cleanup_pending";
      } catch {
        /* Access remains disabled; scheduled recovery retries the durable intent. */
      }
      let remoteRevocation: "not_attempted" | "accepted" | "failed" =
        "not_attempted";
      try {
        remoteRevocation = (await prepared?.revoke()) ?? "not_attempted";
      } catch {
        remoteRevocation = "failed";
      }
      return {
        status,
        accessDisabled: true as const,
        driveFilesDeleted: false as const,
        remoteRevocation,
      };
    },
  };
}
