import type {
  AiConfiguration,
  ClefBinding,
  TransientContentFactory,
} from "@invoxim/adapters";
import {
  createAiProviderFactory,
  createClassificationTransport,
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
  /** Wrangler secret used only when the configured provider is perplexity-decider. */
  perplexityApiKey?: string | undefined;
  remainingStatements: () => number;
}): JobHandler {
  // Not a readiness rule: mailboxProcessingConfiguration decides what is
  // runnable. This is the fail-closed boundary that keeps extraction from
  // reading mailbox content without the configured classification transport.
  const transportSources = {
    binding: options.classificationBinding,
    perplexityApiKey: options.perplexityApiKey,
  };
  const classification = options.ai.classification;
  if (
    !classification?.enabled ||
    !createClassificationTransport(classification, transportSources)
  ) {
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
    directModelInputs: true,
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
    classification: createReceiptClassifierFactory(
      options.db,
      classification,
      transportSources,
    ),
    budget: options.ai.budget,
    remainingStatements: options.remainingStatements,
  });
}
