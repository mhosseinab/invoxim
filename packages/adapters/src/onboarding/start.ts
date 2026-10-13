import { onboardingStartResponseSchema } from "@invoxim/contracts";
import type {
  OnboardingImportSeed,
  OnboardingSession,
  PreparedOnboardingStart,
} from "@invoxim/core";
import { OnboardingError, planDiscoveryRange } from "@invoxim/core";
import { buildAcceptedImportStatements } from "../discovery/import-plan";
import { onboardingHistoryCompleteSql } from "./active-run";
import type { OnboardingRepositoryOptions } from "./repository";
/** A nonce claim and final NOT NULL assertion make every authorization/settings/import write atomic. */
export async function commitOnboardingStart(
  db: D1Database,
  session: OnboardingSession,
  p: PreparedOnboardingStart,
  seed: OnboardingImportSeed | null,
  options: OnboardingRepositoryOptions,
) {
  if (
    p.resume
      ? seed !== null
      : !seed ||
        seed.provider !== p.provider ||
        (seed.provider === "gmail" &&
          (typeof seed.historyAnchor !== "string" ||
            !/^[0-9]{1,100}$/.test(seed.historyAnchor)))
  )
    throw new OnboardingError("UNAVAILABLE");
  const now = (options.clock ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < p.cutoffMs)
    throw new OnboardingError("UNAVAILABLE");
  const nonce = crypto.randomUUID(),
    pending = JSON.stringify({ pending: nonce }),
    runId = p.resume?.runId ?? crypto.randomUUID(),
    consentId = crypto.randomUUID(),
    recentId = crypto.randomUUID(),
    olderId = crypto.randomUUID(),
    liveId = crypto.randomUUID();
  const user = session.tenant.userId;
  const fresh = `EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active' AND version=?) AND EXISTS(SELECT 1 FROM "session" WHERE "userId"=? AND id=? AND "expiresAt">?) AND EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND state='connected' AND provider=? AND scopes=? AND credential_ciphertext IS NOT NULL) AND ${p.resume ? `EXISTS(SELECT 1 FROM import_runs r WHERE r.user_id=? AND r.connection_id=? AND r.id=? AND r.consent_id=? AND r.connection_generation=? AND r.completed_at IS NULL AND NOT (${onboardingHistoryCompleteSql}))` : `NOT EXISTS(SELECT 1 FROM import_runs r WHERE r.user_id=? AND r.connection_id=? AND r.completed_at IS NULL AND NOT (${onboardingHistoryCompleteSql}))`} AND ${p.expectedAiSettingsRevision === 0 ? "NOT EXISTS(SELECT 1 FROM ai_settings WHERE user_id=? AND revision<>0)" : "EXISTS(SELECT 1 FROM ai_settings WHERE user_id=? AND revision=? AND generation=? AND credential_version=? AND status='active')"}`;
  const freshValues: (string | number | null)[] = [
    user,
    p.expectedProfileVersion,
    user,
    session.sessionId,
    now,
    user,
    p.connectionId,
    p.generation,
    p.credentialVersion,
    p.provider,
    p.scopes,
    user,
    p.connectionId,
    ...(p.resume
      ? [p.resume.runId, p.resume.consentId, p.resume.priorGeneration]
      : []),
    user,
    ...(p.expectedAiSettingsRevision === 0
      ? []
      : [
          p.expectedAiSettingsRevision,
          p.settingsGeneration,
          p.settingsCredentialVersion,
        ]),
  ];
  const claim =
      "EXISTS(SELECT 1 FROM onboarding_commands WHERE user_id=? AND key_hash=? AND body_hash=? AND result_json=?)",
    claimValues = [user, p.keyHash, p.bodyHash, pending];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO onboarding_commands(user_id,key_hash,body_hash,result_json,created_at) SELECT ?,?,?,?,? WHERE ${fresh} ON CONFLICT(user_id,key_hash) DO NOTHING`,
      )
      .bind(user, p.keyHash, p.bodyHash, pending, now, ...freshValues),
  ];
  const add = (sql: string, values: (string | number | null)[]) =>
    statements.push(db.prepare(sql).bind(...values, ...claimValues));
  if (p.initializeHosted)
    add(
      `INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version,generation,credential_version,status) SELECT ?,'hosted',?,?,?,?,?,?,?,'active' WHERE ${claim} ON CONFLICT(user_id) DO UPDATE SET mode='hosted',provider_id=excluded.provider_id,model_id=excluded.model_id,config_version=excluded.config_version,revision=excluded.revision,consent_version=excluded.consent_version,status='active' WHERE ai_settings.revision=0 AND ai_settings.mode IS NULL`,
      [
        user,
        p.destinationId,
        p.modelId,
        p.configVersion,
        p.selectedAiSettingsRevision,
        p.policyVersion,
        p.settingsGeneration,
        p.settingsCredentialVersion,
      ],
    );
  add(
    `UPDATE profiles SET timezone=?,reporting_currency=?,version=version+1,onboarding_completed_at=COALESCE(onboarding_completed_at,?),updated_at=? WHERE user_id=? AND version=? AND ${claim}`,
    [p.timezone, p.reportingCurrency, now, now, user, p.expectedProfileVersion],
  );
  add(
    `INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,query_mode,accepted_configuration_digest,disclosure_digest) SELECT ?,?,?,?,?,?,?,?,1,'filtered',?,? WHERE ${claim}`,
    [
      consentId,
      user,
      p.connectionId,
      p.policyVersion,
      p.destinationId,
      p.parserDestination,
      p.selectedAiSettingsRevision,
      now,
      p.configurationDigest,
      p.disclosureVersion,
    ],
  );
  if (p.resume) {
    if (p.provider === "outlook" && p.resume.priorGeneration !== p.generation)
      add(
        `UPDATE sync_states SET scope_key='outlook:'||?||':'||substr(scope_key,length('outlook:'||?||':')+1) WHERE user_id=? AND connection_id=? AND scope_key LIKE 'outlook:'||?||':%' AND (import_run_id=? OR (sync_kind='incremental' AND run_key='live' AND slice_key='live')) AND ${claim}`,
        [
          String(p.generation),
          String(p.resume.priorGeneration),
          user,
          p.connectionId,
          String(p.resume.priorGeneration),
          runId,
        ],
      );
    add(
      `UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND id=? AND ${claim}`,
      [now, user, p.resume.consentId],
    );
    add(
      `UPDATE import_runs SET consent_id=?,connection_generation=?,onboarding_interval_key=?,pause_reason=NULL,stage=CASE WHEN EXISTS(SELECT 1 FROM sync_states WHERE user_id=import_runs.user_id AND import_run_id=import_runs.id AND slice_key='recent' AND stage<>'discovery_complete') THEN 'discovering_recent' WHEN EXISTS(SELECT 1 FROM sync_states WHERE user_id=import_runs.user_id AND import_run_id=import_runs.id AND stage<>'discovery_complete') THEN 'discovering_older' ELSE 'processing' END WHERE user_id=? AND id=? AND consent_id=? AND connection_generation=? AND ${claim}`,
      [
        consentId,
        p.generation,
        p.intervalKey,
        user,
        runId,
        p.resume.consentId,
        p.resume.priorGeneration,
      ],
    );
    add(
      `UPDATE sync_states SET stage=CASE WHEN recovery_anchor IS NOT NULL THEN 'recovering' WHEN sync_kind='incremental' THEN 'idle' WHEN slice_key='older' AND EXISTS(SELECT 1 FROM sync_states recent WHERE recent.user_id=sync_states.user_id AND recent.import_run_id=sync_states.import_run_id AND recent.slice_key='recent' AND recent.stage<>'discovery_complete') THEN 'waiting_recent' ELSE 'queued' END WHERE user_id=? AND connection_id=? AND (import_run_id=? OR (sync_kind='incremental' AND run_key='live' AND slice_key='live')) AND stage LIKE 'paused%' AND ${claim}`,
      [user, p.connectionId, runId],
    );
    add(
      `UPDATE connections SET scheduling_state='active',next_sync_at=? WHERE user_id=? AND id=? AND ${claim}`,
      [now + 3600000, user, p.connectionId],
    );
  } else {
    if (!seed) throw new OnboardingError("UNAVAILABLE");
    statements.push(
      ...buildAcceptedImportStatements(db, {
        context: session.tenant,
        connectionId: p.connectionId,
        generation: p.generation,
        consentId,
        fingerprint: p.fingerprint,
        queryMode: "filtered",
        timezone: p.timezone,
        runId,
        recentId,
        olderId,
        liveId,
        seed,
        now,
        plan: planDiscoveryRange({
          startMs: p.startMs,
          cutoffMs: p.cutoffMs,
          timezone: p.timezone,
        }),
        guard: { sql: claim, values: claimValues },
        onboarding: {
          startDate: p.startDate,
          endDate: p.endDate,
          reportingCurrency: p.reportingCurrency,
          intervalKey: p.intervalKey,
        },
      }),
    );
  }
  const result = JSON.stringify({ importRunId: runId, reused: !!p.resume });
  add(
    `UPDATE onboarding_commands SET result_json=CASE WHEN EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active' AND version=? AND timezone=? AND reporting_currency=?) AND EXISTS(SELECT 1 FROM ai_settings WHERE user_id=? AND revision=? AND mode=? AND provider_id=? AND model_id=? AND config_version=? AND consent_version=? AND status='active') AND EXISTS(SELECT 1 FROM import_runs WHERE user_id=? AND id=? AND consent_id=?) AND EXISTS(SELECT 1 FROM "session" WHERE "userId"=? AND id=? AND "expiresAt">?) THEN ? ELSE NULL END,import_run_id=? WHERE user_id=? AND key_hash=? AND body_hash=? AND result_json=?`,
    [
      user,
      p.expectedProfileVersion + 1,
      p.timezone,
      p.reportingCurrency,
      user,
      p.selectedAiSettingsRevision,
      p.mode,
      p.destinationId,
      p.modelId,
      p.configVersion,
      p.policyVersion,
      user,
      runId,
      consentId,
      user,
      session.sessionId,
      now,
      result,
      runId,
    ],
  );
  if (options.remainingStatements() < statements.length + 1)
    throw new OnboardingError("UNAVAILABLE");
  try {
    await db.batch(statements);
  } catch {
    throw new OnboardingError("CONFLICT");
  }
  const stored = await db
    .prepare(
      "SELECT body_hash,result_json FROM onboarding_commands WHERE user_id=? AND key_hash=?",
    )
    .bind(user, p.keyHash)
    .first<{ body_hash: string; result_json: string }>();
  if (!stored || stored.body_hash !== p.bodyHash)
    throw new OnboardingError("CONFLICT");
  const parsed = onboardingStartResponseSchema.safeParse(
    JSON.parse(stored.result_json),
  );
  if (!parsed.success) throw new OnboardingError("CONFLICT");
  return {
    ...parsed.data,
    reused: parsed.data.reused || parsed.data.importRunId !== runId,
  };
}
