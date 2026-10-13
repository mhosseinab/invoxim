import type {
  AiTextPart,
  DocumentInput,
  JobOutcome,
  PersistableAiResult,
} from "@invoxim/core";
import {
  aiRunIdentityKey,
  createInferenceEngine,
  planLedgerIngestion,
} from "@invoxim/core";
import { createAiUsageStore } from "../ai/budget";
import { AiSettingsError } from "../ai/settings";
import { ContentError } from "./gmail-content";
import type { PipelineDocumentMetadata } from "./repository";
import type {
  PipelineControl,
  PipelineService,
  PipelineServiceOptions,
} from "./types";

const completed: JobOutcome = { kind: "completed" };
const stale: JobOutcome = { kind: "paused", code: "auth" };
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
        return { kind: "paused", code: "handler-unavailable" };
      const authorized = async () =>
        !control.signal.aborted && (await repository.checkpoint(lease));
      const guardedControl: PipelineControl = {
        signal: control.signal,
        checkpoint: authorized,
      };
      let failCurrentDocument:
        | ((code: string) => Promise<JobOutcome>)
        | undefined;
      try {
        if (!(await authorized())) return stale;
        const work = await repository.load(lease);
        if (!work) return stale;
        const currentDocument = work.documents[work.documentIndex];
        if (work.stage !== "parse" && currentDocument) {
          failCurrentDocument = async (code) =>
            (await repository.failDocument(lease, {
              documentId: currentDocument.id,
              code,
              nextDocumentIndex:
                work.documentIndex + 1 < work.documents.length
                  ? work.documentIndex + 1
                  : null,
            })) === "committed"
              ? completed
              : stale;
        }
        const finishFailure = async (
          status: "review" | "unsupported" | "failed",
          code: string,
        ) =>
          (await repository.fail(lease, { status, code })) === "committed"
            ? completed
            : stale;
        const reconcile = async (
          document: PipelineDocumentMetadata,
          fingerprint: string,
          result: PersistableAiResult,
        ) => {
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
          return (await repository.commit(lease, {
            input,
            plan,
            nextDocumentIndex:
              work.documentIndex + 1 < work.documents.length
                ? work.documentIndex + 1
                : null,
          })) === "committed"
            ? completed
            : stale;
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
                  extractionVersion: selected.config.promptVersion,
                  configurationDigest: price.configurationDigest,
                  policyVersion: price.policyVersion,
                }
              : undefined,
          );
          if (!cached) return stale;
          return await reconcile(document, work.extractionFingerprint, cached);
        }
        const selectedPart =
          work.stage === "infer"
            ? work.documents[work.documentIndex]?.partKey
            : undefined;
        if (work.stage === "infer" && selectedPart === undefined)
          return await finishFailure("review", "invalid-stage");
        const reader = await options.content.open(lease, guardedControl);
        const content = await reader.load({
          connectionId: lease.connectionId,
          providerMessageId: work.providerMessageId,
          ...(selectedPart !== undefined ? { partKey: selectedPart } : {}),
          ...guardedControl,
        });
        if (content.status !== "ready")
          return failCurrentDocument
            ? await failCurrentDocument(content.code)
            : await finishFailure("review", content.code);
        if (!(await authorized())) return stale;
        const parsed = await options.documents.extract(content.input, {
          tenant: lease.context,
          signal: control.signal,
        });
        if (!parsed.documents.length)
          return failCurrentDocument
            ? await failCurrentDocument(parsed.code ?? "empty-document")
            : await finishFailure(
                parsed.status === "unsupported" ? "unsupported" : "review",
                parsed.code ?? "empty-document",
              );
        if (work.stage === "parse") {
          const lengths = byteLengths(content.input);
          const metadata: PipelineDocumentMetadata[] = parsed.documents.map(
            (document) => ({
              id: crypto.randomUUID(),
              partKey: document.identity.partId,
              contentHash: document.contentHash,
              mime: document.mimeType,
              byteLength: lengths.get(document.identity.partId) ?? 0,
              parseState: document.status,
              parserVersion: document.parserVersion,
              ...(document.status !== "ready" ? { code: document.code } : {}),
            }),
          );
          return (await repository.stageDocuments(lease, metadata)) ===
            "committed"
            ? completed
            : stale;
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
          return failCurrentDocument
            ? await failCurrentDocument("source-changed")
            : await finishFailure("review", "source-changed");
        if (document.status !== "ready")
          return failCurrentDocument
            ? await failCurrentDocument(document.code)
            : await finishFailure("review", document.code);
        const parts: AiTextPart[] = document.textParts.map((part, index) => ({
          id: `part-${index}`,
          text: part.text,
        }));
        if (!(await authorized())) return stale;
        const selected = await options.inference.open(lease, work, parts);
        // One paid attempt per stage. Preserve room for known/uncertain settlement,
        // cache completion, durable continuation and engine settlement checks.
        if (selected.config.maxAttempts !== 1)
          return { kind: "paused", code: "handler-unavailable" };
        // Refresh and prior guarded work can consume this invocation's SQL
        // allowance. A fresh invocation can recover without any model charge.
        if (options.remainingStatements() < 23)
          return { kind: "retry", code: "transient" };
        const identity = {
          documentId: metadata.id,
          contentHash: metadata.contentHash,
          extractionVersion: selected.config.promptVersion,
        };
        const engine = createInferenceEngine({
          extractor: selected.extractor,
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
          return { kind: "paused", code: "budget" };
        if (
          result.status === "needs-review" &&
          result.reason === "settings-changed"
        )
          return stale;
        if (result.status === "needs-review" && result.reason === "invalid-key")
          return stale;
        if (result.status === "needs-review" && result.reason === "rate-limit")
          return { kind: "paused", code: "budget" };
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
          return failCurrentDocument
            ? await failCurrentDocument(result.reason)
            : await finishFailure("review", result.reason);
        return (await repository.advance(lease, {
          stage: "reconcile",
          documentIndex: work.documentIndex,
          extractionFingerprint: fingerprint,
        })) === "committed"
          ? completed
          : stale;
      } catch (cause) {
        if (
          cause instanceof ContentError &&
          cause.code === "CONTENT_BYTE_LIMIT"
        ) {
          if (failCurrentDocument)
            return await failCurrentDocument("byte_limit");
          return (await repository.fail(lease, {
            status: "review",
            code: "byte_limit",
          })) === "committed"
            ? completed
            : stale;
        }
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
        ) {
          if (failCurrentDocument)
            return await failCurrentDocument("source-unavailable");
          return (await repository.fail(lease, {
            status: "review",
            code: "source-unavailable",
          })) === "committed"
            ? completed
            : stale;
        }
        return {
          kind: "retry",
          code: control.signal.aborted ? "timeout" : "transient",
        };
      }
    },
  };
}
