import type { PurchaseReviews } from "@invoxim/contracts";
import { missingQuestions, reviewQuestions, privateCopy as text } from "./copy";
import { StandaloneReview } from "./review-controls";
import { ReviewSource } from "./review-source";

export function Reviews({
  data,
  onReload,
  expectedUserId,
}: {
  data: PurchaseReviews;
  onReload: () => void;
  expectedUserId: string;
}) {
  return (
    <section className="workspace-reviews" aria-label="Open purchase questions">
      <h1>Needs attention</h1>
      <p className="workspace-introduction">{text.reviewIntroduction}</p>
      <p className="workspace-review-count">
        {data.reviews.length} {text.questionsShown}
        {data.hasMore && ` · ${text.latestQuestions}`}
      </p>
      {data.reviews.length === 0 && <p>No open questions were found.</p>}
      {data.reviews.map((review) => (
        <article className="private-panel private-review" key={review.id}>
          <details className="workspace-review-details">
            <summary>
              <span className="workspace-review-question">
                {review.missingFields.map(
                  (field) => missingQuestions[field],
                )[0] ??
                  reviewQuestions[review.reason] ??
                  text.unspecifiedQuestion}
              </span>
              <span className="workspace-review-source">
                {review.sourceContext ? (
                  <>
                    {review.sourceContext.mailboxAddress} · {text.received}{" "}
                    <time
                      dateTime={new Date(
                        review.sourceContext.receivedAt,
                      ).toISOString()}
                    >
                      {new Date(review.sourceContext.receivedAt).toLocaleString(
                        undefined,
                        { dateStyle: "medium", timeStyle: "short" },
                      )}
                    </time>
                  </>
                ) : review.documentId === null ? (
                  text.purchaseQuestion
                ) : (
                  text.sourceDetailsUnavailable
                )}
              </span>
            </summary>
            <div className="workspace-review-body">
              <ReviewSource
                key={JSON.stringify([expectedUserId, review.id])}
                review={review}
                expectedUserId={expectedUserId}
                onReload={onReload}
              />
              {review.missingFields.length > 1 && (
                <ul>
                  {review.missingFields.slice(1).map((field) => (
                    <li key={field}>{missingQuestions[field]}</li>
                  ))}
                </ul>
              )}
              {review.missingFields.includes("documentDate") && (
                <p className="muted">
                  Use the date printed on the receipt or invoice. The email
                  received date can be different.
                </p>
              )}
              {review.documentId === null && (
                <p className="muted">
                  This question belongs to the purchase record. No source
                  document is available for this remaining payment.
                </p>
              )}
              {review.purchaseId ? (
                <a href={`/purchases/${encodeURIComponent(review.purchaseId)}`}>
                  View supported purchase history →
                </a>
              ) : (
                <p className="muted">
                  This document is not linked to a purchase yet.
                </p>
              )}
              <StandaloneReview
                reviewId={review.id}
                onReload={onReload}
                expectedUserId={expectedUserId}
              />
            </div>
          </details>
        </article>
      ))}
    </section>
  );
}
