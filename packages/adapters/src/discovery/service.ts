import type {
  AcceptedImportInput,
  DiscoveryProcessingSelection,
  DiscoveryProviderFactory,
  DiscoveryReadinessPort,
  JobLease,
  TenantContext,
} from "@invoxim/core";
import { DiscoveryError, planDiscoveryRange } from "@invoxim/core";
import {
  processingSelectionSchema,
  processingSelectionSql,
} from "../pipeline/repository-guards";
import { buildAcceptedImportStatements } from "./import-plan";
import { createDiscoveryPages } from "./pages";
export interface DiscoveryServiceOptions {
  providers: DiscoveryProviderFactory;
  readiness: DiscoveryReadinessPort;
  remainingStatements: () => number;
  clock?: () => number;
}
interface ConsentRow {
  generation: number;
  disclosure_version: number;
  ai_settings_revision: number;
  query_mode: "filtered" | "broad";
  timezone: string;
  processing_selection?: string;
  accepted_configuration_digest?: string;
}
function reviewedSelection(
  encoded: string | undefined,
): DiscoveryProcessingSelection & { acceptedDigest: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded ?? "null");
  } catch {
    throw new DiscoveryError("UNAUTHORIZED");
  }
  const parsed = processingSelectionSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.acceptedDigest === null)
    throw new DiscoveryError("UNAUTHORIZED");
  return { ...parsed.data, acceptedDigest: parsed.data.acceptedDigest };
}
export function createDiscoveryService(
  db: D1Database,
  options: DiscoveryServiceOptions,
) {
  const clock = options.clock ?? Date.now;
  let executions = 0;
  function charge(count = 1) {
    if (executions + count > 25 || options.remainingStatements() < count + 2)
      throw new DiscoveryError("UNAVAILABLE");
    executions += count;
  }
  async function consent(
    context: TenantContext,
    input: {
      connectionId: string;
      generation: number;
      consentId: string;
      queryMode: "filtered" | "broad";
    },
  ) {
    charge();
    const result = await db
      .prepare(
        `SELECT c.generation,s.disclosure_version,s.ai_settings_revision,s.query_mode,p.timezone${options.readiness.requiresProcessingSelection ? `,${processingSelectionSql({ consent: "s" })} AS processing_selection` : ""} FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents s ON s.user_id=c.user_id AND s.connection_id=c.id ${options.readiness.requiresProcessingSelection ? "JOIN ai_settings a ON a.user_id=c.user_id AND a.status='active' AND a.revision=s.ai_settings_revision AND a.provider_id=s.inference_destination AND a.consent_version=s.disclosure_version" : ""} WHERE c.user_id=? AND c.id=? AND c.generation=? AND c.provider='gmail' AND c.kind='mailbox' AND c.state='connected' AND c.credential_ciphertext IS NOT NULL AND p.status='active' AND s.id=? AND s.revoked_at IS NULL AND s.background_authorized=1 AND s.query_mode=? AND s.accepted_at<=? AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='https://www.googleapis.com/auth/gmail.readonly')`,
      )
      .bind(
        context.userId,
        input.connectionId,
        input.generation,
        input.consentId,
        input.queryMode,
        clock(),
      )
      .first<ConsentRow>();
    if (!result) throw new DiscoveryError("UNAUTHORIZED");
    // P1: the one shared consent-review schema; malformed or incomplete
    // selections never reach the readiness port.
    const selection = options.readiness.requiresProcessingSelection
      ? reviewedSelection(result.processing_selection)
      : undefined;
    if (
      !(await options.readiness.allow(context, {
        ...input,
        disclosureVersion: result.disclosure_version,
        settingsRevision: result.ai_settings_revision,
        ...(selection ? { processingSelection: selection } : {}),
      }))
    )
      throw new DiscoveryError("UNAUTHORIZED");
    return selection
      ? { ...result, accepted_configuration_digest: selection.acceptedDigest }
      : result;
  }
  async function beginAcceptedImport(
    context: TenantContext,
    input: AcceptedImportInput,
  ) {
    const accepted = await consent(context, input);
    const plan = planDiscoveryRange(input);
    if (
      accepted.timezone !== input.timezone ||
      input.cutoffMs > clock() ||
      input.fingerprint.length === 0 ||
      input.fingerprint.length > 256
    )
      throw new DiscoveryError("INVALID_RANGE");
    charge();
    const prior = await db
      .prepare(
        "SELECT id,frozen_start,frozen_cutoff,consent_id,connection_generation,query_mode,timezone FROM import_runs WHERE user_id=? AND request_fingerprint=?",
      )
      .bind(context.userId, input.fingerprint)
      .first<{
        id: string;
        frozen_start: string;
        frozen_cutoff: string;
        consent_id: string;
        connection_generation: number;
        query_mode: string;
        timezone: string;
      }>();
    const start = new Date(plan.range.startMs).toISOString(),
      cutoff = new Date(plan.range.cutoffMs).toISOString();
    if (prior) {
      if (
        prior.frozen_start !== start ||
        prior.frozen_cutoff !== cutoff ||
        prior.consent_id !== input.consentId ||
        prior.connection_generation !== input.generation ||
        prior.query_mode !== input.queryMode ||
        prior.timezone !== input.timezone
      )
        throw new DiscoveryError("CONFLICT");
      return { importRunId: prior.id };
    }
    charge();
    const liveMode = await db
      .prepare(
        "SELECT l.query_mode,l.stage,l.recovery_anchor,l.pending_ids,l.page_token,r.frozen_start,r.frozen_cutoff FROM sync_states l LEFT JOIN import_runs r ON r.user_id=l.user_id AND r.connection_id=l.connection_id AND r.id=(SELECT id FROM import_runs WHERE user_id=l.user_id AND connection_id=l.connection_id ORDER BY started_at DESC,id DESC LIMIT 1) WHERE l.user_id=? AND l.connection_id=? AND l.scope_key='mailbox' AND l.sync_kind='incremental' AND l.run_key='live' AND l.slice_key='live'",
      )
      .bind(context.userId, input.connectionId)
      .first<{
        query_mode: string;
        stage: string;
        recovery_anchor: string | null;
        pending_ids: string | null;
        page_token: string | null;
        frozen_start: string | null;
        frozen_cutoff: string | null;
      }>();
    if (
      liveMode &&
      (liveMode.query_mode !== input.queryMode ||
        ((liveMode.stage === "recovering" ||
          liveMode.recovery_anchor !== null ||
          liveMode.pending_ids !== null ||
          liveMode.page_token !== null) &&
          (liveMode.frozen_start !== start ||
            liveMode.frozen_cutoff !== cutoff)))
    )
      throw new DiscoveryError("CONFLICT");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let anchor: string;
    try {
      const provider = await options.providers.open(
        context,
        { connectionId: input.connectionId, generation: input.generation },
        controller.signal,
      );
      await consent(context, input);
      anchor = await provider.anchor(controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const runId = crypto.randomUUID(),
      recentId = crypto.randomUUID(),
      olderId = crypto.randomUUID(),
      liveId = crypto.randomUUID();
    const now = clock();
    const guard = `EXISTS(SELECT 1 FROM profiles p JOIN connections c ON c.user_id=p.user_id JOIN processing_consents s ON s.user_id=c.user_id AND s.connection_id=c.id WHERE p.user_id=? AND p.status='active' AND c.id=? AND c.generation=? AND c.state='connected' AND s.id=? AND s.revoked_at IS NULL AND s.background_authorized=1 AND s.disclosure_version=? AND s.ai_settings_revision=? AND s.query_mode=?${accepted.accepted_configuration_digest ? " AND s.accepted_configuration_digest=?" : ""} AND s.accepted_at<=? AND p.timezone=?) AND NOT EXISTS(SELECT 1 FROM sync_states WHERE user_id=? AND connection_id=? AND scope_key='mailbox' AND sync_kind='incremental' AND run_key='live' AND slice_key='live' AND query_mode!=?) AND NOT EXISTS(SELECT 1 FROM sync_states l JOIN import_runs r ON r.user_id=l.user_id AND r.connection_id=l.connection_id AND r.id=(SELECT id FROM import_runs WHERE user_id=l.user_id AND connection_id=l.connection_id ORDER BY started_at DESC,id DESC LIMIT 1) WHERE l.user_id=? AND l.connection_id=? AND l.scope_key='mailbox' AND l.sync_kind='incremental' AND l.run_key='live' AND l.slice_key='live' AND (l.stage='recovering' OR l.recovery_anchor IS NOT NULL OR l.pending_ids IS NOT NULL OR l.page_token IS NOT NULL) AND (r.frozen_start!=? OR r.frozen_cutoff!=?))`;
    const bindings = [
      context.userId,
      input.connectionId,
      input.generation,
      input.consentId,
      accepted.disclosure_version,
      accepted.ai_settings_revision,
      input.queryMode,
      ...(accepted.accepted_configuration_digest
        ? [accepted.accepted_configuration_digest]
        : []),
      now,
      input.timezone,
      context.userId,
      input.connectionId,
      input.queryMode,
      context.userId,
      input.connectionId,
      start,
      cutoff,
    ];
    const statements = buildAcceptedImportStatements(db, {
      context,
      connectionId: input.connectionId,
      generation: input.generation,
      consentId: input.consentId,
      fingerprint: input.fingerprint,
      queryMode: input.queryMode,
      timezone: input.timezone,
      runId,
      recentId,
      olderId,
      liveId,
      seed: { provider: "gmail", historyAnchor: anchor },
      now,
      plan,
      guard: { sql: guard, values: bindings },
    });
    charge(statements.length);
    await db.batch(statements);
    charge();
    const created = await db
      .prepare(
        "SELECT id FROM import_runs WHERE user_id=? AND request_fingerprint=? AND consent_id=? AND connection_generation=? AND frozen_start=? AND frozen_cutoff=? AND timezone=? AND query_mode=?",
      )
      .bind(
        context.userId,
        input.fingerprint,
        input.consentId,
        input.generation,
        start,
        cutoff,
        input.timezone,
        input.queryMode,
      )
      .first<{ id: string }>();
    if (!created) throw new DiscoveryError("CONFLICT");
    return { importRunId: created.id };
  }
  async function safe<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (cause) {
      if (cause instanceof DiscoveryError) throw cause;
      throw new DiscoveryError("UNAVAILABLE");
    }
  }
  const pages = createDiscoveryPages(db, options, {
    charge,
    consent,
    remainingPageStatements: () => 25 - executions,
  });
  return {
    runPage: (
      lease: JobLease,
      control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    ) => safe(() => pages.runPage(lease, control)),
    progress: (context: TenantContext, importRunId: string) =>
      safe(() => pages.progress(context, importRunId)),
    beginAcceptedImport: (context: TenantContext, input: AcceptedImportInput) =>
      safe(() => beginAcceptedImport(context, input)),
  };
}
