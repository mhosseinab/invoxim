import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import type {
  AiTextPart,
  DocumentInput,
  JobOutcome,
  PersistableAiResult,
  ReceiptCategory,
} from "@invoxim/core";
import {
  aiRunIdentityKey,
  createClassificationEngine,
  createInferenceEngine,
  EMAIL_CLASSIFICATION_VERSION,
  planLedgerIngestion,
  verifyFinancialDocumentResult,
} from "@invoxim/core";
import {
  createAiUsageStore,
  createClassificationUsageStore,
} from "../ai/budget";
import { AiSettingsError } from "../ai/settings";
import { ContentError } from "./gmail-content";
import type { PipelineDocumentMetadata } from "./repository";
import { PipelinePersistenceError } from "./repository-guards";
import type {
  PipelineControl,
  PipelineService,
  PipelineServiceOptions,
} from "./types";

const completed: JobOutcome = { kind: "completed" };
const stale: JobOutcome = { kind: "paused", code: "auth" };
const budgetPaused: JobOutcome = { kind: "paused", code: "budget" };
const handlerUnavailable: JobOutcome = {
  kind: "paused",
  code: "handler-unavailable",
};
const transientRetry: JobOutcome = { kind: "retry", code: "transient" };
/**
 * Statements that must remain after a paid attempt starts: known/uncertain
 * settlement, cache completion, durable continuation, and engine settlement
 * checks (P6). A fresh invocation can recover without another model charge.
 */
