import {
  aiKeyDeleteRequestSchema,
  aiSettingsRequestSchema,
  aiSettingsResponseSchema,
  aiTestRequestSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import type { z } from "zod";
import { readEnvelopeVersion } from "../security/cipher";
import { readAiAllowance } from "./budget";
import type { AiConfiguration } from "./configuration";

export {
  aiKeyDeleteRequestSchema,
  aiSettingsRequestSchema,
  aiTestRequestSchema,
};
export class AiSettingsError extends Error {
  constructor(
    readonly code:
      | "UNAUTHORIZED"
      | "INVALID_REQUEST"
      | "CONFLICT"
      | "UNAVAILABLE"
      | "BUDGET",
  ) {
    super(code);
    this.name = "AiSettingsError";
  }
}
export interface StoredAiSettings {
  revision: number;
  mode: "hosted" | "byok" | null;
  provider_id: string | null;
  model_id: string | null;
  config_version: string | null;
  consent_version: number;
  encrypted_key: string | null;
  key_version: number | null;
  credential_version: number;
  generation: number;
  status: string;
}
/** Settings and dependent authorization change in one D1 batch, with CAS last. */
export function createAiSettingsService(
  db: D1Database,
  configuration: AiConfiguration,
) {
  async function current(
    context: TenantContext,
  ): Promise<StoredAiSettings | null> {
    const row = await db
      .prepare(
        "SELECT p.user_id,a.* FROM profiles p LEFT JOIN ai_settings a ON a.user_id=p.user_id WHERE p.user_id=? AND p.status='active'",
      )
      .bind(context.userId)
      .first<StoredAiSettings & { user_id: string }>();
    if (!row) throw new AiSettingsError("UNAUTHORIZED");
    return row.revision === null || row.revision === undefined ? null : row;
  }
  async function get(context: TenantContext) {
    const row = await current(context);
    const destination = configuration.destinations.find(
      (entry) => entry.id === row?.provider_id,
    );
    const model = destination?.models.find(
      (entry) => entry.id === row?.model_id,
    );
    let usableKey = false;
    try {
      usableKey = Boolean(
        row?.encrypted_key &&
        row.key_version &&
        row.key_version === readEnvelopeVersion(row.encrypted_key) &&
        configuration.keyVersions.includes(row.key_version),
      );
    } catch {
      usableKey = false;
    }
    const destinationReady =
      row?.mode === "byok"
        ? usableKey
        : row?.mode === "hosted" &&
          configuration.hosted?.destinationId === row.provider_id &&
          configuration.hosted.modelId === row.model_id;
    const configured = Boolean(
      row &&
      row.status === "active" &&
      destination &&
      model &&
      destination.configVersion === row.config_version &&
      destination.policyVersion === row.consent_version &&
      destinationReady,
    );
    const allowance = await readAiAllowance(db, context, configuration.budget, {
      ...(row?.provider_id ? { destinationId: row.provider_id } : {}),
      ...(row?.model_id ? { modelId: row.model_id } : {}),
    });
    const resourceBudget =
      allowance.dailyDocumentsRemaining > 0 &&
      allowance.monthlyDocumentsRemaining > 0 &&
      allowance.dailyUnitsRemaining > 0 &&
      allowance.monthlyUnitsRemaining > 0;
    const availability = !configured
      ? "configuration"
      : !resourceBudget ||
          (row?.mode === "hosted" && !allowance.hostedFundingAvailable)
        ? "budget"
        : allowance.cooldownActive
          ? "rate-limit"
          : "processing-review-required";
    return aiSettingsResponseSchema.parse({
      version: row?.revision ?? 0,
      mode: row?.mode ?? null,
      providerId: row?.provider_id ?? null,
      modelId: row?.model_id ?? null,
      keyConfigured: Boolean(
        row?.status === "active" && row.encrypted_key && row.mode === "byok",
      ),
      processingReviewRequired: true as const,
      configured,
      allowance,
      availability,
      capabilities: {
        text: true as const,
        image: false as const,
        nativePdf: false as const,
        jsonSchema: configured
          ? (model?.capabilities.jsonSchema ?? false)
          : false,
        jsonObject: configured
          ? (model?.capabilities.jsonObject ?? false)
          : false,
      },
      providers: configuration.destinations.map((entry) => ({
        id: entry.id,
        models: entry.models.map((candidate) => candidate.id),
        policyVersion: entry.policyVersion,
        noticeRefs: entry.noticeRefs,
      })),
    });
  }
  function guard(
    context: TenantContext,
    expected: number,
    row: StoredAiSettings | null,
  ) {
    return {
      sql: "EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') AND ((NOT EXISTS(SELECT 1 FROM ai_settings WHERE user_id=?) AND ?=0) OR EXISTS(SELECT 1 FROM ai_settings WHERE user_id=? AND revision=? AND revision<2147483646 AND generation=? AND credential_version=?))",
      values: [
        context.userId,
        context.userId,
        expected,
        context.userId,
        expected,
        row?.generation ?? 1,
        row?.credential_version ?? 0,
      ],
    };
  }
  async function commit(
    context: TenantContext,
    row: StoredAiSettings | null,
    expected: number,
    last: D1PreparedStatement,
  ) {
    const owned = guard(context, expected, row);
    const now = Date.now();
    const statements = [
      db
        .prepare(
          `UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${owned.sql}`,
        )
        .bind(now, context.userId, ...owned.values),
      db
        .prepare(
          `UPDATE jobs SET status='paused_auth',outcome_code='settings-changed',lease_id=NULL,lease_expires_at=NULL,fence=fence+1 WHERE user_id=? AND status IN ('ready','retry_wait','leased') AND fence<9007199254740991 AND ${owned.sql}`,
        )
        .bind(context.userId, ...owned.values),
      db
        .prepare(
          `UPDATE connections SET scheduling_state='paused',next_sync_at=NULL WHERE user_id=? AND kind='mailbox' AND scheduling_state='active' AND ${owned.sql}`,
        )
        .bind(context.userId, ...owned.values),
      last,
    ];
    const results = await db.batch(statements);
    if (results[results.length - 1]?.meta.changes !== 1)
      throw new AiSettingsError("CONFLICT");
    return get(context);
  }
  async function save(
    context: TenantContext,
    input: z.infer<typeof aiSettingsRequestSchema>,
  ) {
    const parsed = aiSettingsRequestSchema.safeParse(input);
    if (!parsed.success) throw new AiSettingsError("INVALID_REQUEST");
    input = parsed.data;
    const destination = configuration.destinations.find(
      (entry) => entry.id === input.providerId,
    );
    const model = destination?.models.find(
      (entry) => entry.id === input.modelId,
    );
    if (
      !destination ||
      !model ||
      input.acceptedPolicyVersion !== destination.policyVersion ||
      (input.mode === "hosted" &&
        (input.apiKey !== undefined ||
          configuration.hosted?.destinationId !== input.providerId ||
          configuration.hosted.modelId !== input.modelId))
    )
      throw new AiSettingsError("INVALID_REQUEST");
    const row = await current(context);
    if (
      (row?.revision ?? 0) !== input.version ||
      input.version >= 2147483646 ||
      (row?.key_version ?? 0) > configuration.cipher.activeVersion
    )
      throw new AiSettingsError("CONFLICT");
    let envelope: string | null = null,
      keyVersion: number | null = null;
    if (input.mode === "byok") {
      if (input.apiKey !== undefined) {
        envelope = await configuration.cipher.seal(
          context,
          { entityId: "primary", purpose: "byok-key" },
          { key: input.apiKey },
        );
        keyVersion = configuration.cipher.activeVersion;
      } else if (
        row?.mode === "byok" &&
        row.status === "active" &&
        row.provider_id === input.providerId &&
        row.encrypted_key
      ) {
        envelope = row.encrypted_key;
        keyVersion = row.key_version;
      } else throw new AiSettingsError("INVALID_REQUEST");
    }
    const owned = guard(context, input.version, row);
    const last = row
      ? db
          .prepare(
            `UPDATE ai_settings SET mode=?,provider_id=?,model_id=?,config_version=?,consent_version=?,encrypted_key=?,key_version=?,credential_version=credential_version+1,generation=generation+1,revision=revision+1,status='active' WHERE user_id=? AND ${owned.sql}`,
          )
          .bind(
            input.mode,
            input.providerId,
            input.modelId,
            destination.configVersion,
            input.acceptedPolicyVersion,
            envelope,
            keyVersion,
            context.userId,
            ...owned.values,
          )
      : db
          .prepare(
            `INSERT INTO ai_settings(user_id,id,mode,provider_id,model_id,config_version,consent_version,encrypted_key,key_version,credential_version,generation,revision,status) SELECT ?,'primary',?,?,?,?,?,?,?,1,1,1,'active' WHERE ${owned.sql} ON CONFLICT(user_id) DO NOTHING`,
          )
          .bind(
            context.userId,
            input.mode,
            input.providerId,
            input.modelId,
            destination.configVersion,
            input.acceptedPolicyVersion,
            envelope,
            keyVersion,
            ...owned.values,
          );
    return commit(context, row, input.version, last);
  }
  async function deleteKey(
    context: TenantContext,
    input: z.infer<typeof aiKeyDeleteRequestSchema>,
  ) {
    const parsed = aiKeyDeleteRequestSchema.safeParse(input);
    if (!parsed.success) throw new AiSettingsError("INVALID_REQUEST");
    const row = await current(context);
    if (
      !row ||
      row.revision !== parsed.data.version ||
      row.revision >= 2147483646
    )
      throw new AiSettingsError("CONFLICT");
    const owned = guard(context, parsed.data.version, row);
    const last = db
      .prepare(
        `UPDATE ai_settings SET encrypted_key=NULL,key_version=NULL,credential_version=credential_version+1,generation=generation+1,revision=revision+1,consent_version=0 WHERE user_id=? AND ${owned.sql}`,
      )
      .bind(context.userId, ...owned.values);
    return commit(context, row, parsed.data.version, last);
  }
  function safe<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ) {
    return async (...args: Args) => {
      try {
        return await operation(...args);
      } catch (cause) {
        if (cause instanceof AiSettingsError) throw cause;
        throw new AiSettingsError("UNAVAILABLE");
      }
    };
  }
  return {
    get: safe(get),
    save: safe(save),
    deleteKey: safe(deleteKey),
    current: safe(current),
  };
}
