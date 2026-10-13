import type { OnboardingResponse } from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { onboardingCopy as text } from "./copy";
export function ImportProgress({
  data,
  acceptedRunId,
  onRefresh,
}: {
  data: OnboardingResponse;
  acceptedRunId: string | null;
  onRefresh: () => void;
}) {
  const progress = data.progress;
  const ready = data.view.readyRecordCount;
  const paused =
    data.view.state === "paused_budget" ||
    (progress?.pausedJobs ?? 0) > 0 ||
    !!progress?.pauseReason;
  const complete = progress?.historyComplete ?? data.view.historyComplete;
  const milestone = `${ready > 0}:${paused}:${complete}:${data.view.state === "needs_reconnect"}`;
  const last = useRef("");
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (last.current !== milestone) {
      last.current = milestone;
      setAnnouncement(
        paused
          ? text.processingPaused
          : complete
            ? text.progressTheSelectedScanHasFinishedCheck
            : ready > 0
              ? text.progressPurchaseRecordsAreReadyOlderHistory
              : text.progressImportIsInProgressNoPurchase,
      );
    }
  }, [milestone, paused, complete, ready]);
  return (
    <section className="private-panel" aria-label={text.progressImportStatus}>
      <h1>{text.progressTitle}</h1>
      <p role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {!progress && (
        <p>
          {text.progressTheImportRequestWasAcceptedRefresh}
          {acceptedRunId
            ? text.progressRunPrefix + acceptedRunId + text.period
            : ""}
        </p>
      )}
      {progress && (
        <>
          <p>
            <strong>
              {paused
                ? text.progressImportPaused
                : complete
                  ? text.finished
                  : text.progressImportInProgress}
            </strong>{" "}
            {text.progressSeparatorAfterValue}
            {progress.stage.replaceAll("_", " ")}
          </p>
          <dl className="onboarding-definition">
            <dt>{text.progressRequestedInterval}</dt>
            <dd>
              {progress.startAt}
              {text.rangeTo}
              {progress.cutoffAt}
              {text.endExclusive}
            </dd>
            <dt>{text.progressCandidateMessages}</dt>
            <dd>{progress.discoveredSources}</dd>
            <dt>{text.progressProcessedMessages}</dt>
            <dd>{progress.processedSources}</dd>
            <dt>{text.progressUnsupportedMessages}</dt>
            <dd>{progress.unsupportedSources}</dd>
            <dt>{text.progressFailedMessages}</dt>
            <dd>{progress.failedSources}</dd>
            <dt>{text.progressMessagesNeedingReview}</dt>
            <dd>{progress.reviewSources}</dd>
            <dt>{text.progressRecordsReadyInThisImport}</dt>
            <dd>{progress.readyRecordCount}</dd>
            <dt>{text.progressOpenReviewItems}</dt>
            <dd>{progress.reviewItemCount}</dd>
          </dl>
          {(progress.failedSources > 0 || progress.unsupportedSources > 0) && (
            <p className="notice">{text.failedSources}</p>
          )}
          {progress.reviewSources > 0 && (
            <p className="notice">
              {text.reviewSources}
              {!complete && !paused ? " Import is still continuing." : ""}
            </p>
          )}
          {paused && (
            <p>
              {progress.pauseReason?.includes("budget")
                ? text["import.paused.budget"]
                : progress.pauseReason?.includes("auth")
                  ? text["import.paused.auth"]
                  : text.processingPaused}
            </p>
          )}
          {!complete && !paused && data.view.hasProcessingConsent && (
            <p>
              {text["import.progress.background"]}{" "}
              {text.progressRecentMessagesAreProcessedBeforeOlder}
            </p>
          )}
          {complete &&
            ready === 0 &&
            progress.failedSources === 0 &&
            progress.unsupportedSources === 0 &&
            progress.reviewSources === 0 && (
              <p>{text.progressNoMatchingPurchaseRecordsWereFound}</p>
            )}
          {!complete && ready === 0 && <p>{text.noReady}</p>}
        </>
      )}
      {data.view.state === "needs_reconnect" && (
        <p>{text["import.paused.auth"]}</p>
      )}
      {data.view.state === "processing_unavailable" && (
        <p>{text["import.paused.service"]}</p>
      )}
      <div className="onboarding-actions">
        <button type="button" onClick={onRefresh}>
          {text.progressRefreshImportStatus}
        </button>
        {ready > 0 && (
          <a className="primary" href="/purchases">
            {text.progressViewPurchaseRecords}
          </a>
        )}
        {data.view.reviewItemCount > 0 && (
          <a href="/needs-attention">
            {text.progressViewQuestionsNeedingAttention}
          </a>
        )}
        {data.view.connectionId && (
          <a
            href={`/onboarding/review?connectionId=${encodeURIComponent(data.view.connectionId)}`}
          >
            {text.progressReviewProcessingAndRange}
          </a>
        )}
        <a href="/connections">{text.progressViewInboxCoverage}</a>
      </div>
    </section>
  );
}
