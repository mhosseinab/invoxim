import type { CredentialRevoker } from "@invoxim/core";
import type { CredentialCipher } from "../security/types";
/** Fixed Google revocation endpoint. Credentials never enter journal, logs, or response DTOs. */
export function createGoogleCredentialRevoker(
  db: D1Database,
  cipher: CredentialCipher,
  transport: typeof fetch = fetch,
): CredentialRevoker {
  return {
    async prepare(tenant, connectionId) {
      const rows = await db
        .prepare(
          `SELECT id,kind,provider,credential_ciphertext,generation,credential_version FROM connections WHERE user_id=? AND credential_ciphertext IS NOT NULL ${connectionId ? "AND id=?" : ""} AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') ORDER BY id LIMIT 11`,
        )
        .bind(
          tenant.userId,
          ...(connectionId ? [connectionId] : []),
          tenant.userId,
        )
        .all<{
          id: string;
          kind: string;
          provider: string;
          credential_ciphertext: string;
          generation: number;
          credential_version: number;
        }>();
      const tokens: {
        token: string;
        id: string;
        generation: number;
        version: number;
      }[] = [];
      let unavailable = rows.results.length > 10;
      for (const row of rows.results.slice(0, 10)) {
        if (!["gmail", "google-drive"].includes(row.provider)) {
          unavailable = true;
          continue;
        }
        try {
          const credentials = await cipher.open(
            tenant,
            {
              entityId: row.id,
              purpose:
                row.kind === "mailbox"
                  ? "mailbox-credentials"
                  : "storage-credentials",
            },
            row.credential_ciphertext,
          );
          const token = credentials.refreshToken ?? credentials.accessToken;
          if (token)
            tokens.push({
              token,
              id: row.id,
              generation: row.generation,
              version: row.credential_version,
            });
          else unavailable = true;
        } catch {
          unavailable = true;
        }
      }
      return {
        async revoke() {
          let failed = unavailable;
          for (const captured of tokens) {
            try {
              const current = await db
                .prepare(
                  "SELECT id FROM connections WHERE user_id=? AND id=? AND state='disconnected' AND generation=? AND credential_version=? AND credential_ciphertext IS NULL",
                )
                .bind(
                  tenant.userId,
                  captured.id,
                  captured.generation + 1,
                  captured.version + 1,
                )
                .first();
              if (!current) {
                failed = true;
                continue;
              }
              const response = await transport(
                "https://oauth2.googleapis.com/revoke",
                {
                  method: "POST",
                  redirect: "error",
                  signal: AbortSignal.timeout(5000),
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({ token: captured.token }),
                },
              );
              await response.body?.cancel();
              if (response.status !== 200) failed = true;
            } catch {
              failed = true;
            }
          }
          tokens.length = 0;
          return failed
            ? "failed"
            : rows.results.length
              ? "accepted"
              : "not_attempted";
        },
      };
    },
  };
}
