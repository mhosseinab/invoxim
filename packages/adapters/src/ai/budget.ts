import { supportedExtractionPrompt } from "@invoxim/contracts";
import {
  type AiCheckpoint,
  type AiUsage,
  type AiUsageStore,
  type ApprovedAiConfig,
  aiRunIdentityKey,
  type ClassificationUsageStore,
  EMAIL_CLASSIFICATION_VERSION,
  type EmailClassification,
  type JobLease,
  type TenantContext,
  validateEmailClassification,
  validatePersistableAiResult,
} from "@invoxim/core";
import { CLEF_DESTINATION_ID, CLEF_MODEL_ID } from "./clef-protocol";
import { buildFingerprintTuple } from "./configuration";
import type { AiPricing } from "./pricing";
export interface AiBudgetPolicy {
  readonly dailyDocuments: number;
  readonly monthlyDocuments: number;
  readonly dailyUnits: number;
  readonly monthlyUnits: number;
  readonly globalDailyUsdMicros: string;
  readonly globalMonthlyUsdMicros: string;
}
/** Identity fields wrapped around the one shared pricing shape (A5). */
export type AiPriceSnapshot = AiPricing & {
  readonly destinationId: string;
  readonly modelId: string;
  readonly configVersion: string;
  readonly policyVersion: number;
  readonly configurationDigest: string;
  readonly acceptedConfigurationDigest?: string;
};
export interface AiBudgetOptions {
  readonly lease: JobLease;
  readonly policy: AiBudgetPolicy;
  readonly pricing: ReadonlyMap<string, AiPriceSnapshot>;
  readonly clock?: () => number;
}
export type AiProbeResult =
  | { readonly status: "passed" }
  | {
      readonly status: "failed";
      readonly reason:
        | "timeout"
        | "rate-limit"
        | "invalid-key"
        | "unsupported"
        | "refusal"
        | "outage"
        | "schema"
        | "incomplete";
    };
export interface AiProbeUsageStore {
  checkpoint(input: {
    readonly config: ApprovedAiConfig;
  }): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: AiProbeResult }
  >;
  reserve(input: {
    readonly config: ApprovedAiConfig;
  }): Promise<"reserved" | "budget" | "existing">;
  authorize(input: { readonly config: ApprovedAiConfig }): Promise<boolean>;
  settle(
    input: { readonly config: ApprovedAiConfig },
    settlement: {
      readonly state: "known" | "uncertain" | "not-sent";
      readonly usage: AiUsage | null;
      readonly retryAfterMs?: number;
    },
  ): Promise<void>;
  complete(
    input: { readonly config: ApprovedAiConfig },
    result: AiProbeResult,
  ): Promise<boolean>;
}
export interface AiProbeBudgetOptions {
  readonly session: {
    readonly tenant: TenantContext;
    readonly sessionId: string;
  };
  readonly policy: AiBudgetPolicy;
  readonly pricing: ReadonlyMap<string, AiPriceSnapshot>;
  readonly clock?: () => number;
}
const MAX = 9000000000000n;
const MILLION = 1000000n;
type Settlement = {
  state: "known" | "uncertain" | "not-sent";
  usage: AiUsage | null;
  retryAfterMs?: number;
};
type Binding = { generation: number; credential_version: number };
type RunInput = {
  tenant: TenantContext;
  config: ApprovedAiConfig;
  documentId: string | null;
  contentHash: string;
  extractionVersion: string;
  runKey: string;
  attemptNumber: number;
};
type Sql = { text: string; values: unknown[] };
type BudgetOwner =
  | { kind: "extraction"; lease: JobLease }
  | {
      kind: "synthetic-test";
      session: { tenant: TenantContext; sessionId: string };
    };
