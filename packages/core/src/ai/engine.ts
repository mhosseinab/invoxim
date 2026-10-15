import { sha256Hex } from "../hash";
import type { TenantContext } from "../tenant-context";
import type {
  AiAttemptIdentity,
  AiCheckpoint,
  AiResponse,
  AiRunIdentity,
  AiTextPart,
  AiUsageStore,
  ApprovedAiConfig,
  InvoiceExtractor,
  PersistableAiResult,
} from "./types";
import { validateExtraction, validateModelExtraction } from "./validation";

/**
 * One reserve → authorize → call → settle path (K3, ext#21).
 * Classification and extraction both settle through here so usage,
 * over-budget detection and rate-limit cooldown stay identical.
 */
export type ReservedAttemptResult =
  | {
      readonly status: "needs-review";
      readonly reason: "budget" | "in-progress" | "settings-changed" | "outage";
    }
  | {
      readonly status: "settled";
      readonly response: AiResponse;
      readonly known: boolean;
    };

export async function settleReservedAttempt(
  store: Pick<AiUsageStore, "reserve" | "authorize" | "settle">,
  attempt: AiAttemptIdentity,
  call: () => Promise<AiResponse>,
): Promise<ReservedAttemptResult> {
  const reservation = await store.reserve(attempt);
  if (reservation !== "reserved")
    return {
      status: "needs-review",
      reason: reservation === "budget" ? "budget" : "in-progress",
    };
  if (!(await store.authorize(attempt)))
    return { status: "needs-review", reason: "settings-changed" };
  let response: AiResponse;
  try {
    response = await call();
  } catch {
    await store.settle(attempt, { state: "uncertain", usage: null });
    return { status: "needs-review", reason: "outage" };
  }
  const usage = response.usage;
  const validUsage =
    usage !== null &&
    [usage.input, usage.output, usage.other].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
  const exceeded =
    validUsage &&
    BigInt(usage.input) + BigInt(usage.output) + BigInt(usage.other) >
      BigInt(attempt.config.reservationUnits);
  const known = validUsage && usage.source === "reported" && !exceeded;
  await store.settle(attempt, {
    state: known ? "known" : "uncertain",
    usage: validUsage ? usage : null,
    // A provider-requested floor (rate limit, or a classifier's rejected
    // operator credential) becomes the shared durable cooldown.
    ...(response.status === "failed" &&
    (response.reason === "rate-limit" || response.reason === "invalid-key") &&
    response.retryAfterMs !== undefined &&
    Number.isSafeInteger(response.retryAfterMs) &&
    response.retryAfterMs >= 0
      ? { retryAfterMs: response.retryAfterMs }
      : {}),
  });
  if (exceeded) return { status: "needs-review", reason: "budget" };
  return { status: "settled", response, known };
}

export function verifyFinancialDocumentResult(
  result: PersistableAiResult,
): PersistableAiResult {
  return result.status === "accepted" &&
    !(result.documentType === "non-purchase" && result.records.length === 0) &&
    (!["invoice", "receipt", "credit-note", "refund"].includes(
      result.documentType,
    ) ||
      (result.documentType === "refund" &&
        result.records.some((record) => record.refundEvidence !== "completed")))
    ? { status: "needs-review", reason: "semantics" }
    : result;
}

export function createInferenceEngine(dependencies: {
  extractor: InvoiceExtractor;
  store: AiUsageStore;
  financialDocumentsOnly?: boolean;
}) {
  const { extractor, store } = dependencies;
  const verifyDocument = (result: PersistableAiResult) =>
    dependencies.financialDocumentsOnly
      ? verifyFinancialDocumentResult(result)
      : result;
  return {
    async extract(
      tenant: TenantContext,
      identity: AiRunIdentity,
      parts: readonly AiTextPart[],
      approved: ApprovedAiConfig,
      signal?: AbortSignal,
    ): Promise<PersistableAiResult> {
      const config = Object.freeze({ ...approved });
      const bounded = [
        config.maxInputBytes,
        config.maxOutputBytes,
        config.maxOutputTokens,
        config.reservationUnits,
        config.settingsRevision,
      ];
      if (
        bounded.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
        config.maxInputBytes > 96000 ||
        config.maxOutputBytes > 65536 ||
        config.maxOutputTokens > 16000 ||
        ![1, 2].includes(config.maxAttempts) ||
        parts.length === 0 ||
        parts.length > 64 ||
        new Set(parts.map((part) => part.id)).size !== parts.length ||
        parts.some(
          (part) =>
            !part.id ||
            part.id.length > 100 ||
            part.text.length > config.maxInputBytes ||
            !part.text.trim(),
        )
      )
        return { status: "needs-review", reason: "input-limit" };
      const snapshot = parts.map((part) => Object.freeze({ ...part }));
      if (
        snapshot.reduce(
          (sum, part) => sum + new TextEncoder().encode(part.text).length,
          0,
        ) > config.maxInputBytes
      )
        return { status: "needs-review", reason: "input-limit" };
      const checkpoint = {
        tenant,
        identity: Object.freeze({ ...identity }),
        config,
      };
      const prefix = await aiRunIdentityKey(checkpoint);
      let result: PersistableAiResult = {
        status: "needs-review",
        reason: "schema",
      };
      for (let number = 1; number <= config.maxAttempts; number++) {
        const state = await store.checkpoint(checkpoint);
        if (state.status === "completed") return verifyDocument(state.result);
        if (state.status !== "ready" || signal?.aborted)
          return { status: "needs-review", reason: "settings-changed" };
        const attempt = {
          ...checkpoint,
          attemptNumber: number,
          attemptId: `${prefix}:${number}`,
        };
        const reserved = await settleReservedAttempt(store, attempt, () =>
          extractor.extract(
            snapshot,
            config,
            { id: attempt.attemptId, repair: number > 1 },
            signal,
          ),
        );
        if (reserved.status === "needs-review") return reserved;
        const { response, known } = reserved;
        if (response.status === "failed")
          return { status: "needs-review", reason: response.reason };
        result =
          response.finish === "truncated"
            ? { status: "needs-review", reason: "incomplete" }
            : (snapshot.every((part) => part.interpretation === "model")
                ? validateModelExtraction
                : validateExtraction)(
                response.output,
                snapshot,
                config.maxOutputBytes,
              );
        if (
          result.status === "accepted" ||
          result.reason !== "schema" ||
          !known ||
          number === config.maxAttempts
        )
          break;
      }
      result = verifyDocument(result);
      if (!(await store.complete(checkpoint, result)))
        return { status: "needs-review", reason: "settings-changed" };
      return result;
    },
  };
}

/** Shared tenant/version/config identity for reservation and cached completion. */
export async function aiRunIdentityKey(
  checkpoint: AiCheckpoint,
): Promise<string> {
  const { tenant, identity, config } = checkpoint;
  return sha256Hex(
    JSON.stringify([
      tenant.userId,
      identity.documentId,
      identity.contentHash,
      identity.extractionVersion,
      config.fingerprint,
    ]),
  );
}
