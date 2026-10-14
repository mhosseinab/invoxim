import { correctionResultSchema } from "@invoxim/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { assertPrivateIdentity, identityFailure } from "./api";

type Attempt = {
  path: string;
  method: "PATCH" | "POST";
  body: unknown;
  key: string;
  workspaceToken: string;
};
export function useCorrectionMutation(
  onReload: () => void,
  expectedUserId: string,
  mutationToken: string,
) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const errorId = useId();
  useEffect(() => () => controller.current?.abort(), []);
  async function perform(attempt: Attempt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    setConflict(false);
    const request = new AbortController();
    controller.current = request;
    try {
      await assertPrivateIdentity(expectedUserId, request.signal);
      if (request.signal.aborted) return;
      const response = await fetch(attempt.path, {
        method: attempt.method,
        credentials: "same-origin",
        cache: "no-store",
        signal: request.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": attempt.key,
          "X-Workspace-Token": attempt.workspaceToken,
        },
        body: JSON.stringify(attempt.body),
      });
      if (request.signal.aborted) return;
      if (response.status === 409) {
        setRetry(null);
        setConflict(true);
        setMessage(
          "These changes were not saved because the record changed or an unresolved issue blocks this action. Your entries are still here. Reload the latest version before continuing.",
        );
      } else if (identityFailure(response.status)) {
        setRetry(null);
        onReload();
      } else if (response.status >= 500) {
        setRetry(attempt);
        setMessage(
          "The request result is unknown. Your entries are still here. Retry the same request or reload to check the current record.",
        );
      } else if (!response.ok) {
        setRetry(null);
        setMessage(
          "These changes could not be accepted. Check the entered fields and the remaining review questions.",
        );
      } else {
        const parsed = correctionResultSchema.safeParse(await response.json());
        if (request.signal.aborted) return;
        if (!parsed.success) {
          setRetry(attempt);
          setMessage(
            "The request result could not be verified. Retry the same request or reload to check the current record.",
          );
        } else {
          setRetry(null);
          onReload();
        }
      }
    } catch (error) {
      if (identityFailure(error)) {
        setRetry(null);
        onReload();
        return;
      }
      if (!request.signal.aborted) {
        setRetry(attempt);
        setMessage(
          "The request result is unknown. Retry the same request or reload to check the current record.",
        );
      }
    } finally {
      inFlight.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  function submit(path: string, method: Attempt["method"], body: unknown) {
    if (retry || conflict || busy || !mutationToken) return;
    void perform({
      path,
      method,
      body,
      key: crypto.randomUUID(),
      workspaceToken: mutationToken,
    });
  }
  function invalid() {
    setMessage(
      "Check the entered fields, currency precision and date. Amounts must fit the supported range.",
    );
  }
  return {
    submit,
    invalid,
    locked: busy || retry !== null || conflict,
    errorId: message ? errorId : undefined,
    notice: (
      <>
        {message && (
          <p id={errorId} role="alert">
            {message}
          </p>
        )}
        {retry && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void perform(retry)}
          >
            Retry the same request
          </button>
        )}
        {(retry || conflict) && (
          <button type="button" disabled={busy} onClick={onReload}>
            Reload latest version
          </button>
        )}
      </>
    ),
  };
}
export type CorrectionMutation = ReturnType<typeof useCorrectionMutation>;
