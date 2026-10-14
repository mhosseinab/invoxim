import { supportedExtractionPrompt } from "@invoxim/contracts";
import {
  type AiCheckpoint,
  type ApprovedAiConfig,
  aiRunIdentityKey,
  EMAIL_CLASSIFICATION_VERSION,
} from "@invoxim/core";
import {
  attemptId,
  bindingNumber,
  computeRunFingerprint,
  digest,
  integer,
  MAX,
  measured,
  micros,
  upperCost,
  validatePolicy,
  validPrice,
} from "./budget-helpers";
import type {
  AiPriceSnapshot,
  Binding,
  BudgetOwner,
  MeterOptions,
  RunInput,
  Settlement,
  Sql,
} from "./budget-types";
import { CLEF_DESTINATION_ID, CLEF_MODEL_ID } from "./clef-protocol";

export type Meter = {
  checkpoint(
    input: RunInput,
  ): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: unknown }
  >;
  reserve(input: RunInput): Promise<"reserved" | "budget" | "existing">;
  authorize(input: RunInput): Promise<boolean>;
  settle(input: RunInput, settlement: Settlement): Promise<void>;
  complete(input: RunInput, result: unknown): Promise<boolean>;
  normal(input: AiCheckpoint, attemptNumber?: number): Promise<RunInput>;
  probe(config: ApprovedAiConfig): Promise<RunInput>;
};