const PAID_ATTEMPT_STATEMENT_RESERVE = 23;
function usesDirectModelInput(parserVersion: string | undefined): boolean {
  return (
    parserVersion === "documents-direct-v1" ||
    parserVersion === "documents-direct-selected-v2" ||
    parserVersion?.startsWith("documents-direct-pdf-v2/") === true
  );
}
function byteLengths(input: DocumentInput): Map<string, number> {
  const result = new Map<string, number>();
  const pending = [input.root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    result.set(node.partId, node.bytes?.byteLength ?? 0);
    pending.push(...(node.children ?? []));
  }
  return result;
}
export function createPipelineService(
  db: D1Database,
  options: PipelineServiceOptions,
): PipelineService {
  const repository = options.repository;
  return {
    async run(lease, control) {
      if (!["source-extract", "reprocess"].includes(lease.type))
        return handlerUnavailable;
      const authorized = async () =>
        !control.signal.aborted && (await repository.checkpoint(lease));
      const guardedControl: PipelineControl = {
        signal: control.signal,
        checkpoint: authorized,
      };
      let failCurrentDocument:
        | ((code: string) => Promise<JobOutcome>)
        | undefined;
      const settled = (outcome: "committed" | "stale"): JobOutcome =>
        outcome === "committed" ? completed : stale;
      try {
        // load performs the full lease/source/processing-selection check in its
        // owned query; avoid repeating that read before any external effect.
        const work = await repository.load(lease);
        if (!work) return stale;
        const currentDocument = work.documents[work.documentIndex];
        const finishFailure = async (
          status: "review" | "unsupported" | "failed",
          code: string,
        ) => settled(await repository.fail(lease, { status, code }));
        if (work.stage !== "parse" && currentDocument) {
          failCurrentDocument = async (code) =>
            settled(
              await repository.failDocument(lease, {
                documentId: currentDocument.id,
                code,
                nextDocumentIndex:
                  work.documentIndex + 1 < work.documents.length
                    ? work.documentIndex + 1
                    : null,
              }),
            );
        }
        const failCode = async (
          code: string,
          status: "review" | "unsupported" | "failed" = "review",
        ) =>
          failCurrentDocument
            ? await failCurrentDocument(code)
            : await finishFailure(status, code);
        const reconcile = async (
          document: PipelineDocumentMetadata,
          fingerprint: string,
          result: PersistableAiResult,
        ) => {
          if (
            options.classification &&
            verifyFinancialDocumentResult(result) !== result
          )
            return await failCode("classification-verification");
          const input = {
            identity: {
              documentId: document.id,
              contentHash: document.contentHash,
              extractionFingerprint: fingerprint,
            },
            result,
          };
          if (!(await authorized())) return stale;
          const snapshot = await repository.loadSnapshot(lease, input);
          if (!snapshot) return stale;
          const plan = planLedgerIngestion(input, snapshot);
          return settled(
            await repository.commit(lease, {
              input,
              plan,
              nextDocumentIndex:
                work.documentIndex + 1 < work.documents.length
                  ? work.documentIndex + 1
                  : null,
            }),
          );
        };
        if (work.stage === "reconcile") {
          const document = work.documents[work.documentIndex];
          if (!document || !work.extractionFingerprint)
            return await finishFailure("review", "invalid-stage");
          const selected = await options.inference.open(lease, work, []);
          const expected = await aiRunIdentityKey({
            tenant: lease.context,
            identity: {
              documentId: document.id,
              contentHash: document.contentHash,
              extractionVersion: selected.config.promptVersion,
            },
            config: selected.config,
          });
          const price = selected.pricing.get(selected.config.fingerprint);
          if (expected !== work.extractionFingerprint && !price) return stale;
          const cached = await repository.cachedResult(
            lease,
            document.id,
            work.extractionFingerprint,
            expected !== work.extractionFingerprint && price
              ? {
                  extractionVersion:
                    work.previousFinancialExtraction?.fingerprint ===
                      work.extractionFingerprint &&
                    selected.config.promptVersion ===
                      EXTRACTION_PROMPT_VERSION &&
                    work.previousFinancialExtraction.extractionVersion !==
                      EXTRACTION_PROMPT_VERSION
                      ? work.previousFinancialExtraction.extractionVersion
                      : selected.config.promptVersion,
                  configurationDigest: price.configurationDigest,
                  policyVersion: price.policyVersion,
                }
              : undefined,
          );
          if (!cached) return stale;
          return await reconcile(document, work.extractionFingerprint, cached);
        }
        if (
          work.stage === "infer" &&
          currentDocument &&
          work.previousFinancialExtraction &&
          work.previousFinancialExtraction.extractionVersion !==
            EXTRACTION_PROMPT_VERSION
        ) {
          const previous = work.previousFinancialExtraction;
          const selected = await options.inference.open(lease, work, []);
          if (previous.extractionVersion !== selected.config.promptVersion) {
            const price = selected.pricing.get(selected.config.fingerprint);
            const cached =
              previous.completed && price
                ? await repository.cachedResult(
                    lease,
                    currentDocument.id,
                    previous.fingerprint,
                    {
                      extractionVersion: previous.extractionVersion,
                      configurationDigest: price.configurationDigest,
                      policyVersion: price.policyVersion,
                    },
                  )
                : null;
            if (!cached) return await failCode("cache-review-required");
            return settled(
              await repository.advance(lease, {
                stage: "reconcile",
                documentIndex: work.documentIndex,
                extractionFingerprint: previous.fingerprint,
              }),
            );
          }
        }
        const selectedPart =
          work.stage === "infer" &&
          !options.classification &&
          !usesDirectModelInput(currentDocument?.parserVersion)
            ? work.documents[work.documentIndex]?.partKey
            : undefined;
        if (
          work.stage === "infer" &&
          selectedPart === undefined &&
          !options.classification &&
          !usesDirectModelInput(currentDocument?.parserVersion)
        )
          return await finishFailure("review", "invalid-stage");
        const reader = await options.content.open(lease, guardedControl);
        const content = await reader.load({
          connectionId: lease.connectionId,
          providerMessageId: work.providerMessageId,
          ...(selectedPart !== undefined ? { partKey: selectedPart } : {}),
          ...guardedControl,
        });
        if (content.status !== "ready") return await failCode(content.code);
        // MIME decoding has no external effects; writes/model transport retain their fences.
        const directModelInput =
          (work.stage === "parse" && options.directModelInputs === true) ||
          work.documents.some((document) =>
            usesDirectModelInput(document.parserVersion),
          );
        const parsed = await options.documents.extract(content.input, {
          tenant: lease.context,
          signal: control.signal,
          ...(directModelInput ? { inputMode: "direct-model" as const } : {}),
          ...(!directModelInput &&
          work.stage !== "parse" &&
          work.documents[0]?.parserVersion === "documents-v1" &&
          ["text/plain", "text/html"].includes(work.documents[0].mime)
            ? { bodyAlternative: "legacy-plain" as const }
            : {}),
        });
        if (!parsed.documents.length)
          return await failCode(
            parsed.code ?? "empty-document",
            parsed.status === "unsupported" ? "unsupported" : "review",
          );
        if (work.stage === "parse") {
          const lengths = byteLengths(content.input);
          const metadata: PipelineDocumentMetadata[] = parsed.documents.map(
            (document) => ({
              id: crypto.randomUUID(),
              partKey: document.identity.partId,
              contentHash: document.contentHash,
              mime: document.mimeType,
              byteLength:
                directModelInput && document.status === "ready"
                  ? [
                      ...new Set(
                        document.textParts.map((part) =>
                          document.parserVersion ===
                          "documents-direct-selected-v2"
                            ? (part.partId ?? document.identity.partId).replace(
                                /@\d+:\d+$/,
                                "",
                              )
                            : (part.partId ?? document.identity.partId),
                        ),
                      ),
                    ].reduce(
                      (sum, partId) => sum + (lengths.get(partId) ?? 0),
                      0,
                    )
                  : (lengths.get(document.identity.partId) ?? 0),
              parseState: document.status,
              parserVersion: document.parserVersion,
              ...(document.status !== "ready" ? { code: document.code } : {}),
            }),
          );
          return settled(await repository.stageDocuments(lease, metadata));
        }
        const metadata = work.documents[work.documentIndex];
        if (!metadata) return await finishFailure("review", "invalid-stage");
        const document = parsed.documents.find(
          (candidate) => candidate.identity.partId === metadata.partKey,
        );
        if (
          !document ||
          document.contentHash !== metadata.contentHash ||
          document.parserVersion !== metadata.parserVersion
        )
          return await failCode("source-changed");
        if (document.status !== "ready") return await failCode(document.code);
        if (document.truncated) return await failCode("text_limit");
        const parts: AiTextPart[] = document.textParts.map((part, index) => ({
          id: `part-${index}`,
          text: part.text,
          ...(directModelInput
            ? {
                interpretation: "model" as const,
                ...(part.mimeType ? { mimeType: part.mimeType } : {}),
              }
            : {}),
        }));
        // Selection has no external effects. Both metered engines re-check the
        // lease and accepted selection immediately before model authorization.
        const selected = await options.inference.open(lease, work, parts);
        let classifiedCategory: ReceiptCategory | undefined;
        let verifyFinancialDocument = false;
        if (options.classification) {
          if (
            parsed.documents.length !== work.documents.length ||
            work.documents.some((metadata) => {
              const current = parsed.documents.find(
                (candidate) => candidate.identity.partId === metadata.partKey,
              );
              return (
                !current ||
                current.contentHash !== metadata.contentHash ||
                current.parserVersion !== metadata.parserVersion
              );
            })
          )
            return await failCode("source-changed");
          const classificationParts = document.textParts.map(
            (part, partIndex) => ({
              id: `document-${work.documentIndex}-part-${partIndex}`,
              text: part.text,
            }),
          );
          const classifier = await options.classification.open(
            lease,
            work,
            classificationParts,
            selected,
          );
          if (options.remainingStatements() < PAID_ATTEMPT_STATEMENT_RESERVE)
            return transientRetry;
          const classificationIdentity = {
            documentId: metadata.id,
            contentHash: metadata.contentHash,
            extractionVersion: EMAIL_CLASSIFICATION_VERSION,
          };
          const classificationKey = await aiRunIdentityKey({
            tenant: lease.context,
            identity: classificationIdentity,
            config: classifier.config,
          });
          const classification = await createClassificationEngine({
            classifier: classifier.classifier,
            store: createClassificationUsageStore(db, {
              lease,
              policy: options.budget,
              pricing: classifier.pricing,
              authorization: classifier.authorization,
              destination: classifier.destination,
            }),
          }).classify(
            lease.context,
            classificationIdentity,
            classificationParts,
            classifier.config,
            control.signal,
            {
              finalAttempt:
                options.maxJobAttempts !== undefined &&
                lease.attempt >= options.maxJobAttempts,
            },
          );
          verifyFinancialDocument =
            classification.status === "needs-review" &&
            classification.reason === "uncertain" &&
            classifier.uncertainAction === "extract";
          // Deferred provider rejections are not document outcomes: a rate
          // limit waits for its durable Retry-After cooldown; a rejected
          // operator key makes the classifier unavailable.
          if (classification.status === "deferred")
            return classification.reason === "invalid-key"
              ? handlerUnavailable
              : budgetPaused;
          if (
            classification.status !== "classified" &&
            !verifyFinancialDocument
          ) {
            if (
              ["budget", "in-progress"].includes(
                classification.status === "needs-review"
                  ? classification.reason
                  : "schema",
              )
            )
              return budgetPaused;
            if (
              classification.status === "needs-review" &&
              classification.reason === "settings-changed"
            )
              return stale;
            return await failCode(
              `classification-${classification.status === "needs-review" ? classification.reason : "schema"}`,
            );
          }
          if (
            classification.status === "classified" &&
            !classification.isReceipt &&
            work.documents.length === 1
          ) {
            if (!options.repository.skipSource)
              return await finishFailure(
                "review",
                "classification-handler-unavailable",
              );
            return settled(
              await options.repository.skipSource(lease, classificationKey),
            );
          }
          if (
            classification.status === "classified" &&
            !classification.isReceipt
          ) {
            if (!repository.skipDocument)
              return await failCode("classification-handler-unavailable");
            return settled(
              await repository.skipDocument(lease, {
                documentId: metadata.id,
                classificationFingerprint: classificationKey,
                nextDocumentIndex:
                  work.documentIndex + 1 < work.documents.length
                    ? work.documentIndex + 1
                    : null,
              }),
            );
          }
          verifyFinancialDocument = true;
          classifiedCategory =
            classification.status !== "classified" ||
            classification.category === "uncategorized"
              ? undefined
              : classification.category;
          if (work.extractionFingerprint !== classificationKey) {
            return settled(
              await repository.advance(lease, {
                stage: "infer",
                documentIndex: work.documentIndex,
                extractionFingerprint: classificationKey,
              }),
            );
          }
        }
        // One paid attempt per stage. Preserve room for known/uncertain settlement,
        // cache completion, durable continuation and engine settlement checks.
        if (selected.config.maxAttempts !== 1) return handlerUnavailable;
        // Refresh and prior guarded work can consume this invocation's SQL
        // allowance. A fresh invocation can recover without any model charge.
        if (options.remainingStatements() < PAID_ATTEMPT_STATEMENT_RESERVE)
          return transientRetry;
        const identity = {
          documentId: metadata.id,
          contentHash: metadata.contentHash,
          extractionVersion: selected.config.promptVersion,
        };
        const engine = createInferenceEngine({
          financialDocumentsOnly: verifyFinancialDocument,
          extractor:
            classifiedCategory === undefined
              ? selected.extractor
              : {
                  async extract(parts, config, attempt, signal) {
                    const response = await selected.extractor.extract(
                      parts,
                      config,
                      attempt,
                      signal,
                    );
                    if (
                      response.status !== "ok" ||
                      response.finish !== "complete"
                    )
                      return response;
                    try {
                      const output = JSON.parse(response.output);
                      if (!output || !Array.isArray(output.records))
                        return response;
                      return {
                        ...response,
                        output: JSON.stringify({
                          ...output,
                          records: output.records.map((record: unknown) =>
                            record && typeof record === "object"
                              ? { ...record, category: classifiedCategory }
                              : record,
                          ),
                        }),
                      };
                    } catch {
                      return response;
                    }
                  },
                },
          store: createAiUsageStore(db, {
            lease,
            policy: options.budget,
            pricing: selected.pricing,
          }),
        });
        const result = await engine.extract(
          lease.context,
          identity,
          parts,
          selected.config,
          control.signal,
        );
        if (
          result.status === "needs-review" &&
          ["budget", "in-progress"].includes(result.reason)
        )
          return budgetPaused;
        if (
          result.status === "needs-review" &&
          result.reason === "settings-changed"
        )
          return stale;
        if (result.status === "needs-review" && result.reason === "invalid-key")
          return stale;
        if (result.status === "needs-review" && result.reason === "rate-limit")
          return budgetPaused;
        if (
          verifyFinancialDocument &&
          result.status === "needs-review" &&
          result.reason === "semantics"
        )
          return await failCode("classification-verification");
        const fingerprint = await aiRunIdentityKey({
          tenant: lease.context,
          identity,
          config: selected.config,
        });
        // Early provider failures are deliberately not cached by the inference
        // engine. They remain visible and cannot silently become a retrying call.
        if (
          result.status === "needs-review" &&
          [
            "timeout",
            "input-limit",
            "unsupported",
            "refusal",
            "outage",
          ].includes(result.reason)
        )
          return await failCode(result.reason);
        return settled(
          await repository.advance(lease, {
            stage: "reconcile",
            documentIndex: work.documentIndex,
            extractionFingerprint: fingerprint,
          }),
        );
      } catch (cause) {
        if (
          cause instanceof ContentError &&
          cause.retryAfterMs !== undefined &&
          cause.retryAfterMs > 86400000
        )
          return handlerUnavailable;
        if (
          cause instanceof ContentError &&
          cause.code === "CONTENT_BYTE_LIMIT"
        )
          return failCurrentDocument
            ? await failCurrentDocument("byte_limit")
            : settled(
                await repository.fail(lease, {
                  status: "review",
                  code: "byte_limit",
                }),
              );
        if (cause instanceof AiSettingsError && cause.code === "CONFLICT")
          return stale;
        if (
          cause instanceof ContentError &&
          ["CONTENT_AUTH_CHANGED", "CONTENT_AUTH_REQUIRED"].includes(cause.code)
        )
          return stale;
        if (
          cause instanceof ContentError &&
          cause.code === "CONTENT_SOURCE_UNAVAILABLE"
        )
          return failCurrentDocument
            ? await failCurrentDocument("source-unavailable")
            : settled(
                await repository.fail(lease, {
                  status: "review",
                  code: "source-unavailable",
                }),
              );
        console.warn("pipeline_retry", {
          reason:
            cause instanceof ContentError ||
            cause instanceof PipelinePersistenceError
              ? cause.code
              : control.signal.aborted
                ? "TIMEOUT"
                : "UNEXPECTED",
        });
        return {
          kind: "retry",
          code: control.signal.aborted ? "timeout" : "transient",
          ...(cause instanceof ContentError && cause.retryAfterMs !== undefined
            ? { retryAfterMs: cause.retryAfterMs }
            : {}),
        };
      }
    },
  };
}
