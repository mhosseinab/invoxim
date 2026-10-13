import type {
  AiConfiguration,
  ClefBinding,
  TransientContentFactory,
} from "@invoxim/adapters";
import {
  createAiProviderFactory,
  createLocalPdfTextExtractor,
  createPipelineRepository,
  createPipelineService,
  createProcessingReviewResolver,
  createReceiptClassifierFactory,
} from "@invoxim/adapters";
import type { JobHandler } from "@invoxim/core";
import { createDocumentTextExtractor } from "@invoxim/core";

/** Server-configured external services share the actual invocation database. */
export function createPipelineRuntime(options: {
  db: D1Database;
  content: TransientContentFactory;
  ai: AiConfiguration;
  classificationBinding?: ClefBinding | undefined;
  remainingStatements: () => number;
}): JobHandler {
  if (options.ai.classification?.enabled && !options.classificationBinding) {
    return {
      async run() {
        return { kind: "paused", code: "handler-unavailable" };
      },
    };
  }
  const factory = createAiProviderFactory(options.db, options.ai, {
    requireReviewedConfiguration: true,
  });
  return createPipelineService(options.db, {
    repository: createPipelineRepository(options.db, {
      remainingStatements: options.remainingStatements,
      processingDigest: createProcessingReviewResolver(options.ai),
    }),
    content: options.content,
    documents: createDocumentTextExtractor({
      pdf: createLocalPdfTextExtractor(),
    }),
    inference: {
      open(lease, work, parts) {
        return factory.open(lease.context, {
          settingsRevision: work.settingsRevision,
          consentId: lease.consentId,
          parts,
          maxAttempts: 1,
        });
      },
    },
    ...(options.ai.classification && options.classificationBinding
      ? {
          classification: createReceiptClassifierFactory(
            options.db,
            options.ai.classification,
            { binding: options.classificationBinding },
          ),
        }
      : {}),
    budget: options.ai.budget,
    remainingStatements: options.remainingStatements,
  });
}
