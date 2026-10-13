import type { PurchaseReviews } from "@invoxim/contracts";
import { missingQuestions, reviewQuestions } from "./copy";
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
    <section aria-label="Open purchase questions">
      <h1>Needs attention</h1>
      <p>
        Review only the details that are unclear. Existing supported facts stay
        available; uncertain financial events are excluded from spending.
      </p>
      {data.reviews.length === 0 && <p>No open questions were found.</p>}
      {data.reviews.map((review) => (
        <article className="private-panel private-review" key={review.id}>
          <h2>
            {review.missingFields.length > 0
              ? "Missing source details"
              : review.reason === "payment-allocation-review"
                ? "Payment needs confirmation"
                : "A source needs review"}
          </h2>
          <ReviewSource
            key={JSON.stringify([expectedUserId, review.id])}
            review={review}
            expectedUserId={expectedUserId}
            onReload={onReload}
          />
          {review.missingFields.length > 0 ? (
            <ul>
              {review.missingFields.map((field) => (
                <li key={field}>{missingQuestions[field]}</li>
              ))}
            </ul>
          ) : (
            <p>
              {reviewQuestions[review.reason] ??
                "The source needs review. A specific missing field has not been identified."}
            </p>
          )}
          {review.missingFields.includes("documentDate") && (
            <p className="muted">
              Use the date printed on the receipt or invoice. The email received
              date can be different.
            </p>
          )}
          {review.documentId === null && (
            <p className="muted">
              This question belongs to the purchase record. No source document
              is available for this remaining payment.
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
        </article>
      ))}
      {data.hasMore && (
        <p>More questions are available. This screen shows the latest 25.</p>
      )}
    </section>
  );
}
