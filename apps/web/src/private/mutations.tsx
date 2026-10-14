import { correctionResultSchema } from "@invoxim/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  assertPrivateIdentity,
  identityFailure,
  RequestError,
  type RequestJsonInit,
  requestJson,
} from "./api";

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

type MutationMessages = {
  conflict: string;
  retryable: string;
  rejected: string;
  unavailable?: string;
  invalid: string;
};

type MutationActions = {
  retry: string | null;
  reload: string;
};

type MutationOptions<T> = {
  schema: JsonSchema<T>;
  expectedUserId: string;
  getWorkspaceToken: () => string;
  onSuccess: () => void;
  messages: MutationMessages;
  actions: MutationActions;
  confirmAfter?: boolean;
};

type Attempt = {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body: unknown;
  key: string;
  workspaceToken: string;
};

type MutationState =
  | "idle"
  | "conflict"
  | "unavailable"
  | "retryable"
  | "rejected";

export function useRetryableMutation<T>(options: MutationOptions<T>) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<MutationState>("idle");
  const [retryAttempt, setRetryAttempt] = useState<Attempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const errorId = useId();
  useEffect(() => () => controller.current?.abort(), []);

  async function perform(attempt: Attempt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    setState("idle");
    setRetryAttempt(null);
    const request = new AbortController();
    controller.current = request;
    try {
      await assertPrivateIdentity(options.expectedUserId, request.signal);
      if (request.signal.aborted) return;
      await requestJson(attempt.path, options.schema, {
        signal: request.signal,
        method: attempt.method,
        body: attempt.body,
        idempotencyKey: attempt.key,
        workspaceToken: attempt.workspaceToken,
      } satisfies RequestJsonInit);
      if (options.confirmAfter)
        await assertPrivateIdentity(options.expectedUserId, request.signal);
      if (request.signal.aborted) return;
      options.onSuccess();
    } catch (error) {
      if (request.signal.aborted) return;
      if (identityFailure(error)) {
        options.onSuccess();
        return;
      }
      const status = error instanceof RequestError ? error.status : 0;
      if (status === 409) {
        setState("conflict");
        setMessage(options.messages.conflict);
      } else if (status === 503 && options.messages.unavailable) {
        setState("unavailable");
        setMessage(options.messages.unavailable);
      } else if (status >= 500 || status === 0) {
        setState("retryable");
        setRetryAttempt(attempt);
        setMessage(options.messages.retryable);
      } else {
        setState("rejected");
        setMessage(options.messages.rejected);
      }
    } finally {
      inFlight.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  const locked =
    busy ||
    state === "conflict" ||
    state === "unavailable" ||
    state === "retryable";

  function submit(path: string, method: Attempt["method"], body: unknown) {
    if (locked || !options.getWorkspaceToken()) return;
    void perform({
      path,
      method,
      body,
      key: crypto.randomUUID(),
      workspaceToken: options.getWorkspaceToken(),
    });
  }

  function invalid(customMessage?: string) {
    setMessage(customMessage ?? options.messages.invalid);
  }
  const notice: ReactNode = (
    <>
      {message && (
        <p id={errorId} role="alert">
          {message}
        </p>
      )}
      {state === "retryable" && retryAttempt && options.actions.retry && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(retryAttempt)}
        >
          {options.actions.retry}
        </button>
      )}
      {(state === "retryable" ||
        state === "conflict" ||
        state === "unavailable") && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setState("idle");
            setMessage("");
            options.onSuccess();
          }}
        >
          {options.actions.reload}
        </button>
      )}
    </>
  );

  return {
    submit,
    invalid,
    busy,
    locked,
    errorId: message ? errorId : undefined,
    notice,
  };
}

export function useCorrectionMutation(
  onReload: () => void,
  expectedUserId: string,
  mutationToken: string,
) {
  return useRetryableMutation({
    schema: correctionResultSchema,
    expectedUserId,
    getWorkspaceToken: () => mutationToken,
    onSuccess: onReload,
    messages: {
      conflict:
        "These changes were not saved because the record changed or an unresolved issue blocks this action. Your entries are still here. Reload the latest version before continuing.",
      retryable:
        "The request result is unknown. Your entries are still here. Retry the same request or reload to check the current record.",
      rejected:
        "These changes could not be accepted. Check the entered fields and the remaining review questions.",
      invalid:
        "Check the entered fields, currency precision and date. Amounts must fit the supported range.",
    },
    actions: {
      retry: "Retry the same request",
      reload: "Reload latest version",
    },
  });
}
export type CorrectionMutation = ReturnType<typeof useCorrectionMutation>;
