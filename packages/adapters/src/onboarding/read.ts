import type { ProcessingDisclosureQuery } from "@invoxim/contracts";
import type { OnboardingSession } from "@invoxim/core";
import {
  calendarBoundary,
  OnboardingError,
  planDiscoveryRange,
} from "@invoxim/core";
import { readAiAllowance } from "../ai/budget";
import type {
  AiConfiguration,
  AiDestination,
  AiModel,
} from "../ai/configuration";
import type { StoredAiSettings } from "../ai/settings";
import { createAiSettingsService } from "../ai/settings";
import { validateOutlookReadScopes } from "../mailbox/outlook";
import { readEnvelopeVersion } from "../security/cipher";
import { selectedOnboardingConfigurationDigest } from "./configuration";

/** Missing operator configuration, distinct from other unavailable read failures. */
export class ProcessingNotConfiguredError extends OnboardingError {
  constructor() {
    super("UNAVAILABLE");
  }
}

export interface OnboardingProfile {
  version: number;
  timezone: string;
  reporting_currency: string;
}
export interface OnboardingConnection {
  id: string;
  provider: "gmail" | "outlook";
  display_address: string;
  generation: number;
  credential_version: number;
  state: string;
  scheduling_state: string;
  scopes: string;
  credential_ciphertext: string | null;
  credential_key_version: number | null;
}
export interface SelectedInference {
  row: StoredAiSettings | null;
  initializeHosted: boolean;
  mode: "hosted" | "byok";
  revision: number;
  destination: AiDestination;
  model: AiModel;
  configurationDigest: string;
  keyReady: boolean;
  noticesReady: boolean;
}
export function scopeReady(connection: OnboardingConnection) {
  try {
    const scopes: unknown = JSON.parse(connection.scopes);
    if (
      !Array.isArray(scopes) ||
      !scopes.every((scope: unknown) => typeof scope === "string")
    )
      return false;
    if (connection.provider === "outlook") {
      validateOutlookReadScopes(scopes.join(" "), true);
      return true;
    }
    return (
      connection.provider === "gmail" &&
      scopes.includes("https://www.googleapis.com/auth/gmail.readonly") &&
      scopes.every(
        (scope: unknown) =>
          typeof scope === "string" &&
          (!scope.startsWith("https://www.googleapis.com/auth/gmail.") ||
            scope === "https://www.googleapis.com/auth/gmail.readonly"),
      )
    );
  } catch {
    return false;
  }
}
export function localDate(instant: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function followingDate(date: string) {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}
export function reviewRange(
  query: ProcessingDisclosureQuery,
  profile: OnboardingProfile,
  now: number,
) {
  try {
    const timezone = query.timezone ?? profile.timezone,
      reportingCurrency = query.reportingCurrency ?? profile.reporting_currency;
    const today = localDate(now, timezone),
      endDate = query.endDate ?? today;
    if (endDate > today) throw new OnboardingError("INVALID_REQUEST");
    const cutoffMs =
      endDate === today
        ? now
        : calendarBoundary(followingDate(endDate), timezone);
    const startMs =
      query.startDate === undefined
        ? undefined
        : calendarBoundary(query.startDate, timezone);
    const plan = planDiscoveryRange({
      cutoffMs,
      timezone,
      ...(startMs === undefined ? {} : { startMs }),
    });
    return {
      plan,
      startDate: query.startDate ?? localDate(plan.range.startMs, timezone),
      endDate,
      timezone,
      reportingCurrency,
    };
  } catch (cause) {
    if (cause instanceof OnboardingError) throw cause;
    throw new OnboardingError("INVALID_REQUEST");
  }
}
export function createOnboardingReads(
  db: D1Database,
  ai: AiConfiguration | null,
  clock: () => number,
) {
  async function profile(session: OnboardingSession) {
    const row = await db
      .prepare(
        "SELECT version,timezone,reporting_currency FROM profiles WHERE user_id=? AND status='active'",
      )
      .bind(session.tenant.userId)
      .first<OnboardingProfile>();
    if (!row) throw new OnboardingError("UNAUTHORIZED");
    return row;
  }
  async function connections(session: OnboardingSession) {
    const rows = (
      await db
        .prepare(
          "SELECT c.id,c.provider,c.display_address,c.generation,c.credential_version,c.state,c.scheduling_state,c.scopes,c.credential_ciphertext,c.credential_key_version FROM connections c WHERE c.user_id=? AND c.kind='mailbox' AND c.provider IN ('gmail','outlook') AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=c.user_id AND p.status='active') ORDER BY c.id LIMIT 11",
        )
        .bind(session.tenant.userId)
        .all<OnboardingConnection>()
    ).results;
    if (rows.length > 10) throw new OnboardingError("UNAVAILABLE");
    return rows;
  }
  async function selected(
    session: OnboardingSession,
  ): Promise<SelectedInference> {
    if (!ai) throw new ProcessingNotConfiguredError();
    const row = await createAiSettingsService(db, ai).current(session.tenant);
    // Existing user selection is authoritative even when it has become unavailable.
    const initializeHosted = !row?.mode;
    const mode = initializeHosted ? "hosted" : row.mode;
    const providerId = initializeHosted
      ? ai.hosted?.destinationId
      : row.provider_id;
    const modelId = initializeHosted ? ai.hosted?.modelId : row.model_id;
    const destination = ai.destinations.find(
        (value) => value.id === providerId,
      ),
      model = destination?.models.find((value) => value.id === modelId);
    if (
      !mode ||
      !destination ||
      !model ||
      (!initializeHosted &&
        (row?.status !== "active" ||
          row.config_version !== destination.configVersion ||
          row.consent_version !== destination.policyVersion))
    )
      throw new OnboardingError("UNAVAILABLE");
    const revision = initializeHosted ? (row?.revision ?? 0) + 1 : row.revision;
    let keyReady =
      mode === "hosted"
        ? Boolean(
            ai.hosted &&
            ai.hosted.destinationId === destination.id &&
            ai.hosted.modelId === model.id,
          )
        : false;
    if (mode === "byok")
      try {
        keyReady = Boolean(
          row?.encrypted_key &&
          row.key_version &&
          row.key_version === readEnvelopeVersion(row.encrypted_key) &&
          ai.keyVersions.includes(row.key_version),
        );
      } catch {
        keyReady = false;
      }
    return {
      row,
      initializeHosted,
      mode,
      revision,
      destination,
      model,
      keyReady,
      noticesReady: destination.noticeRefs.every((ref) =>
        destination.notices?.some((notice) => notice.id === ref),
      ),
      configurationDigest: await selectedOnboardingConfigurationDigest({
        mode,
        settingsRevision: revision,
        destination,
        model,
      }),
    };
  }
  async function allowance(
    session: OnboardingSession,
    target: SelectedInference,
  ) {
    if (!ai) throw new OnboardingError("UNAVAILABLE");
    let value = await readAiAllowance(db, session.tenant, ai.budget, {
      destinationId: target.destination.id,
      modelId: target.model.id,
      clock,
    });
    if (target.mode === "hosted" && target.initializeHosted) {
      const cooled = await db
        .prepare(
          "SELECT 1 AS cooled FROM hosted_ai_cooldowns WHERE destination_id=? AND model_id=? AND cooldown_until>? AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=? AND p.status='active')",
        )
        .bind(
          target.destination.id,
          target.model.id,
          clock(),
          session.tenant.userId,
        )
        .first<number>("cooled");
      if (cooled === 1) value = { ...value, cooldownActive: true };
    }
    const now = new Date(clock());
    return {
      ...value,
      dailyResetAt: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      ).toISOString(),
      monthlyResetAt: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      ).toISOString(),
    };
  }
  return { profile, connections, selected, allowance };
}
