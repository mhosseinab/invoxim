import type { PurchaseDetail } from "@invoxim/contracts";
import { amount } from "../format";
import { Totals } from "./components";
import {
  categoryLabel,
  paymentStateLabel,
  sourceReasonLabel,
  privateCopy as text,
} from "./copy";
import { Corrections } from "./corrections";

export function Detail({
  detail,
  onReload,
  expectedUserId,
  reloadKey,
}: {
  detail: PurchaseDetail;
  onReload: () => void;
  expectedUserId: string;
  reloadKey: number;
}) {
  const purchase = detail.purchase;
  return (
    <div className="workspace-detail">
      <a href="/purchases">← Back to purchases</a>
      <section className="private-heading workspace-detail-heading">
        <div>
          <p className="eyebrow">
            {purchase.date} · {purchase.evidenceCount}{" "}
            {purchase.evidenceCount === 1
              ? text.supportingDocument
              : text.supportingDocuments}
          </p>
          <h1>{purchase.merchant}</h1>
          <p>
            {categoryLabel(purchase.category)}
            {purchase.invoiceReference &&
              ` · Invoice ${purchase.invoiceReference}`}
            {purchase.orderReference && ` · Order ${purchase.orderReference}`}
          </p>
          <span className="status">
            {paymentStateLabel(purchase.paymentState)}
          </span>
        </div>
        {purchase.documentTotalMinor !== null && purchase.currency && (
          <div className="workspace-detail-document">
            <span>{text["purchase.documentTotal"]}</span>
            <strong>
              {amount(purchase.documentTotalMinor, purchase.currency)}
            </strong>
          </div>
        )}
      </section>
      {purchase.origin === "user-supplied" && (
        <p className="notice">{text["manualSource.userSuppliedRecord"]}</p>
      )}
      <div className="workspace-detail-finances">
        <Totals values={purchase.lifecycle} label={text.lifecycle} />
      </div>
      {purchase.paymentState === "unpaid" && (
        <p className="workspace-caption">{text["purchase.unpaid"]}</p>
      )}
      {purchase.paymentState === "unknown" && (
        <p className="workspace-caption">
          Payment is unconfirmed. The document total is not counted as a
          payment.
        </p>
      )}
      {detail.ledgerEntries.some(
        (entry) => entry.origin === "user-confirmed",
      ) && (
        <section
          className="private-panel"
          aria-label="User-confirmed cash events"
        >
          <h2>Manual confirmations</h2>
          <p>
            These cash events were confirmed by you. No source document was
            created for the confirmation.
          </p>
          <ul>
            {detail.ledgerEntries
              .filter((entry) => entry.origin === "user-confirmed")
              .map((entry) => (
                <li key={entry.id}>
                  {entry.kind === "payment" ? "Payment" : "Refund"} ·{" "}
                  {amount(entry.minor, entry.currency)} · {entry.date} · User
                  confirmed
                  {entry.dateBasis === "user-corrected-date" &&
                    " · Date corrected by you"}
                  {!entry.eligible && " · Excluded from spending"}
                </li>
              ))}
          </ul>
        </section>
      )}
      {detail.manualEvidence.length > 0 && (
        <section
          className="private-panel"
          aria-label={text["manualSource.title"]}
        >
          <h2>{text["manualSource.title"]}</h2>
          <p>{text["manualSource.associationNotice"]}</p>
          <ul>
            {detail.manualEvidence.map((evidence) => (
              <li key={evidence.documentId}>
                <h3>{text["manualSource.document"]}</h3>
                <p>
                  {text["manualSource.sourceLabel"]}: {evidence.source.provider}
                </p>
                <p>
                  <strong>{text["purchase.originalUnavailable"]}</strong>
                </p>
                <p className="muted">
                  {sourceReasonLabel(evidence.source.reason)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="workspace-detail-content">
        <section className="private-panel workspace-evidence">
          <h2>Purchase timeline</h2>
          <p className="muted">
            Supporting source records and documented events. Pending refunds do
            not reduce the net.
          </p>
          <ol className="private-timeline">
            {detail.timeline.map((item) => (
              <li key={item.observationId}>
                <p className="eyebrow">{item.date ?? "Date not available"}</p>
                <h3>{item.documentType.replaceAll("-", " ")}</h3>
                {item.refundEvidence === "pending" && (
                  <p className="notice">{text.pendingRefund}</p>
                )}
                {item.events.map((event) => (
                  <p key={event.id}>
                    {event.kind === "payment"
                      ? "Payment documented"
                      : "Refund documented"}{" "}
                    · {amount(event.minor, event.currency)} · {event.date}
                    {!event.eligible && " · Excluded from spending"}
                  </p>
                ))}
                <p>
                  <strong>{text["purchase.originalUnavailable"]}</strong>
                </p>
                <details>
                  <summary>{text["purchase.why"]}</summary>
                  <p className="muted">
                    {sourceReasonLabel(item.source.reason)}
                  </p>

                  <p>
                    Source: {item.source.provider}. Relationship:{" "}
                    {item.relationship.replaceAll("_", " ")}. Evidence:{" "}
                    {item.evidenceCode.replaceAll("_", " ")}. Review:{" "}
                    {item.reviewState.replaceAll("_", " ")}. Event dates follow
                    the supporting evidence.
                  </p>
                </details>
              </li>
            ))}
          </ol>
        </section>
        <details className="workspace-about">
          <summary>About these amounts</summary>
          <p>{text["home.spendingCaption"]}</p>
          <p>
            The document total describes the purchase. Paid and refunded amounts
            describe documented financial events.
          </p>
          <p>Opening originals is not available on this screen yet.</p>
        </details>
      </div>
      <Corrections
        detail={detail}
        onReload={onReload}
        expectedUserId={expectedUserId}
        reloadKey={reloadKey}
      />
    </div>
  );
}