function integer(value: number, positive = false): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= Number(MAX)
  );
}
function micros(value: string): bigint {
  if (!/^[0-9]{1,15}$/.test(value) || BigInt(value) > MAX)
    throw new Error("INVALID_AI_BUDGET");
  return BigInt(value);
}
function bindingNumber(value: bigint): number {
  if (value < 0n || value > MAX || !Number.isSafeInteger(Number(value)))
    throw new Error("INVALID_AI_BUDGET");
  return Number(value);
}
function ceil(value: bigint): bigint {
  return (value + MILLION - 1n) / MILLION;
}
async function digest(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Run fingerprint recipe (A1). Must stay byte-identical to configuration.ts and classifier-factory.ts. */
export async function computeRunFingerprint(input: {
  mode: "hosted" | "byok";
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
  consentId: string;
  promptVersion: string;
  classificationAuthorization: boolean;
}): Promise<string> {
  return digest(buildFingerprintTuple(input));
}
function validatePolicy(policy: AiBudgetPolicy): void {
  for (const value of [
    policy.dailyDocuments,
    policy.monthlyDocuments,
    policy.dailyUnits,
    policy.monthlyUnits,
  ])
    if (!integer(value, true)) throw new Error("INVALID_AI_BUDGET");
  micros(policy.globalDailyUsdMicros);
  micros(policy.globalMonthlyUsdMicros);
}
function validPrice(
  price: AiPriceSnapshot | undefined,
  config: ApprovedAiConfig,
): price is AiPriceSnapshot {
  if (
    !price ||
    !/^[a-f0-9]{64}$/.test(price.configurationDigest) ||
    (price.acceptedConfigurationDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(price.acceptedConfigurationDigest)) ||
    price.approved !== true ||
    price.currency !== "USD" ||
    price.destinationId !== config.destinationId ||
    price.modelId !== config.modelId ||
    !Number.isSafeInteger(price.policyVersion) ||
    price.policyVersion < 1 ||
    !Number.isFinite(Date.parse(price.checkedAt))
  )
    return false;
  try {
    if (new URL(price.source).protocol !== "https:") return false;
    for (const value of [
      price.inputUsdMicrosPerMillion,
      price.outputUsdMicrosPerMillion,
      price.otherUsdMicrosPerMillion,
    ])
      micros(value);
    return JSON.stringify(price).length <= 4096;
  } catch {
    return false;
  }
}
function upperCost(price: AiPriceSnapshot, units: number): number {
  const rate = [
    price.inputUsdMicrosPerMillion,
    price.outputUsdMicrosPerMillion,
    price.otherUsdMicrosPerMillion,
  ]
    .map(micros)
    .reduce((a, b) => (a > b ? a : b));
  return bindingNumber(ceil(BigInt(units) * rate));
}
function measured(
  usage: AiUsage | null,
  price: AiPriceSnapshot,
): { units: bigint; cost: bigint } | null {
  if (
    usage?.source !== "reported" ||
    ![usage.input, usage.output, usage.other].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    return null;
  const units =
    BigInt(usage.input) + BigInt(usage.output) + BigInt(usage.other);
  const cost = ceil(
    BigInt(usage.input) * micros(price.inputUsdMicrosPerMillion) +
      BigInt(usage.output) * micros(price.outputUsdMicrosPerMillion) +
      BigInt(usage.other) * micros(price.otherUsdMicrosPerMillion),
  );
  return { units, cost };
}
function createMeter(
  db: D1Database,
  owner: BudgetOwner,
  options: {
    policy: AiBudgetPolicy;
    pricing: ReadonlyMap<string, AiPriceSnapshot>;
    clock?: () => number;
    classificationAuthorization?: {
      config: ApprovedAiConfig;
      price: AiPriceSnapshot;
    };
  },
) {
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
    const attemptId = `${input.runKey}:${input.attemptNumber}`;
    const old = await db
      .prepare(
        `SELECT state FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attemptId, ...prepared.live.values)
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
          attemptId,
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
          attemptId,
          nonce,
          ...live.values,
        ),
    ]);
    const event = await db
      .prepare(
        `SELECT reservation_nonce FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attemptId, ...prepared.live.values)
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
        `${input.runKey}:${input.attemptNumber}`,
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
    const attemptId = `${input.runKey}:${input.attemptNumber}`;
    const event = await db
      .prepare(
        `SELECT state,reserved_units,reserved_usd_micros,price_snapshot,day_start,month_start FROM usage_events WHERE user_id=? AND attempt_id=? AND EXISTS(${prepared.live.text})`,
      )
      .bind(userId, attemptId, ...prepared.live.values)
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
          attemptId,
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
          attemptId,
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
          attemptId,
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
function extractionUsageStore(
  db: D1Database,
  options: AiBudgetOptions,
): AiUsageStore {
  const meter = createMeter(
    db,
    { kind: "extraction", lease: options.lease },
    options,
  );
  return {
    async checkpoint(input) {
      const state = await meter.checkpoint(await meter.normal(input));
      if (state.status !== "completed") return state;
      const result = validatePersistableAiResult(state.result);
      return result ? { status: "completed", result } : { status: "stale" };
    },
    async reserve(input) {
      const normalized = await meter.normal(input, input.attemptNumber);
      if (input.attemptId !== `${normalized.runKey}:${input.attemptNumber}`)
        return "budget";
      return meter.reserve(normalized);
    },
    async authorize(input) {
      const normalized = await meter.normal(input, input.attemptNumber);
      return (
        input.attemptId === `${normalized.runKey}:${input.attemptNumber}` &&
        meter.authorize(normalized)
      );
    },
    async settle(input, settlement) {
      const normalized = await meter.normal(input, input.attemptNumber);
      if (input.attemptId === `${normalized.runKey}:${input.attemptNumber}`)
        await meter.settle(normalized, settlement);
    },
    async complete(input, value) {
      const result = validatePersistableAiResult(value);
      return (
        result !== null && meter.complete(await meter.normal(input), result)
      );
    },
  };
}
function validateProbe(value: unknown): value is AiProbeResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.status === "passed"
    ? Object.keys(row).length === 1
    : row.status === "failed" &&
        Object.keys(row).length === 2 &&
        [
          "timeout",
          "rate-limit",
          "invalid-key",
          "unsupported",
          "refusal",
          "outage",
          "schema",
          "incomplete",
        ].includes(String(row.reason));
}
function probeUsageStore(
  db: D1Database,
  options: AiProbeBudgetOptions,
): AiProbeUsageStore {
  const meter = createMeter(
    db,
    { kind: "synthetic-test", session: options.session },
    options,
  );
  return {
    async checkpoint({ config }) {
      const state = await meter.checkpoint(await meter.probe(config));
      return state.status !== "completed"
        ? state
        : validateProbe(state.result)
          ? { status: "completed", result: state.result }
          : { status: "stale" };
    },
    async reserve({ config }) {
      return meter.reserve(await meter.probe(config));
    },
    async authorize({ config }) {
      return meter.authorize(await meter.probe(config));
    },
    async settle({ config }, settlement) {
      await meter.settle(await meter.probe(config), settlement);
    },
    async complete({ config }, result) {
      return (
        validateProbe(result) &&
        meter.complete(await meter.probe(config), result)
      );
    },
  };
}
export interface AiAllowance {
  readonly dailyDocumentsRemaining: number;
  readonly monthlyDocumentsRemaining: number;
  readonly dailyUnitsRemaining: number;
  readonly monthlyUnitsRemaining: number;
  readonly hostedFundingAvailable: boolean;
  readonly cooldownActive: boolean;
}
async function aiAllowance(
  db: D1Database,
  tenant: TenantContext,
  policy: AiBudgetPolicy,
  options: {
    destinationId?: string;
    modelId?: string;
    clock?: () => number;
  } = {},
): Promise<AiAllowance> {
  validatePolicy(policy);
  const now = (options.clock ?? Date.now)(),
    day = new Date(now).toISOString().slice(0, 10),
    month = day.slice(0, 7);
  const rows = (
    await db
      .prepare(
        `SELECT b.scope,b.period_kind,b.documents,b.reserved_units,b.spent_units,b.reserved_usd_micros,b.spent_usd_micros,b.blocked FROM usage_buckets b WHERE ((b.scope='tenant' AND b.owner_key=?) OR (b.scope='global' AND b.owner_key='operator')) AND ((b.period_kind='day' AND b.period_start=?) OR (b.period_kind='month' AND b.period_start=?)) AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=? AND p.status='active')`,
      )
      .bind(tenant.userId, day, month, tenant.userId)
      .all<{
        scope: string;
        period_kind: string;
        documents: number;
        reserved_units: number;
        spent_units: number;
        reserved_usd_micros: number;
        spent_usd_micros: number;
        blocked: number;
      }>()
  ).results;
  const status = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') AS active,EXISTS(SELECT 1 FROM usage_buckets WHERE scope='global' AND blocked=1) AS global_blocked,EXISTS(SELECT 1 FROM usage_events WHERE user_id=? AND state='overrun') AS overrun,EXISTS(SELECT 1 FROM usage_events WHERE user_id=? AND destination_id=? AND model_id=? AND cooldown_until>?) OR EXISTS(SELECT 1 FROM hosted_ai_cooldowns hc JOIN ai_settings s ON s.user_id=? AND s.mode='hosted' AND s.provider_id=hc.destination_id AND s.model_id=hc.model_id WHERE hc.destination_id=? AND hc.model_id=? AND hc.cooldown_until>?) AS cooldown`,
    )
    .bind(
      tenant.userId,
      tenant.userId,
      tenant.userId,
      options.destinationId ?? "",
      options.modelId ?? "",
      now,
      tenant.userId,
      options.destinationId ?? "",
      options.modelId ?? "",
      now,
    )
    .first<{
      active: number;
      cooldown: number;
      overrun: number;
      global_blocked: number;
    }>();
  const daily = rows.find(
      (r) => r.scope === "tenant" && r.period_kind === "day",
    ),
    monthly = rows.find(
      (r) => r.scope === "tenant" && r.period_kind === "month",
    );
  function remainder(
    limit: number,
    row: typeof daily,
    field: "documents" | "units",
  ): number {
    return !status?.active || status.overrun || row?.blocked
      ? 0
      : Math.max(
          0,
          limit -
            (field === "documents"
              ? (row?.documents ?? 0)
              : (row?.reserved_units ?? 0) + (row?.spent_units ?? 0)),
        );
  }
  const funding = ["day", "month"].every((kind) => {
    const row = rows.find(
      (r) => r.scope === "global" && r.period_kind === kind,
    );
    const limit = micros(
      kind === "day"
        ? policy.globalDailyUsdMicros
        : policy.globalMonthlyUsdMicros,
    );
    return (
      !row?.blocked &&
      limit >
        BigInt(row?.reserved_usd_micros ?? 0) +
          BigInt(row?.spent_usd_micros ?? 0)
    );
  });
  return {
    dailyDocumentsRemaining: remainder(
      policy.dailyDocuments,
      daily,
      "documents",
    ),
    monthlyDocumentsRemaining: remainder(
      policy.monthlyDocuments,
      monthly,
      "documents",
    ),
    dailyUnitsRemaining: remainder(policy.dailyUnits, daily, "units"),
    monthlyUnitsRemaining: remainder(policy.monthlyUnits, monthly, "units"),
    hostedFundingAvailable:
      status?.active === 1 &&
      !status.overrun &&
      !status.global_blocked &&
      funding,
    cooldownActive: status?.cooldown === 1,
  };
}

async function budgetOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("AI_BUDGET_UNAVAILABLE");
  }
}
export interface ClassificationBudgetOptions extends AiBudgetOptions {
  readonly authorization: {
    readonly config: ApprovedAiConfig;
    readonly price: AiPriceSnapshot;
  };
}
export function createClassificationUsageStore(
  db: D1Database,
  options: ClassificationBudgetOptions,
): ClassificationUsageStore {
  const meter = createMeter(
    db,
    { kind: "extraction", lease: options.lease },
    { ...options, classificationAuthorization: options.authorization },
  );
  return {
    async checkpoint(input) {
      return budgetOperation(async () => {
        const state = await meter.checkpoint(await meter.normal(input));
        if (state.status !== "completed") return state;
        const result = validateEmailClassification(state.result);
        return result
          ? { status: "completed" as const, result }
          : { status: "stale" as const };
      });
    },
    reserve: (input) =>
      budgetOperation(async () => {
        const normalized = await meter.normal(input, input.attemptNumber);
        return input.attemptId === `${normalized.runKey}:${input.attemptNumber}`
          ? meter.reserve(normalized)
          : "budget";
      }),
    authorize: (input) =>
      budgetOperation(async () => {
        const normalized = await meter.normal(input, input.attemptNumber);
        return (
          input.attemptId === `${normalized.runKey}:${input.attemptNumber}` &&
          meter.authorize(normalized)
        );
      }),
    settle: (input, settlement) =>
      budgetOperation(async () => {
        const normalized = await meter.normal(input, input.attemptNumber);
        if (input.attemptId === `${normalized.runKey}:${input.attemptNumber}`)
          await meter.settle(normalized, settlement);
      }),
    complete: (input, value: EmailClassification) =>
      budgetOperation(async () => {
        const result = validateEmailClassification(value);
        return (
          result !== null && meter.complete(await meter.normal(input), result)
        );
      }),
  };
}
export function createAiUsageStore(
  db: D1Database,
  options: AiBudgetOptions,
): AiUsageStore {
  const store = extractionUsageStore(db, options);
  return {
    checkpoint: (input) => budgetOperation(() => store.checkpoint(input)),
    reserve: (input) => budgetOperation(() => store.reserve(input)),
    authorize: (input) => budgetOperation(() => store.authorize(input)),
    settle: (input, value) => budgetOperation(() => store.settle(input, value)),
    complete: (input, value) =>
      budgetOperation(() => store.complete(input, value)),
  };
}
export function createAiProbeUsageStore(
  db: D1Database,
  options: AiProbeBudgetOptions,
): AiProbeUsageStore {
  const store = probeUsageStore(db, options);
  return {
    checkpoint: (input) => budgetOperation(() => store.checkpoint(input)),
    reserve: (input) => budgetOperation(() => store.reserve(input)),
    authorize: (input) => budgetOperation(() => store.authorize(input)),
    settle: (input, value) => budgetOperation(() => store.settle(input, value)),
    complete: (input, value) =>
      budgetOperation(() => store.complete(input, value)),
  };
}
export function readAiAllowance(
  db: D1Database,
  tenant: TenantContext,
  policy: AiBudgetPolicy,
  options: {
    destinationId?: string;
    modelId?: string;
    clock?: () => number;
  } = {},
): Promise<AiAllowance> {
  return budgetOperation(() => aiAllowance(db, tenant, policy, options));
}
