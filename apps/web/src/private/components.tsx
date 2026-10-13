import type {
  CurrencyTotals,
  PurchaseCoverage,
  PurchaseView,
} from "@invoxim/contracts";
import { formatMinor } from "@invoxim/core";
import { Icon } from "../icons";
import { reviewQuestions, privateCopy as text } from "./copy";
export function amount(minor: string, currency: string) {
  try {
    return `${currency} ${formatMinor(minor, currency)}`;
  } catch {
    return `${currency} ${minor} minor units`;
  }
}
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
  return (
    <article
      className="purchase private-purchase"
      aria-label={`${purchase.merchant} purchase`}
    >
      <div className="purchase-heading">
        <span className="merchant-mark">
          <Icon name="document" />
        </span>
        <div>
          <p className="eyebrow">
            {purchase.date} · {purchase.category.replaceAll("_", " ")}
          </p>
          <h3>
            <a href={`/purchases/${encodeURIComponent(purchase.id)}`}>
              {purchase.merchant}
            </a>
          </h3>
        </div>
        <span className="status">
          {purchase.paymentState === "paid"
            ? "Payment documented"
            : purchase.paymentState === "unpaid"
              ? "Unpaid invoice"
              : purchase.paymentState === "partially_paid"
                ? "Partially paid"
                : "Payment unconfirmed"}
        </span>
      </div>
      <Totals values={purchase.lifecycle} label={text.lifecycle} />
      {purchase.documentTotalMinor !== null && purchase.currency && (
        <p className="muted">
          {text["purchase.documentTotal"]}:{" "}
          {amount(purchase.documentTotalMinor, purchase.currency)}
        </p>
      )}
      {purchase.paymentState === "unpaid" && (
        <p className="notice">{text["purchase.unpaid"]}</p>
      )}
      {purchase.reviewReasons.length > 0 && (
        <div className="notice">
          <strong>Needs attention</strong>
          <ul>
            {purchase.reviewReasons.map((reason) => (
              <li key={reason}>
                {reviewQuestions[reason] ??
                  "Some source details need review. Uncertain events are excluded from spending."}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="private-card-bottom">
        <span>{purchase.evidenceCount} supporting documents</span>
        <a href={`/purchases/${encodeURIComponent(purchase.id)}`}>
          View purchase history <span aria-hidden="true">→</span>
        </a>
      </div>
    </article>
  );
}
export function Coverage({
  coverage,
  full = false,
}: {
  coverage: PurchaseCoverage;
  full?: boolean;
}) {
  const paused = coverage.connections.some(
    (connection) =>
      connection.pausedJobs > 0 ||
      connection.imports.some((run) => run.pauseReason !== null),
  );
  const pending = coverage.connections.some(
    (connection) =>
      connection.pendingJobs > 0 ||
      connection.imports.some((run) => run.completedAt === null),
  );
  return (
    <section
      className={full ? "private-connection-list" : "private-coverage"}
      aria-label="Inbox coverage"
    >
      <div>
        <strong>
          {
            coverage.connections.filter(
              (connection) => connection.state === "connected",
            ).length
          }{" "}
          connected inboxes · {coverage.readyPurchaseCount} purchase records
          ready
        </strong>
        {paused ? (
          <p>
            Processing is paused. Your existing records remain available. View
            coverage details for the affected inbox.
          </p>
        ) : (
          pending && <p>{text.partial}</p>
        )}
        {coverage.openReviewCount > 0 && (
          <p>
            {coverage.openReviewCount} items need attention. Existing documented
            payments remain visible.{" "}
            <a href="/needs-attention">View questions →</a>
          </p>
        )}
        {coverage.connections.length === 0 && <p>{text.noMailbox}</p>}
      </div>
      {!full && <a href="/connections">View coverage details →</a>}
      {full &&
        coverage.connections.map((connection) => (
          <article className="private-panel" key={connection.id}>
            <div className="section-heading">
              <h2>{connection.address}</h2>
              <span className="status">
                {connection.state.replaceAll("_", " ")}
              </span>
            </div>
            <p>
              {connection.provider} ·{" "}
              {connection.schedulingState.replaceAll("_", " ")}
            </p>
            {connection.pausedJobs > 0 && (
              <p className="notice">
                Processing paused · {connection.pausedJobs} paused jobs. Your
                existing records remain available.
              </p>
            )}
            {connection.state !== "connected" && (
              <p>{text["import.paused.auth"]}</p>
            )}
            <p>
              {connection.pendingJobs} pending jobs · {connection.failedJobs}{" "}
              failed jobs
            </p>
            {connection.imports.map((run) => (
              <div className="private-import" key={run.id}>
                <p>
                  <strong>
                    {run.completedAt !== null
                      ? "Scan finished"
                      : run.pauseReason !== null || run.stage === "paused"
                        ? "Import paused"
                        : "Import in progress"}
                  </strong>{" "}
                  · {run.stage.replaceAll("_", " ")}
                </p>
                <p>
                  Requested interval: {run.from} to {run.to} (end exclusive).
                </p>
                <p>
                  {run.discoveredSources} candidate messages ·{" "}
                  {run.processedSources} processed messages
                </p>
                {run.pauseReason && (
                  <p className="notice">
                    {run.pauseReason.includes("budget")
                      ? text["import.paused.budget"]
                      : run.pauseReason.includes("auth")
                        ? text["import.paused.auth"]
                        : text["import.paused.service"]}
                  </p>
                )}
              </div>
            ))}
          </article>
        ))}
    </section>
  );
}
