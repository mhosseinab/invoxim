import {
  currencyMinorDigits,
  type OnboardingDisclosure,
  type OnboardingResponse,
  onboardingDisclosureSchema,
  onboardingStartRequestSchema,
  onboardingStartResponseSchema,
  type ProfileView,
  processingDisclosureQuerySchema,
  validTimezone,
} from "@invoxim/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { readPrivateForIdentity } from "../private/api";
import {
  confirmActor,
  identityFailure,
  OnboardingRequestError,
  sendOnboarding,
} from "./api";
import { onboardingCopy as text } from "./copy";
import { AdvancedAi } from "./settings";

type Draft = {
  startDate: string;
  endDate: string;
  timezone: string;
  reportingCurrency: string;
};
type Attempt = {
  body: ReturnType<typeof onboardingStartRequestSchema.parse>;
  key: string;
};
export function ReviewImport({
  data,
  profile,
  connectionId,
  onStarted,
  onRefresh,
  onIdentityChanged,
  onChooseMailbox,
}: {
  data: OnboardingResponse;
  profile: ProfileView;
  connectionId: string;
  onStarted: (runId: string) => void;
  onRefresh: () => void;
  onIdentityChanged: () => void;
  onChooseMailbox: () => void;
}) {
  const [disclosure, setDisclosure] = useState<OnboardingDisclosure | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const actor = profile.user.id;
  const loadReview = useCallback(
    async (values?: Draft) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setBusy(true);
      setAccepted(false);
      setStale(true);
      setAttempt(null);
      setMessage("");
      try {
        let proposed: Partial<Draft> = values ?? {};
        if (
          !values &&
          profile.settings.version === 1 &&
          profile.settings.timezone === "UTC" &&
          profile.onboarding.completedAt === null
        ) {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (validTimezone(detected)) proposed = { timezone: detected };
        }
        const parsed = processingDisclosureQuerySchema.safeParse({
          connectionId,
          ...proposed,
        });
        if (!parsed.success)
          throw new OnboardingRequestError(400, "invalid_request");
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed.data)) {
          if (value !== undefined) query.set(key, value);
        }
        const model = await readPrivateForIdentity(
          `/api/processing-disclosure?${query}`,
          onboardingDisclosureSchema,
          actor,
          request.signal,
        );
        if (
          model.connectionId !== connectionId ||
          model.loginEmail !== profile.user.email
        )
          throw new OnboardingRequestError(401, "unauthorized");
        if (!request.signal.aborted) {
          setDisclosure(model);
          setDraft({
            startDate: model.startDate,
            endDate: model.endDate,
            timezone: model.timezone,
            reportingCurrency: model.reportingCurrency,
          });
          setStale(false);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          if (
            (error instanceof OnboardingRequestError ||
              (error instanceof Error && "status" in error)) &&
            "status" in error &&
            (error.status === 401 || error.status === 403)
          )
            onIdentityChanged();
          else {
            setDisclosure(null);
            setMessage(text.policyUnavailable);
          }
        }
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    },
    [
      actor,
      connectionId,
      onIdentityChanged,
      profile.onboarding.completedAt,
      profile.settings.timezone,
      profile.settings.version,
      profile.user.email,
    ],
  );
  useEffect(() => {
    void loadReview();
    return () => controller.current?.abort();
  }, [loadReview]);
  const dirty =
    !!disclosure &&
    !!draft &&
    (draft.startDate !== disclosure.startDate ||
      draft.endDate !== disclosure.endDate ||
      draft.timezone !== disclosure.timezone ||
      draft.reportingCurrency !== disclosure.reportingCurrency);
  async function sendStart(current: Attempt) {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setMessage("");
    try {
      await confirmActor(actor, request.signal);
      const result = onboardingStartResponseSchema.safeParse(
        await sendOnboarding(
          "/api/onboarding/start-import",
          current.body,
          request.signal,
          current.key,
        ),
      );
      if (!result.success)
        throw new OnboardingRequestError(502, "request_unavailable");
      await confirmActor(actor, request.signal);
      if (!request.signal.aborted) {
        setAttempt(null);
        onStarted(result.data.importRunId);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        if (identityFailure(error)) {
          setAttempt(null);
          setAccepted(false);
          onIdentityChanged();
        } else if (
          error instanceof OnboardingRequestError &&
          error.status === 409
        ) {
          setAttempt(null);
          setAccepted(false);
          setStale(true);
          setMessage(text.stale);
        } else if (
          error instanceof OnboardingRequestError &&
          error.status === 429
        ) {
          setAttempt(null);
          setAccepted(false);
          setStale(true);
          setMessage(text["import.paused.budget"]);
        } else {
          setAttempt(current);
          setMessage(text.unknown);
        }
      }
    } finally {
      inFlight.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  function start() {
    if (
      !disclosure ||
      !accepted ||
      stale ||
      dirty ||
      busy ||
      attempt ||
      !disclosure.canStartImport
    )
      return;
    const result = onboardingStartRequestSchema.safeParse({
      connectionId: disclosure.connectionId,
      expectedConnectionGeneration: disclosure.connectionGeneration,
      expectedAiSettingsRevision: disclosure.aiSettingsRevision,
      expectedProfileVersion: disclosure.profileVersion,
      acceptedDisclosureVersion: disclosure.disclosureVersion,
      reviewToken: disclosure.reviewToken,
      startDate: disclosure.startDate,
      endDate: disclosure.endDate,
      timezone: disclosure.timezone,
      reportingCurrency: disclosure.reportingCurrency,
      authorizeHourlySync: true,
    });
    if (!result.success) {
      setMessage(text.stale);
      setStale(true);
      return;
    }
    void sendStart({ body: result.data, key: crypto.randomUUID() });
  }
  return (
    <section className="private-panel" aria-label={text.reviewImportReview}>
      <h1>{text.reviewTitle}</h1>
      <p>
        {data.progress
          ? text.reviewReviewTheProcessingAuthorizationForThis
          : text.reviewNothingIsReadOrProcessedUntil}
      </p>
      {message && <p role="alert">{message}</p>}
      {!disclosure && !busy && (
        <>
          <button type="button" onClick={() => void loadReview()}>
            {text.reviewRefreshReview}
          </button>
          <a href="/purchases">{text.pageViewExistingRecords}</a>
        </>
      )}
      {busy && !disclosure && (
        <p role="status">{text.reviewLoadingTheProcessingReview}</p>
      )}
      {disclosure && draft && (
        <>
          <dl className="onboarding-definition">
            <dt>{text.reviewSelectedMailbox}</dt>
            <dd>{disclosure.mailboxAddress}</dd>
            <dt>{text.reviewSelectedDates}</dt>
            <dd>
              {disclosure.startDate}
              {text.rangeTo}
              {disclosure.endDate}
              {text.inclusiveSelection}
            </dd>
            <dt>{text.reviewFrozenStart}</dt>
            <dd>{disclosure.startAt}</dd>
            <dt>{text.reviewFrozenCutoffExclusive}</dt>
            <dd>{disclosure.cutoffAt}</dd>
            <dt>{text.reviewTimeZone}</dt>
            <dd>{disclosure.timezone}</dd>
            <dt>{text.reviewReportingCurrency}</dt>
            <dd>{disclosure.reportingCurrency}</dd>
            <dt>{text.reviewReceiptProcessing}</dt>
            <dd>
              <span>{disclosure.inference.providerId}</span>{" "}
              {text.reviewSeparatorBeforeValue} {disclosure.inference.model}{" "}
              {text.reviewSeparatorBeforeValue}{" "}
              {disclosure.inference.mode === "hosted"
                ? text.reviewOperatorFundedInference
                : text.reviewYourAIKey}
            </dd>
            <dt>{text.reviewDocumentConversion}</dt>
            <dd>
              {disclosure.documentConversion.providerId}{" "}
              {text.reviewSeparatorBeforeValue}{" "}
              {disclosure.documentConversion.version}
            </dd>
          </dl>
          <p>{text.reviewRecent30DaysInThisInterval}</p>
          <section aria-label={text.reviewProcessingPolicies}>
            <h2>{text.reviewWhereReceiptDataGoes}</h2>
            <p>{text.reviewSupportedTextConversionHappensTransientlyInside}</p>
            {disclosure.inference.notices.map((notice) => (
              <article className="onboarding-notice" key={notice.id}>
                <h3>{notice.displayName}</h3>
                <p>{notice.dataUseSummary}</p>
                <p>{notice.retentionSummary}</p>
                <a
                  href={notice.privacyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {text.readPrefix}
                  {notice.displayName}
                </a>
              </article>
            ))}
          </section>
          <p>
            {text["import.review.originals"]}{" "}
            {text.reviewStartingImportDoesNotCreateA}
          </p>
          {disclosure.allowance && (
            <section aria-label={text.reviewProcessingAllowance}>
              <h2>{text.reviewProcessingAllowance}</h2>
              <p>
                {disclosure.allowance.dailyDocumentsRemaining}{" "}
                {text.reviewDocumentsRemainingToday}{" "}
                {disclosure.allowance.monthlyDocumentsRemaining}{" "}
                {text.reviewThisMonth}
              </p>
              <p>
                {disclosure.allowance.dailyUnitsRemaining}{" "}
                {text.reviewProcessingUnitsRemainingToday}
                {disclosure.allowance.monthlyUnitsRemaining}{" "}
                {text.reviewThisMonth2}
              </p>
              <p>
                {text.reviewDailyReset}
                {disclosure.allowance.dailyResetAt}
                {text.reviewMonthlyReset} {disclosure.allowance.monthlyResetAt}
                {text.period}
              </p>
              <p>{text.reviewHistoryImportsUseThisSameAllowance}</p>
              {disclosure.allowance.cooldownActive && (
                <p className="notice">
                  {text.reviewProcessingIsTemporarilyPausedByThe}
                </p>
              )}
            </section>
          )}
          {!disclosure.canStartImport && (
            <p className="notice">
              {disclosure.availability === "budget"
                ? text["import.paused.budget"]
                : disclosure.availability === "rate-limit"
                  ? text.reviewProcessingIsPausedByTheSelected
                  : disclosure.availability === "permission"
                    ? text.reviewThisMailboxDoesNotHaveThe
                    : disclosure.availability === "connection"
                      ? text["import.paused.auth"]
                      : text.policyUnavailable}
            </p>
          )}
          <details>
            <summary>{text.reviewChangeDatesTimeZoneOrCurrency}</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void loadReview(draft);
              }}
            >
              <fieldset disabled={busy || attempt !== null}>
                <legend>{text.reviewImportPreferences}</legend>
                <div className="onboarding-field-grid">
                  <label>
                    {text.reviewStartDate}
                    <input
                      aria-label={text.reviewStartDate}
                      type="date"
                      value={draft.startDate}
                      onChange={(event) => {
                        setAccepted(false);
                        setDraft({ ...draft, startDate: event.target.value });
                      }}
                      required
                    />
                  </label>
                  <label>
                    {text.reviewEndDateInclusive}
                    <input
                      aria-label={text.reviewEndDateInclusive}
                      type="date"
                      value={draft.endDate}
                      onChange={(event) => {
                        setAccepted(false);
                        setDraft({ ...draft, endDate: event.target.value });
                      }}
                      required
                    />
                  </label>
                  <label>
                    {text.reviewTimeZone}
                    <input
                      aria-label={text.reviewTimeZone}
                      value={draft.timezone}
                      onChange={(event) => {
                        setAccepted(false);
                        setDraft({ ...draft, timezone: event.target.value });
                      }}
                      required
                    />
                  </label>
                  <label>
                    {text.reviewReportingCurrency}
                    <select
                      aria-label={text.reviewReportingCurrency}
                      value={draft.reportingCurrency}
                      onChange={(event) => {
                        setAccepted(false);
                        setDraft({
                          ...draft,
                          reportingCurrency: event.target.value,
                        });
                      }}
                    >
                      {Object.keys(currencyMinorDigits).map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <button type="submit">{text.reviewUpdateReview}</button>
              </fieldset>
            </form>
          </details>
          {dirty && <p role="status">{text.needsReview}</p>}
          <p>{text.reviewStartImportAuthorizesTheProcessingShown}</p>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={
                busy ||
                attempt !== null ||
                stale ||
                dirty ||
                !disclosure.canStartImport
              }
              onChange={(event) => setAccepted(event.target.checked)}
            />
            {text.authorization}
          </label>
          <div className="onboarding-actions">
            <button
              className="primary"
              type="button"
              disabled={
                !accepted ||
                busy ||
                stale ||
                dirty ||
                !!attempt ||
                !disclosure.canStartImport
              }
              onClick={start}
            >
              {data.progress && data.progress.connectionId === connectionId
                ? text.reviewResumeImport
                : text.reviewStartImport}
            </button>
            <button
              type="button"
              disabled={busy || !!attempt}
              onClick={() => void loadReview()}
            >
              {text.reviewRefreshReview}
            </button>
            <button
              type="button"
              disabled={busy || !!attempt}
              onClick={onChooseMailbox}
            >
              {text.reviewChangeMailbox}
            </button>
          </div>
          {attempt && (
            <div className="onboarding-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendStart(attempt)}
              >
                {text.reviewRetryTheSameStartRequest}
              </button>
              <button type="button" disabled={busy} onClick={onRefresh}>
                {text.reviewCheckCurrentImport}
              </button>
            </div>
          )}
        </>
      )}
      <AdvancedAi
        actorId={actor}
        onChanged={() => void loadReview()}
        onIdentityChanged={onIdentityChanged}
      />
      {data.view.readyRecordCount > 0 && (
        <a href="/purchases">{text.reviewViewExistingPurchaseRecords}</a>
      )}
    </section>
  );
}
