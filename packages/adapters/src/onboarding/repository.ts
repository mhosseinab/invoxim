import {
  onboardingDisclosureSchema,
  onboardingStartResponseSchema,
} from "@invoxim/contracts";
import type { OnboardingRepository, OnboardingSession } from "@invoxim/core";
import { OnboardingError } from "@invoxim/core";
import type { AiConfiguration } from "../ai/configuration";
import { hashJsonValue } from "../hash";
import { readActiveOnboardingRun } from "./active-run";
import {
  LOCAL_PARSER_POLICY,
  RECEIPT_CLASSIFIER_NOTICE,
} from "./configuration";
import {
  canStartImport,
  createOnboardingReads,
  inferenceReady,
  reviewRange,
  scopeReady,
} from "./read";
import { commitOnboardingStart } from "./start";
import { signReview, verifyReview } from "./token";
import { readOnboardingView } from "./view";
export interface OnboardingRepositoryOptions {
  readonly ai: AiConfiguration | null;
  readonly ready: boolean;
  readonly signingSecret: string;
  readonly mailboxLimit: number;
  readonly mailboxProviders?: readonly ("gmail" | "outlook")[];
  readonly remainingStatements: () => number;
  readonly clock?: () => number;
}
export function createOnboardingRepository(
  db: D1Database,
  options: OnboardingRepositoryOptions,
): OnboardingRepository {
  const clock = options.clock ?? Date.now,
    reads = createOnboardingReads(db, options.ai, clock);
  async function context(session: OnboardingSession, connectionId: string) {
    const profile = await reads.profile(session),
      connection = (await reads.connections(session)).find(
        (c) => c.id === connectionId,
      );
    if (!connection) throw new OnboardingError("UNAUTHORIZED");
    const selected = await reads.selected(session),
      allowance = await reads.allowance(session, selected);
    const availability =
      connection.state !== "connected"
        ? "connection"
        : !scopeReady(connection)
          ? "permission"
          : !options.ready ||
              !(options.mailboxProviders ?? ["gmail"]).includes(
                connection.provider,
              ) ||
              !inferenceReady(selected) ||
              !connection.credential_ciphertext
            ? "configuration"
            : canStartImport(selected, allowance)
              ? "ready"
              : allowance.cooldownActive
                ? "rate-limit"
                : "budget";
    return { profile, connection, selected, allowance, availability } as const;
  }
  return {
    view: (session, connectionId) =>
      readOnboardingView(db, reads, session, {
        ready: options.ready,
        mailboxLimit: options.mailboxLimit,
        connectionId,
        mailboxProviders: options.mailboxProviders ?? ["gmail"],
      }),
    async disclosure(session, query) {
      const { profile, connection, selected, allowance, availability } =
          await context(session, query.connectionId),
        now = clock(),
        range = reviewRange(query, profile, now);
      const payload = {
        userId: session.tenant.userId,
        sessionId: session.sessionId,
        connectionId: connection.id,
        provider: connection.provider,
        scopeDigest: await hashJsonValue(connection.scopes),
        generation: connection.generation,
        credentialVersion: connection.credential_version,
        profileVersion: profile.version,
        aiSettingsRevision: selected.row?.revision ?? 0,
        selectedAiSettingsRevision: selected.revision,
        configurationDigest: selected.configurationDigest,
        startDate: range.startDate,
        endDate: range.endDate,
        startMs: range.plan.range.startMs,
        cutoffMs: range.plan.range.cutoffMs,
        timezone: range.timezone,
        reportingCurrency: range.reportingCurrency,
        expiresAt: now + 600000,
      };
      const active = await readActiveOnboardingRun(db, session, connection.id);
      if (active) {
        const dates = {
          startDate: active.onboarding_start_date,
          endDate: active.onboarding_end_date,
          timezone: active.timezone,
          reportingCurrency: active.onboarding_reporting_currency,
        };
        if (
          (query.startDate ?? dates.startDate) === dates.startDate &&
          (query.endDate ?? dates.endDate) === dates.endDate &&
          (query.timezone ?? dates.timezone) === dates.timezone &&
          (query.reportingCurrency ?? dates.reportingCurrency) ===
            dates.reportingCurrency &&
          dates.startDate &&
          dates.endDate &&
          dates.reportingCurrency
        ) {
          payload.startDate = dates.startDate;
          payload.endDate = dates.endDate;
          payload.timezone = dates.timezone;
          payload.reportingCurrency = dates.reportingCurrency;
          payload.startMs = Date.parse(active.frozen_start);
          payload.cutoffMs = Date.parse(active.frozen_cutoff);
        }
      }
      const signed = await signReview(payload, options.signingSecret);
      return onboardingDisclosureSchema.parse({
        ...signed,
        configurationDigest: selected.configurationDigest,
        expiresAt: new Date(payload.expiresAt).toISOString(),
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        mailboxAddress: connection.display_address,
        loginEmail: session.loginEmail,
        profileVersion: profile.version,
        aiSettingsRevision: payload.aiSettingsRevision,
        selectedAiSettingsRevision: selected.revision,
        startDate: payload.startDate,
        endDate: payload.endDate,
        startAt: new Date(payload.startMs).toISOString(),
        cutoffAt: new Date(payload.cutoffMs).toISOString(),
        timezone: payload.timezone,
        reportingCurrency: payload.reportingCurrency,
        inference: {
          providerId: selected.destination.id,
          model: selected.model.id,
          mode: selected.mode,
          policyVersion: selected.destination.policyVersion,
          notices: (selected.destination.notices ?? []).filter((notice) =>
            selected.destination.noticeRefs.includes(notice.id),
          ),
          noticeRefs: selected.destination.noticeRefs,
          ready: inferenceReady(selected),
        },
        ...(options.ai?.classification?.enabled
          ? {
              classification: {
                providerId: "cloudflare-clef",
                model: options.ai.classification.model,
                mode: "hosted",
                policyVersion: 1,
                notices: [RECEIPT_CLASSIFIER_NOTICE],
                noticeRefs: [RECEIPT_CLASSIFIER_NOTICE.id],
                ready: true,
              },
            }
          : {}),
        documentConversion: {
          providerId: LOCAL_PARSER_POLICY.providerId,
          version: LOCAL_PARSER_POLICY.version,
          policyVersion: LOCAL_PARSER_POLICY.policyVersion,
          noticeRefs: LOCAL_PARSER_POLICY.noticeRefs,
          ready: true,
        },
        allowance,
        canStartImport: availability === "ready",
        availability,
        retentionNoticeVersion: "purchase-records-transient-v1",
        authorizeHourlySync: true,
      });
    },
    async prepareStart(session, input, key) {
      const keyHash = await hashJsonValue(["onboarding.start", key]),
        bodyHash = await hashJsonValue(input);
      const command = await db
        .prepare(
          "SELECT body_hash,result_json FROM onboarding_commands WHERE user_id=? AND key_hash=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
        )
        .bind(session.tenant.userId, keyHash, session.tenant.userId)
        .first<{ body_hash: string; result_json: string }>();
      if (command) {
        if (command.body_hash !== bodyHash)
          throw new OnboardingError("CONFLICT");
        const result = onboardingStartResponseSchema.safeParse(
          JSON.parse(command.result_json),
        );
        if (!result.success) throw new OnboardingError("CONFLICT");
        return { kind: "existing", result: { ...result.data, reused: true } };
      }
      const token = await verifyReview(
        input.reviewToken,
        options.signingSecret,
      );
      if (
        token.userId !== session.tenant.userId ||
        token.sessionId !== session.sessionId ||
        token.expiresAt <= clock() ||
        token.cutoffMs > clock() ||
        token.connectionId !== input.connectionId ||
        token.generation !== input.expectedConnectionGeneration ||
        token.profileVersion !== input.expectedProfileVersion ||
        token.aiSettingsRevision !== input.expectedAiSettingsRevision ||
        token.startDate !== input.startDate ||
        token.endDate !== input.endDate ||
        token.timezone !== input.timezone ||
        token.reportingCurrency !== input.reportingCurrency ||
        (await hashJsonValue(token)) !== input.acceptedDisclosureVersion
      )
        throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
      const { profile, connection, selected, availability } = await context(
        session,
        input.connectionId,
      );
      if (
        token.configurationDigest !== selected.configurationDigest ||
        token.selectedAiSettingsRevision !== selected.revision ||
        token.credentialVersion !== connection.credential_version ||
        token.generation !== connection.generation ||
        token.provider !== connection.provider ||
        token.scopeDigest !== (await hashJsonValue(connection.scopes))
      )
        throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
      const active = await readActiveOnboardingRun(db, session, connection.id);
      if (active) {
        if (
          active.connection_generation > connection.generation ||
          active.onboarding_start_date !== token.startDate ||
          active.onboarding_end_date !== token.endDate ||
          active.timezone !== token.timezone ||
          active.onboarding_reporting_currency !== token.reportingCurrency ||
          Date.parse(active.frozen_start) !== token.startMs ||
          Date.parse(active.frozen_cutoff) !== token.cutoffMs
        )
          throw new OnboardingError("CONFLICT");
        if (
          active.connection_generation === connection.generation &&
          connection.scheduling_state === "active" &&
          active.authorizationCanceled === 0 &&
          active.accepted_digest === selected.configurationDigest &&
          !active.pause_reason &&
          active.paused === 0
        )
          throw new OnboardingError("CONFLICT");
      }
      const live = await db
        .prepare(
          "SELECT query_mode,stage FROM sync_states WHERE user_id=? AND connection_id=? AND sync_kind='incremental' AND run_key='live' AND slice_key='live'",
        )
        .bind(session.tenant.userId, connection.id)
        .first<{ query_mode: string; stage: string }>();
      if (
        !active &&
        live &&
        (live.query_mode !== "filtered" || live.stage === "recovering")
      )
        throw new OnboardingError("CONFLICT");

      if (
        profile.version !== token.profileVersion ||
        (selected.row?.revision ?? 0) !== token.aiSettingsRevision
      )
        throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
      if (availability !== "ready")
        throw new OnboardingError(
          availability === "budget" || availability === "rate-limit"
            ? "BUDGET"
            : availability === "connection" || availability === "permission"
              ? "AUTH_REQUIRED"
              : "UNAVAILABLE",
        );
      const intervalKey = await hashJsonValue([
        connection.id,
        connection.generation,
        token.startDate,
        token.endDate,
        token.timezone,
        token.reportingCurrency,
        selected.configurationDigest,
      ]);
      return {
        kind: "ready",
        prepared: {
          ...(active
            ? {
                resume: {
                  runId: active.id,
                  consentId: active.consent_id,
                  priorGeneration: active.connection_generation,
                },
              }
            : {}),
          connectionId: connection.id,
          provider: connection.provider,
          scopes: connection.scopes,
          generation: connection.generation,
          credentialVersion: connection.credential_version,
          expectedProfileVersion: profile.version,
          expectedAiSettingsRevision: token.aiSettingsRevision,
          selectedAiSettingsRevision: selected.revision,
          settingsGeneration: selected.row?.generation ?? 1,
          settingsCredentialVersion: selected.row?.credential_version ?? 0,
          initializeHosted: selected.initializeHosted,
          mode: selected.mode,
          destinationId: selected.destination.id,
          modelId: selected.model.id,
          configVersion: selected.destination.configVersion,
          policyVersion: selected.destination.policyVersion,
          configurationDigest: selected.configurationDigest,
          disclosureVersion: input.acceptedDisclosureVersion,
          parserDestination: LOCAL_PARSER_POLICY.providerId,
          startDate: token.startDate,
          endDate: token.endDate,
          startMs: token.startMs,
          cutoffMs: token.cutoffMs,
          timezone: token.timezone,
          reportingCurrency: token.reportingCurrency,
          keyHash,
          bodyHash,
          intervalKey,
          fingerprint: await hashJsonValue([keyHash, bodyHash]),
        },
      };
    },
    commitStart: (session, prepared, seed) =>
      commitOnboardingStart(db, session, prepared, seed, options),
  };
}
