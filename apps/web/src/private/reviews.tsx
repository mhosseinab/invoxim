import type { PurchaseReview, PurchaseReviews } from "@invoxim/contracts";
import { useId, useRef, useState } from "react";
import { missingQuestions, reviewQuestions, privateCopy as text } from "./copy";
import { StandaloneReview } from "./review-controls";
import { ReviewSource } from "./review-source";

function ReviewEmail({
  reviews,
  expectedUserId,
  onReload,
}: {
  reviews: PurchaseReview[];
  expectedUserId: string;
  onReload: () => void;
}) {
  const primary =
    reviews.find((review) => review.missingFields.length > 0) ?? reviews[0];
  const source = reviews.find((review) => review.sourceContext) ?? primary;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [opened, setOpened] = useState(false);
  if (!primary || !source) return null;
  const sourceReview = primary.documentId !== null;
  const title = sourceReview ? text.reviewEmail : text.reviewPurchaseQuestion;
  const context = source.sourceContext;
  return (
    <article className="private-panel private-review">
      <button
        className="workspace-review-open"
        ref={trigger}
        type="button"
        aria-label={title}
        onClick={() => {
          setOpened(true);
          dialog.current?.showModal();
        }}
      >
        <strong>
          {sourceReview
            ? text.emailNeedsReview
            : (reviewQuestions[primary.reason] ?? text.reviewPurchaseQuestion)}
        </strong>
        <span className="workspace-review-source">
          {context ? (
            <>
              {context.mailboxAddress} · {text.received}{" "}
              <time dateTime={new Date(context.receivedAt).toISOString()}>
                {new Date(context.receivedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </>
          ) : sourceReview ? (
            text.sourceDetailsUnavailable
          ) : (
            text.purchaseQuestion
          )}
        </span>
        <span className="workspace-review-open-label">{title} →</span>
      </button>
      <dialog
        className="source-review-dialog"
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => {
          setOpened(false);
          trigger.current?.focus();
        }}
      >
        <header className="source-review-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" onClick={() => dialog.current?.close()}>
            {text.closeReview}
          </button>
        </header>
        <div className="source-review-body">
          <ReviewSource
            key={JSON.stringify(["source", expectedUserId, source.id])}
            review={source}
            expectedUserId={expectedUserId}
            onReload={onReload}
            autoLoad={opened}
          />
          {sourceReview && !primary.purchaseId && (
            <p className="source-review-introduction">{text.checkEmailFirst}</p>
          )}
          {primary.purchaseId && (
            <a href={`/purchases/${encodeURIComponent(primary.purchaseId)}`}>
              View supported purchase history →
            </a>
          )}
          {primary.documentId === null && (
            <p className="muted">
              This question belongs to the purchase record. No source document
              is available for this remaining payment.
            </p>
          )}
          <StandaloneReview
            key={JSON.stringify(["actions", expectedUserId, primary.id])}
            reviewId={primary.id}
            expectedUserId={expectedUserId}
            onReload={onReload}
            autoLoad={opened}
          />
          <details className="source-review-checks">
            <summary>{text.whatNeedsChecking}</summary>
            {reviews.map((review) => (
              <div key={review.id}>
                {review.missingFields.length > 0 ? (
                  <ul>
                    {review.missingFields.map((field) => (
                      <li key={field}>{missingQuestions[field]}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {reviewQuestions[review.reason] ?? text.unspecifiedQuestion}
                  </p>
                )}
              </div>
            ))}
            {reviews.some((review) =>
              review.missingFields.includes("documentDate"),
            ) && (
              <p className="muted">
                Use the date printed on the receipt or invoice. The email
                received date can be different.
              </p>
            )}
          </details>
          {reviews.filter((review) => review.id !== primary.id).length > 0 && (
            <details className="source-review-other">
              <summary>{text.otherChecks}</summary>
              {reviews
                .filter((review) => review.id !== primary.id)
                .map((review) => (
                  <StandaloneReview
                    key={JSON.stringify([expectedUserId, review.id])}
                    reviewId={review.id}
                    expectedUserId={expectedUserId}
                    onReload={onReload}
                    hideNotPurchase
                  />
                ))}
            </details>
          )}
        </div>
      </dialog>
    </article>
  );
}

export function Reviews({
  data,
  onReload,
  expectedUserId,
}: {
  data: PurchaseReviews;
  onReload: () => void;
  expectedUserId: string;
}) {
  const groups = new Map<string, PurchaseReview[]>();
  for (const review of data.reviews) {
    const key = review.sourceMessageId
      ? `source:${review.sourceMessageId}`
      : `review:${review.id}`;
    const group = groups.get(key);
    if (group) group.push(review);
    else groups.set(key, [review]);
  }
  return (
    <section className="workspace-reviews" aria-label="Open purchase questions">
      <h1>Needs attention</h1>
      <p className="workspace-introduction">{text.reviewEmailIntroduction}</p>
      <p className="workspace-review-count">
        {groups.size} {text.reviewItems}
        {data.hasMore && ` · ${text.moreReviewItems}`}
      </p>
      {data.reviews.length === 0 && <p>No open questions were found.</p>}
      {Array.from(groups, ([key, reviews]) => (
        <ReviewEmail
          key={JSON.stringify([expectedUserId, key])}
          reviews={reviews}
          expectedUserId={expectedUserId}
          onReload={onReload}
        />
      ))}
    </section>
  );
}
