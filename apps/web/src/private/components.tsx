import type {
  CurrencyTotals,
  PurchaseCoverage,
  PurchaseView,
} from "@invoxim/contracts";
import { amount, formatDateTime } from "../format";
import { Icon } from "../icons";
import {
  categoryLabel,
  paymentStateLabel,
  reviewQuestions,
  privateCopy as text,
} from "./copy";

export function Totals({
  values,
  label,
}: {
  values: CurrencyTotals[];
  label: string;
}) {
  return (
    <section className="private-totals" aria-label={label}>
      <p className="eyebrow">{label}</p>
      {values.length === 0 ? (
        <p>{text.noLifecycle}</p>
      ) : (
        values.map((value) => (
          <div key={value.currency}>
            <p className="eyebrow">{value.currency}</p>
            <dl className="money-row">
              <div>
                <dt>{text["purchase.paid"]}</dt>
                <dd>{amount(value.paidMinor, value.currency)}</dd>
              </div>
              <div>
                <dt>{text["purchase.refunded"]}</dt>
                <dd>{amount(value.refundedMinor, value.currency)}</dd>
              </div>
              <div>
                <dt>{text["purchase.net"]}</dt>
                <dd>{amount(value.netMinor, value.currency)}</dd>
              </div>
            </dl>
          </div>
        ))
      )}
    </section>
  );
}
export function PurchaseCard({ purchase }: { purchase: PurchaseView }) {
  const historyUrl = `/purchases/${encodeURIComponent(purchase.id)}`;
  const useDocumentTotal =
    purchase.paymentState === "unpaid" ||
    purchase.paymentState === "unknown" ||
    purchase.lifecycle.length === 0;
  return (
    <article
      className="purchase private-purchase compact-purchase"
      aria-label={`${purchase.merchant} purchase`}
    >
      <div className="compact-purchase-main">
        <span className="merchant-mark">
          <Icon name="document" />
        </span>
        <div className="compact-purchase-identity">
          <h3>
            <a href={historyUrl}>{purchase.merchant}</a>
          </h3>
          <p className="compact-purchase-meta">
            {purchase.date} · {categoryLabel(purchase.category)}
          </p>
          <span className="status">
            {paymentStateLabel(purchase.paymentState)}
          </span>
        </div>
        <div className="compact-purchase-amount">
          <span>
            {useDocumentTotal
              ? text["purchase.documentTotal"]
              : text.historyNet}
          </span>
          {useDocumentTotal ? (
            purchase.documentTotalMinor !== null && purchase.currency ? (
              <strong>
                {amount(purchase.documentTotalMinor, purchase.currency)}
              </strong>
            ) : (
              <strong>{text.amountUnavailable}</strong>
            )
          ) : (
            purchase.lifecycle.map((value) => (
              <strong key={value.currency}>
                {amount(value.netMinor, value.currency)}
              </strong>
            ))
          )}
        </div>
      </div>
      <div className="compact-purchase-footer">
        <span>
          {purchase.evidenceCount}{" "}
          {purchase.evidenceCount === 1
            ? text.supportingDocument
            : text.supportingDocuments}
        </span>
        <a
          href={historyUrl}
          aria-label={`View ${purchase.merchant} purchase history`}
        >
          History <span aria-hidden="true">→</span>
        </a>
        <details className="compact-purchase-details">
          <summary>
            {purchase.reviewReasons.length > 0
              ? text.needsAttention
              : text.paymentDetails}
          </summary>
          <Totals values={purchase.lifecycle} label={text.lifecycle} />
          {!useDocumentTotal &&
            purchase.documentTotalMinor !== null &&
            purchase.currency && (
              <p>
                {text["purchase.documentTotal"]}:{" "}
                {amount(purchase.documentTotalMinor, purchase.currency)}
              </p>
            )}
          {purchase.paymentState === "unpaid" && (
            <p>{text["purchase.unpaid"]}</p>
          )}
          {purchase.reviewReasons.length > 0 && (
            <ul>
              {purchase.reviewReasons.map((reason) => (
                <li key={reason}>
                  {reviewQuestions[reason] ?? text.unsupportedQuestion}
                </li>
              ))}
            </ul>
          )}
          {purchase.reviewReasons.length > 0 && (
            <a href="/needs-attention">{text.reviewQuestions}</a>
          )}
        </details>
      </div>
    </article>
  );
}
export function isPaused(
  connection: PurchaseCoverage["connections"][number],
): boolean {
  return (
    connection.schedulingState === "paused" ||
    connection.pausedJobs > 0 ||
    connection.imports.some(
      (run) => run.pauseReason !== null || run.stage === "paused",
    )
  );
}
export function Coverage({
  coverage,
  full = false,
}: {
  coverage: PurchaseCoverage;
  full?: boolean;
}) {
  const connectedCount = coverage.connections.filter(
    (connection) => connection.state === "connected",
  ).length;
  const paused = coverage.connections.some(isPaused);
  const pending = coverage.connections.some(
    (connection) =>
      connection.pendingJobs > 0 ||
      connection.imports.some((run) => run.completedAt === null),
  );
  if (!full)
    return (
      <section
        className="private-coverage compact-coverage"
        aria-label="Inbox coverage"
      >
        <div>
          <strong>
            {connectedCount}{" "}
            {connectedCount === 1 ? text.connectedInbox : text.connectedInboxes}
          </strong>
          {paused ? (
            <span>{text.coveragePaused}</span>
          ) : (
            pending && <span>{text.partial}</span>
          )}
          {coverage.connections.length === 0 && <span>{text.noMailbox}</span>}
          {coverage.openReviewCount > 0 && (
            <a href="/needs-attention">
              {coverage.openReviewCount} {text.itemsNeedAttention}
            </a>
          )}
        </div>
        <a href="/connections">View coverage details →</a>
      </section>
    );
  return (
    <section
      className="private-connection-list workspace-connections"
      aria-label="Inbox coverage"
    >
      <div className="workspace-overview">
        <strong>
          {connectedCount}{" "}
          {connectedCount === 1 ? text.connectedInbox : text.connectedInboxes} ·{" "}
          {coverage.readyPurchaseCount}{" "}
          {coverage.readyPurchaseCount === 1
            ? text.recordReady
            : text.recordsReady}
        </strong>
        {coverage.openReviewCount > 0 && (
          <a href="/needs-attention">
            {coverage.openReviewCount} {text.itemsNeedAttention}
          </a>
        )}
        {coverage.connections.length === 0 && <p>{text.noMailbox}</p>}
      </div>
      {coverage.connections.map((connection) => {
        const connectionPaused = isPaused(connection);
        const connectionPending =
          connection.pendingJobs > 0 ||
          connection.imports.some((run) => run.completedAt === null);
        return (
          <article
            className="private-panel workspace-inbox"
            key={connection.id}
          >
            <header className="workspace-inbox-heading">
              <div>
                <h2>{connection.address}</h2>
                <span className="workspace-caption">
                  {connection.provider} ·{" "}
                  {connection.state.replaceAll("_", " ")}
                </span>
              </div>
              <span className="status">
                {connection.state !== "connected"
                  ? text.mailboxNeedsReconnect
                  : connectionPaused
                    ? text.importPaused
                    : connectionPending
                      ? text.importInProgress
                      : connection.imports.length > 0
                        ? text.scanFinished
                        : text.awaitingImport}
              </span>
            </header>
            {connection.state !== "connected" && (
              <p>{text["import.paused.auth"]}</p>
            )}
            <div className="workspace-job-counts">
              {connection.pendingJobs > 0 && (
                <span>{connection.pendingJobs} pending jobs</span>
              )}
              {connection.failedJobs > 0 && (
                <span className="workspace-warning">
                  {connection.failedJobs} failed jobs
                </span>
              )}
              {connection.pausedJobs > 0 && (
                <span>{connection.pausedJobs} paused jobs</span>
              )}
            </div>
            {connection.imports.map((run) => (
              <section className="workspace-import" key={run.id}>
                {run.completedAt !== null && (
                  <strong>{text.scanFinished}</strong>
                )}
                <p className="workspace-caption">
                  {text.requestedHistory} {formatDateTime(run.from)} –{" "}
                  {formatDateTime(run.to)} {text.endExclusive}
                </p>
                {run.pauseReason && (
                  <p className="workspace-pause-reason">
                    {run.pauseReason.includes("budget")
                      ? text["import.paused.budget"]
                      : run.pauseReason.includes("auth")
                        ? text["import.paused.auth"]
                        : text["import.paused.service"]}
                  </p>
                )}
              </section>
            ))}
            <div className="workspace-inbox-actions">
              <a
                href={`/onboarding/review?connectionId=${encodeURIComponent(connection.id)}`}
              >
                {text.reviewImport}
              </a>
            </div>
            <details className="workspace-technical">
              <summary>{text.importDetails}</summary>
              <p>
                {connection.pendingJobs} pending jobs · {connection.failedJobs}{" "}
                failed jobs · {connection.pausedJobs} paused jobs
              </p>
              <p>
                Schedule setting:{" "}
                {connection.schedulingState.replaceAll("_", " ")}
              </p>
              {connection.imports.map((run) => (
                <div key={run.id}>
                  <p>
                    {run.stage.replaceAll("_", " ")} · {run.discoveredSources}{" "}
                    candidate messages · {run.processedSources} processed
                    messages
                  </p>
                  <p>
                    Requested interval: {run.from} to {run.to} (end exclusive).
                  </p>
                </div>
              ))}
            </details>
          </article>
        );
      })}
    </section>
  );
}
