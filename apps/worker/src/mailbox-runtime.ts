import type {
  AiBindings,
  GmailBindings,
  OutlookBindings,
} from "@invoxim/adapters";
import {
  aiConfiguration,
  connectionConsentLiveSql,
  createGmailContentFactory,
  createGmailDiscoveryProviderFactory,
  createOutlookContentFactory,
  createOutlookDiscoveryProviderFactory,
  createOutlookJobRunner,
  createProcessingDiscoveryReadiness,
  gmailConfiguration,
  outlookConfiguration,
} from "@invoxim/adapters";
import type { JobHandler } from "@invoxim/core";
import { createDiscoveryRuntime } from "./discovery-runtime";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration, QUERY_LIMIT } from "./job-configuration";
import { createPipelineRuntime } from "./pipeline-runtime";

export interface MailboxRuntimeBindings
  extends AiBindings, GmailBindings, OutlookBindings, JobBindings {
  GMAIL_DISCOVERY_ENABLED?: string;
  OUTLOOK_DISCOVERY_ENABLED?: string;
  EXTRACTION_ENABLED?: string;
}
/** Authorization alone never advertises a usable import path. */
export function mailboxProcessingConfiguration(
  bindings: MailboxRuntimeBindings,
) {
  // A non-null AI configuration already requires the configured
  // classification provider's own transport credential (no fallback).
  const ai = aiConfiguration(bindings);
  const jobs = jobConfiguration(bindings);
  const ready =
    !!ai?.classification?.enabled &&
    !!jobs &&
    jobs.queryLimit === QUERY_LIMIT &&
    bindings.EXTRACTION_ENABLED === "true";
  const gmail =
    ready && bindings.GMAIL_DISCOVERY_ENABLED === "true"
      ? gmailConfiguration(bindings)
      : null;
  const outlook =
    ready && bindings.OUTLOOK_DISCOVERY_ENABLED === "true"
      ? outlookConfiguration(bindings)
      : null;
  const providers: ("gmail" | "outlook")[] = [];
  if (gmail) providers.push("gmail");
  if (outlook) providers.push("outlook");
  return { ai, gmail, outlook, providers };
}
/** One owned provider selects both discovery and content. No provider fallback. */
export function createMailboxRuntime(options: {
  db: D1Database;
  bindings: MailboxRuntimeBindings;
  remainingStatements: () => number;
}): JobHandler {
  const { db, bindings, remainingStatements } = options;
  const { ai, gmail, outlook } = mailboxProcessingConfiguration(bindings);
  const gmailDiscovery =
    gmail && ai
      ? createDiscoveryRuntime({
          db,
          providers: createGmailDiscoveryProviderFactory(db, gmail),
          readiness: createProcessingDiscoveryReadiness(ai),
          remainingStatements,
        })
      : null;
  const outlookProviders = outlook
    ? createOutlookDiscoveryProviderFactory(db, outlook)
    : null;
  const outlookDiscovery = outlookProviders
    ? createOutlookJobRunner(db, {
        remainingStatements,
        open: (lease, signal) =>
          outlookProviders.open(
            lease.context,
            { connectionId: lease.connectionId, generation: lease.generation },
            signal,
          ),
      })
    : null;
  const pipeline = (
    content: Parameters<typeof createPipelineRuntime>[0]["content"],
  ) =>
    ai
      ? createPipelineRuntime({
          db,
          content,
          ai,
          classificationBinding: bindings.AI,
          perplexityApiKey: bindings.PERPLEXITY_API_KEY,
          remainingStatements,
        })
      : null;
  const gmailPipeline = gmail
    ? pipeline(createGmailContentFactory(db, gmail))
    : null;
  const outlookPipeline = outlook
    ? pipeline(createOutlookContentFactory(db, outlook))
    : null;
  return {
    async run(lease, control) {
      if (control.signal.aborted) return { kind: "paused", code: "auth" };
      // O2: provider lookup uses PIPE-3's live fragment instead of a hand-copied predicate.
      const provider = await db
        .prepare(
          `SELECT c.provider FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND c.id=? AND c.generation=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=?`,
        )
        .bind(
          lease.context.userId,
          lease.connectionId,
          lease.generation,
          Date.now(),
        )
        .first<string>("provider");
      if (control.signal.aborted) return { kind: "paused", code: "auth" };
      const extraction = ["source-extract", "reprocess"].includes(lease.type);
      const selected =
        provider === "gmail"
          ? extraction
            ? gmailPipeline
            : gmailDiscovery
          : provider === "outlook"
            ? extraction
              ? outlookPipeline
              : outlookDiscovery
            : null;
      return selected
        ? selected.run(lease, control)
        : { kind: "paused", code: "handler-unavailable" };
    },
  };
}