export function createMeter(
  db: D1Database,
  owner: BudgetOwner,
  options: MeterOptions,
): Meter {
  validatePolicy(options.policy);
  const clock = options.clock ?? Date.now;
  const bindings = new Map<string, Binding>();
  const probeInputs = new Map<string, RunInput>();
  const userId =
    owner.kind === "extraction"
      ? owner.lease.context.userId
      : owner.session.tenant.userId;
  const sessionId =
    owner.kind === "synthetic-test" ? owner.session.sessionId : null;
  function guard(
    input: RunInput,
    price: AiPriceSnapshot,
    captured?: Binding,
  ): Sql {
    const authorityConfig =
      options.classificationAuthorization?.config ?? input.config;
    const authorityPrice = options.classificationAuthorization?.price ?? price;
    const text = `SELECT s.generation,s.credential_version FROM ai_settings s JOIN profiles p ON p.user_id=s.user_id WHERE s.user_id=? AND p.status='active' AND s.status='active' AND s.mode=? AND s.provider_id=? AND s.model_id=? AND s.config_version=? AND s.revision=? AND s.consent_version=? AND (s.mode='hosted' OR (s.encrypted_key IS NOT NULL AND s.key_version IS NOT NULL))`;
    const values: unknown[] = [
      userId,
      authorityConfig.mode,
      authorityConfig.destinationId,
      authorityConfig.modelId,
      authorityPrice.configVersion,
      authorityConfig.settingsRevision,
      authorityPrice.policyVersion,
    ];
    let additional = "";
    if (captured) {
      additional += " AND s.generation=? AND s.credential_version=?";
      values.push(captured.generation, captured.credential_version);
    }
    if (owner.kind === "synthetic-test") {
      additional +=
        ' AND EXISTS(SELECT 1 FROM "session" se WHERE se.userId=s.user_id AND se.id=? AND se.expiresAt>?)';
      values.push(sessionId, clock());
    } else {
      const lease = owner.lease;
      additional += ` AND EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id JOIN discovery_source_jobs dj ON dj.user_id=j.user_id AND dj.job_id=j.id JOIN source_messages sm ON sm.user_id=dj.user_id AND sm.id=dj.source_message_id JOIN documents d ON d.user_id=sm.user_id AND d.source_message_id=sm.id WHERE j.user_id=s.user_id AND j.id=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.connection_generation=? AND j.connection_id=? AND j.consent_id=? AND j.type IN ('source-extract','reprocess') AND c.state='connected' AND c.generation=j.connection_generation AND c.scheduling_state='active' AND pc.revoked_at IS NULL AND pc.accepted_at<=? AND pc.background_authorized=1 AND pc.ai_settings_revision=s.revision AND pc.inference_destination=s.provider_id AND pc.disclosure_version=? AND sm.connection_id=c.id AND sm.generation=c.generation AND sm.available=1 AND d.id=? AND d.content_hash=?${authorityPrice.acceptedConfigurationDigest ? " AND pc.accepted_configuration_digest=?" : ""})`;
      values.push(
        lease.jobId,
        lease.leaseId,
        lease.fence,
        clock(),
        lease.generation,
        lease.connectionId,
        lease.consentId,
        clock(),
        authorityPrice.policyVersion,
        input.documentId,
        input.contentHash,
        ...(authorityPrice.acceptedConfigurationDigest
          ? [authorityPrice.acceptedConfigurationDigest]
          : []),
      );
    }
    return { text: text + additional, values };
  }
  async function prepare(
    input: RunInput,
    cache = false,
  ): Promise<{
    price: AiPriceSnapshot;
    binding: Binding;
    live: Sql;
    cachedResult?: {
      result_json: string | null;
      cache_generation: number | null;
      cache_credential_version: number | null;
    };
  } | null> {
    if (
      input.tenant.userId !== userId ||
      !integer(input.config.reservationUnits, true) ||
      !integer(input.config.settingsRevision, true) ||
      !(options.classificationAuthorization
        ? input.config.promptVersion === EMAIL_CLASSIFICATION_VERSION &&
          input.config.mode === "hosted" &&
          input.config.destinationId === CLEF_DESTINATION_ID &&
          input.config.modelId === CLEF_MODEL_ID &&
          options.classificationAuthorization.config.settingsRevision ===
            input.config.settingsRevision &&
          options.classificationAuthorization.config.consentId ===
            input.config.consentId
        : supportedExtractionPrompt(input.config.promptVersion)) ||
      input.config.schemaVersion !== 1 ||
      input.runKey.length !== 64 ||
      input.contentHash.length > 128 ||
      input.extractionVersion.length > 120
    )
      return null;
    if (
      owner.kind === "synthetic-test" &&
      (input.tenant.authority !== "session" ||
        input.config.consentId !== "synthetic-test")
    )
      return null;
    if (
      owner.kind === "extraction" &&
      (input.tenant.authority !== "job" ||
        input.config.consentId !== owner.lease.consentId)
    )
      return null;
    if (
      input.config.mode === "hosted" &&
      (micros(options.policy.globalDailyUsdMicros) === 0n ||
        micros(options.policy.globalMonthlyUsdMicros) === 0n)
    )
      return null;
    const price = options.pricing.get(input.config.fingerprint);
    if (!validPrice(price, input.config)) return null;
    const saved = bindings.get(input.runKey);
    const live = guard(input, price, saved);
    const row =
      cache || !saved
        ? await db
            .prepare(
              cache
                ? `SELECT live.generation,live.credential_version,e.result_json,e.generation AS cache_generation,e.credential_version AS cache_credential_version FROM (${live.text}) live LEFT JOIN ai_extractions e ON e.user_id=? AND e.run_key=?`
                : live.text,
            )
            .bind(...live.values, ...(cache ? [userId, input.runKey] : []))
            .first<
              Binding & {
                result_json: string | null;
                cache_generation: number | null;
                cache_credential_version: number | null;
              }
            >()
        : null;
    const binding = cache ? row : (saved ?? row);
    if (!binding) return null;
    const fingerprint = await computeRunFingerprint({
      mode: input.config.mode,
      configurationDigest: price.configurationDigest,
      settingsRevision: input.config.settingsRevision,
      generation: binding.generation,
      credentialVersion: binding.credential_version,
      policyVersion: price.policyVersion,
      consentId: input.config.consentId,
      promptVersion: input.config.promptVersion,
      classificationAuthorization: Boolean(options.classificationAuthorization),
    });
    if (fingerprint !== input.config.fingerprint) return null;
    bindings.set(input.runKey, binding);
    return {
      price,
      binding,
      live: guard(input, price, binding),
      ...(cache && row ? { cachedResult: row } : {}),
    };
  }
  async function checkpoint(
    input: RunInput,
  ): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: unknown }
  > {
    const prepared = await prepare(input, true);
    if (!prepared) return { status: "stale" };
    const row = prepared.cachedResult;
    if (
      !row ||
      (row.cache_generation !== null &&
        (row.cache_generation !== prepared.binding.generation ||
          row.cache_credential_version !== prepared.binding.credential_version))
    )
      return { status: "stale" };
    return row?.result_json
      ? { status: "completed", result: JSON.parse(row.result_json) }
      : { status: "ready" };
  }
  function quota(
    input: RunInput,
    day: string,
    month: string,
    cost: number,
  ): Sql {
    const p = options.policy;
    return {
      text: `NOT EXISTS(SELECT 1 FROM usage_buckets b WHERE ((b.scope='tenant' AND b.owner_key=?) OR (b.scope='global' AND b.owner_key='operator' AND ?='hosted')) AND ((b.period_kind='day' AND b.period_start=?) OR (b.period_kind='month' AND b.period_start=?)) AND (b.blocked=1 OR (b.scope='tenant' AND (b.documents+CASE WHEN EXISTS(SELECT 1 FROM ai_extractions e WHERE e.user_id=? AND e.run_key=?) THEN 0 ELSE ${options.classificationAuthorization ? 0 : 1} END>CASE b.period_kind WHEN 'day' THEN ? ELSE ? END OR b.reserved_units+b.spent_units+?>CASE b.period_kind WHEN 'day' THEN ? ELSE ? END)) OR (b.scope='global' AND b.reserved_usd_micros+b.spent_usd_micros+?>CASE b.period_kind WHEN 'day' THEN ? ELSE ? END))) AND NOT EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.destination_id=? AND ev.model_id=? AND ev.cooldown_until>?) AND NOT EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.state='overrun') AND NOT EXISTS(SELECT 1 FROM usage_buckets gb WHERE gb.scope='global' AND gb.blocked=1 AND ?='hosted') AND NOT EXISTS(SELECT 1 FROM hosted_ai_cooldowns hc WHERE hc.destination_id=? AND hc.model_id=? AND hc.cooldown_until>? AND ?='hosted')`,
      values: [
        userId,
        input.config.mode,
        day,
        month,
        userId,
        input.runKey,
        p.dailyDocuments,
        p.monthlyDocuments,
        input.config.reservationUnits,
        p.dailyUnits,
        p.monthlyUnits,
        cost,
        bindingNumber(micros(p.globalDailyUsdMicros)),
        bindingNumber(micros(p.globalMonthlyUsdMicros)),
        userId,
        input.config.destinationId,
        input.config.modelId,
        clock(),
        userId,
        input.config.mode,
        input.config.destinationId,
        input.config.modelId,
        clock(),
        input.config.mode,
      ],
    };
  }
  async function reserve(
    input: RunInput,
  ): Promise<"reserved" | "budget" | "existing"> {
    const prepared = await prepare(input);
    if (!prepared) return "budget";
    if (
      input.attemptNumber < 1 ||
      input.attemptNumber > input.config.maxAttempts
    )
      return "budget";
    const attempt = attemptId(input.runKey, input.attemptNumber);
    const old = await db
      .prepare(
        `SELECT state FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attempt, ...prepared.live.values)
      .first();
    if (old) return "existing";
    const now = clock(),
      day = new Date(now).toISOString().slice(0, 10),
      month = day.slice(0, 7),
      nonce = crypto.randomUUID();
    let cost = 0;
    try {
      if (input.config.mode === "hosted")
        cost = upperCost(prepared.price, input.config.reservationUnits);
    } catch {
      return "budget";
    }
    const { live, binding } = prepared;
    const cap = quota(input, day, month, cost);
    const livePredicate = `EXISTS(${live.text})`;
    const previous =
      input.attemptNumber === 1
        ? { text: "1", values: [] }
        : {
            text: `EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.run_key=? AND ev.attempt_number=1 AND ev.state='known')`,
            values: [userId, input.runKey],
          };
    const admitted = `${livePredicate} AND ${cap.text} AND ${previous.text}`;
    const conditionValues = [...live.values, ...cap.values, ...previous.values];
    await db.batch([
      db
        .prepare(
          `INSERT INTO usage_buckets(scope,owner_key,user_id,period_kind,period_start) SELECT scope,owner_key,user_id,period_kind,period_start FROM (SELECT 'tenant' AS scope,? AS owner_key,? AS user_id,'day' AS period_kind,? AS period_start UNION ALL SELECT 'tenant',?,?,'month',? UNION ALL SELECT 'global','operator',NULL,'day',? UNION ALL SELECT 'global','operator',NULL,'month',?) WHERE ${livePredicate} ON CONFLICT DO NOTHING`,
        )
        .bind(
          userId,
          userId,
          day,
          userId,
          userId,
          month,
          day,
          month,
          ...live.values,
        ),
      db
        .prepare(
          `INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,session_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${admitted} ON CONFLICT DO NOTHING`,
        )
        .bind(
          userId,
          input.runKey,
          owner.kind,
          input.documentId,
          sessionId,
          input.contentHash,
          input.extractionVersion,
          input.config.fingerprint,
          input.config.mode,
          input.config.destinationId,
          input.config.modelId,
          prepared.price.configVersion,
          input.config.settingsRevision,
          binding.generation,
          binding.credential_version,
          nonce,
          now,
          ...conditionValues,
        ),
      db
        .prepare(
          `INSERT INTO usage_events(user_id,attempt_id,run_key,attempt_number,purpose,job_id,session_id,mode,destination_id,model_id,price_snapshot,day_start,month_start,reserved_units,reserved_usd_micros,state,reservation_nonce,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,? WHERE ${admitted} AND EXISTS(SELECT 1 FROM ai_extractions e WHERE e.user_id=? AND e.run_key=? AND e.result_json IS NULL AND e.generation=? AND e.credential_version=?) ON CONFLICT DO NOTHING`,
        )
        .bind(
          userId,
          attempt,
          input.runKey,
          input.attemptNumber,
          owner.kind,
          owner.kind === "extraction" ? owner.lease.jobId : null,
          sessionId,
          input.config.mode,
          input.config.destinationId,
          input.config.modelId,
          JSON.stringify(prepared.price),
          day,
          month,
          input.config.reservationUnits,
          cost,
          nonce,
          now,
          ...conditionValues,
          userId,
          input.runKey,
          binding.generation,
          binding.credential_version,
        ),
      db
        .prepare(
          `UPDATE usage_buckets SET documents=documents+CASE WHEN scope='tenant' AND EXISTS(SELECT 1 FROM ai_extractions e WHERE e.user_id=? AND e.run_key=? AND e.reservation_nonce=?) THEN ${options.classificationAuthorization ? 0 : 1} ELSE 0 END,reserved_units=reserved_units+CASE WHEN scope='tenant' THEN ? ELSE 0 END,reserved_usd_micros=reserved_usd_micros+CASE WHEN scope='global' THEN ? ELSE 0 END WHERE ((scope='tenant' AND owner_key=?) OR (scope='global' AND owner_key='operator')) AND ((period_kind='day' AND period_start=?) OR (period_kind='month' AND period_start=?)) AND EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.attempt_id=? AND ev.reservation_nonce=?) AND ${livePredicate}`,
        )
        .bind(
          userId,
          input.runKey,
          nonce,
          input.config.reservationUnits,
          cost,
          userId,
          day,
          month,
          userId,
          attempt,
          nonce,
          ...live.values,
        ),
    ]);
    const event = await db
      .prepare(
        `SELECT reservation_nonce FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attempt, ...prepared.live.values)
      .first<{ reservation_nonce: string }>();
    return event
      ? event.reservation_nonce === nonce
        ? "reserved"
        : "existing"
      : "budget";
  }
  async function authorize(input: RunInput): Promise<boolean> {
    const prepared = await prepare(input);
    if (!prepared) return false;
    const result = await db
      .prepare(
        `UPDATE usage_events SET state='sent' WHERE user_id=? AND attempt_id=? AND state='reserved' AND NOT EXISTS(SELECT 1 FROM hosted_ai_cooldowns hc WHERE hc.destination_id=usage_events.destination_id AND hc.model_id=usage_events.model_id AND hc.cooldown_until>? AND usage_events.mode='hosted') AND NOT EXISTS(SELECT 1 FROM usage_buckets gb WHERE gb.scope='global' AND gb.blocked=1 AND usage_events.mode='hosted') AND NOT EXISTS(SELECT 1 FROM usage_events ov WHERE ov.user_id=usage_events.user_id AND ov.state='overrun') AND EXISTS(${prepared.live.text}) AND NOT EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.destination_id=? AND ev.model_id=? AND ev.cooldown_until>?)`,
      )
      .bind(
        userId,
        attemptId(input.runKey, input.attemptNumber),
        clock(),
        ...prepared.live.values,
        userId,
        input.config.destinationId,
        input.config.modelId,
        clock(),
      )
      .run();
    return result.meta.changes === 1;
  }
  async function settle(
    input: RunInput,
    settlement: Settlement,
  ): Promise<void> {
    const prepared = await prepare(input);
    if (!prepared) return;
    const attempt = attemptId(input.runKey, input.attemptNumber);
    const event = await db
      .prepare(
        `SELECT state,reserved_units,reserved_usd_micros,price_snapshot,day_start,month_start FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attempt, ...prepared.live.values)
      .first<{
        state: string;
        reserved_units: number;
        reserved_usd_micros: number;
        price_snapshot: string;
        day_start: string;
        month_start: string;
      }>();
    if (!event || !["reserved", "sent", "uncertain"].includes(event.state))
      return;
    const price = JSON.parse(event.price_snapshot) as AiPriceSnapshot;
    const observed = measured(settlement.usage, price);
    const actualCost =
      input.config.mode === "hosted" ? (observed?.cost ?? 0n) : 0n;
    const overrun =
      observed !== null &&
      (observed.units > BigInt(event.reserved_units) ||
        actualCost > BigInt(event.reserved_usd_micros));
    const notSent =
      settlement.state === "not-sent" && event.state === "reserved";
    const known = settlement.state === "known" && observed !== null && !overrun;
    const state = overrun
      ? "overrun"
      : notSent
        ? "not-sent"
        : known
          ? "known"
          : "uncertain";
    const extraordinary =
      observed !== null && (observed.units > MAX || actualCost > MAX);
    const reconciled = (overrun || known || notSent) && !extraordinary;
    const chargedUnits =
      notSent || extraordinary
        ? 0
        : bindingNumber(
            overrun && observed
              ? observed.units > BigInt(event.reserved_units)
                ? observed.units
                : BigInt(event.reserved_units)
              : (observed?.units ?? 0n),
          );
    const chargedCost =
      notSent || extraordinary
        ? 0
        : bindingNumber(
            overrun && actualCost < BigInt(event.reserved_usd_micros)
              ? BigInt(event.reserved_usd_micros)
              : actualCost,
          );
    const nonce = crypto.randomUUID(),
      now = clock();
    const cooldown =
      settlement.retryAfterMs !== undefined &&
      Number.isSafeInteger(settlement.retryAfterMs) &&
      settlement.retryAfterMs >= 0
        ? settlement.retryAfterMs > 86400000
          ? 253402300799999
          : now + settlement.retryAfterMs
        : null;
    await db.batch([
      db
        .prepare(
          `UPDATE usage_events SET state=?,actual_units=?,actual_usd_micros=?,usage_json=?,settled_at=?,settlement_nonce=?,cooldown_until=MAX(COALESCE(cooldown_until,0),COALESCE(?,0)) WHERE user_id=? AND attempt_id=? AND state=? AND EXISTS(${prepared.live.text})`,
        )
        .bind(
          state,
          observed?.units.toString() ?? null,
          observed ? actualCost.toString() : null,
          observed ? JSON.stringify(settlement.usage) : null,
          now,
          nonce,
          cooldown,
          userId,
          attempt,
          event.state,
          ...prepared.live.values,
        ),
      db
        .prepare(
          `UPDATE usage_buckets SET reserved_units=reserved_units-CASE WHEN scope='tenant' AND spent_units<=9000000000000-? THEN ? ELSE 0 END,spent_units=spent_units+CASE WHEN scope='tenant' AND spent_units<=9000000000000-? THEN ? ELSE 0 END,reserved_usd_micros=reserved_usd_micros-CASE WHEN scope='global' AND spent_usd_micros<=9000000000000-? THEN ? ELSE 0 END,spent_usd_micros=spent_usd_micros+CASE WHEN scope='global' AND spent_usd_micros<=9000000000000-? THEN ? ELSE 0 END,blocked=MAX(blocked,CASE WHEN scope='tenant' OR ?='hosted' THEN ? ELSE 0 END) WHERE ((scope='tenant' AND owner_key=?) OR (scope='global' AND owner_key='operator')) AND ((period_kind='day' AND period_start=?) OR (period_kind='month' AND period_start=?)) AND EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.attempt_id=? AND ev.settlement_nonce=?) AND EXISTS(${prepared.live.text})`,
        )
        .bind(
          chargedUnits,
          reconciled ? event.reserved_units : 0,
          chargedUnits,
          reconciled ? chargedUnits : 0,
          chargedCost,
          reconciled ? event.reserved_usd_micros : 0,
          chargedCost,
          reconciled ? chargedCost : 0,
          input.config.mode,
          overrun ? 1 : 0,
          userId,
          event.day_start,
          event.month_start,
          userId,
          attempt,
          nonce,
          ...prepared.live.values,
        ),
      db
        .prepare(
          `INSERT INTO hosted_ai_cooldowns(destination_id,model_id,cooldown_until) SELECT ?,?,? WHERE ?='hosted' AND ? IS NOT NULL AND EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.attempt_id=? AND ev.settlement_nonce=?) AND EXISTS(${prepared.live.text}) ON CONFLICT(destination_id,model_id) DO UPDATE SET cooldown_until=MAX(hosted_ai_cooldowns.cooldown_until,excluded.cooldown_until)`,
        )
        .bind(
          input.config.destinationId,
          input.config.modelId,
          cooldown,
          input.config.mode,
          cooldown,
          userId,
          attempt,
          nonce,
          ...prepared.live.values,
        ),
    ]);
  }
  async function complete(input: RunInput, result: unknown): Promise<boolean> {
    const prepared = await prepare(input);
    if (!prepared) return false;
    const json = JSON.stringify(result);
    if (new TextEncoder().encode(json).byteLength > 65536) return false;
    const res = await db
      .prepare(
        `UPDATE ai_extractions SET result_json=?,completed_at=? WHERE user_id=? AND run_key=? AND result_json IS NULL AND generation=? AND credential_version=? AND EXISTS(${prepared.live.text}) AND EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.run_key=? AND ev.state IN ('known','uncertain')) AND NOT EXISTS(SELECT 1 FROM usage_events ev WHERE ev.user_id=? AND ev.run_key=? AND ev.state IN ('reserved','sent','overrun'))`,
      )
      .bind(
        json,
        clock(),
        userId,
        input.runKey,
        prepared.binding.generation,
        prepared.binding.credential_version,
        ...prepared.live.values,
        userId,
        input.runKey,
        userId,
        input.runKey,
      )
      .run();
    return res.meta.changes === 1;
  }
  async function normal(
    input: AiCheckpoint,
    attemptNumber = 1,
  ): Promise<RunInput> {
    return {
      tenant: input.tenant,
      config: input.config,
      documentId: input.identity.documentId,
      contentHash: input.identity.contentHash,
      extractionVersion: input.identity.extractionVersion,
      runKey: await aiRunIdentityKey(input),
      attemptNumber,
    };
  }
  async function probe(config: ApprovedAiConfig): Promise<RunInput> {
    const prior = probeInputs.get(config.fingerprint);
    if (prior) return { ...prior, config };
    const initial = await db
      .prepare(
        "SELECT generation,credential_version FROM ai_settings WHERE user_id=?",
      )
      .bind(userId)
      .first<Binding>();
    const runKey = await digest([
      userId,
      config.settingsRevision,
      initial?.generation,
      initial?.credential_version,
      config.fingerprint,
      "synthetic-ai-test-v1",
    ]);
    const input: RunInput = {
      tenant:
        owner.kind === "synthetic-test"
          ? owner.session.tenant
          : owner.lease.context,
      config,
      documentId: null,
      contentHash: "synthetic-ai-test-v1",
      extractionVersion: "synthetic-ai-test-v1",
      runKey,
      attemptNumber: 1,
    };
    probeInputs.set(config.fingerprint, input);
    return input;
  }
  return { checkpoint, reserve, authorize, settle, complete, normal, probe };
}
