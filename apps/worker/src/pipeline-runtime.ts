import type { AiConfiguration, GmailConfiguration } from "@invoxim/adapters";
import {
  createAiProviderFactory,
  createGmailContentFactory,
  createLocalPdfTextExtractor,
  createPipelineRepository,
  createPipelineService,
  createProcessingReviewResolver,
} from "@invoxim/adapters";
import type { JobHandler } from "@invoxim/core";
import { createDocumentTextExtractor } from "@invoxim/core";

/** Server-configured external services share the actual invocation database. */
export function createPipelineRuntime(options: {
  db: D1Database;
  gmail: GmailConfiguration;
  ai: AiConfiguration;
  remainingStatements: () => number;
}): JobHandler {
  const factory = createAiProviderFactory(options.db, options.ai, {
    requireReviewedConfiguration: true,
  });
  return createPipelineService(options.db, {
    repository: createPipelineRepository(options.db, {
      remainingStatements: options.remainingStatements,
      processingDigest: createProcessingReviewResolver(options.ai),
    }),
    content: createGmailContentFactory(options.db, options.gmail),
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
    budget: options.ai.budget,
    remainingStatements: options.remainingStatements,
  });
}
