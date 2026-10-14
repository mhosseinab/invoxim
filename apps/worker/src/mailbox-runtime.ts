import type {
  AiBindings,
  GmailBindings,
  OutlookBindings,
} from "@invoxim/adapters";
import {
  aiConfiguration,
  createGmailContentFactory,
  createGmailDiscoveryProviderFactory,
  createProcessingDiscoveryReadiness,
  gmailConfiguration,
  outlookConfiguration,
} from "@invoxim/adapters";
import type { JobHandler } from "@invoxim/core";
import { createOutlookJobRunner } from "../../../packages/adapters/src/discovery/outlook-job";
import { createOutlookDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/outlook-provider-factory";
import { createOutlookContentFactory } from "../../../packages/adapters/src/pipeline/outlook-factory";
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
  const ai = aiConfiguration(bindings);
  const jobs = jobConfiguration(bindings);
  const ready =
    !!ai?.classification?.enabled &&
    !!bindings.AI &&
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
      const provider = await db
        .prepare(
          "SELECT provider FROM connections WHERE user_id=? AND id=? AND generation=? AND kind='mailbox' AND state='connected' AND scheduling_state='active'",
        )
        .bind(lease.context.userId, lease.connectionId, lease.generation)
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
