import {
  type PurchaseReview,
  type PurchaseReviews,
  reviewSourceSchema,
  type ReviewSource as Source,
} from "@invoxim/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { identityFailure, readPrivateForIdentity } from "./api";
import { missingQuestions, reviewQuestions, privateCopy as text } from "./copy";
import { StandaloneReview } from "./review-controls";
import { ReviewSource } from "./review-source";

function decisionLabel(reviews: PurchaseReview[]) {
  const fields = Array.from(
    new Set(reviews.flatMap((review) => review.missingFields)),
  );
  const labels = {
    merchant: "Merchant needed",
    total: "Total needed",
    currency: "Currency needed",
    documentDate: "Receipt date needed",
  };
  if (fields.length > 0)
    return fields.map((field) => labels[field]).join(" · ");
  const primary = reviews[0];
  if (!primary) return "Check this email";
  const reasons: Partial<Record<PurchaseReview["reason"], string>> = {
    "extraction-review": "Check extracted details",
    "document-review": "Check source document",
    "incomplete-financial-facts": "Check receipt details",
    "possible-duplicate": "Possible duplicate",
    "purchase-conflict": "Conflicting purchase details",
    "unmatched-refund": "Match this refund",
    "credit-note-completion": "Was this credit refunded?",
  };
  return (
    reasons[primary.reason] ??
    reviewQuestions[primary.reason] ??
    "Check this email"
  );
}

function ReviewEmail({
  reviews,
  expectedUserId,
  onReload,
  loadSource,
  preview,
  multipleInboxes,
}: {
  loadSource: () => Promise<Source>;
  preview: Preview | undefined;
  multipleInboxes: boolean;
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
        aria-label={
          preview?.state === "loaded"
            ? `${title}: ${preview.source.subject ?? "Email without a subject"}`
            : title
        }
        onClick={() => {
          setOpened(true);
          dialog.current?.showModal();
        }}
      >
        <span className="review-list-identity">
          <strong>
            {preview?.state === "loaded"
              ? (preview.source.subject ?? "Email without a subject")
              : preview?.state === "failed"
                ? "Email details unavailable"
                : context?.available
                  ? "Loading email details…"
                  : sourceReview
                    ? "Original email unavailable"
                    : text.reviewPurchaseQuestion}
          </strong>
          <span className="review-list-message-meta">
            <span className="review-list-sender">
              {preview?.state === "loaded"
                ? (preview.source.sender ?? "Sender unavailable")
                : preview?.state === "failed"
                  ? "Open to retry"
                  : ""}
            </span>
            {preview?.state === "loaded" &&
              preview.source.attachments &&
              preview.source.attachments.length > 0 && (
                <span className="review-list-attachments">
                  {preview.source.attachments.length === 1
                    ? preview.source.attachments[0]?.filename || "1 attachment"
                    : `${preview.source.attachments.length} attachments`}
                </span>
              )}
          </span>
          {multipleInboxes && context && (
            <span className="review-list-mailbox">
              {context.mailboxAddress}
            </span>
          )}
        </span>
        <span className="review-list-decision">{decisionLabel(reviews)}</span>
        {context && (
          <time
            className="review-list-date"
            dateTime={new Date(context.receivedAt).toISOString()}
          >
            {new Date(context.receivedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
        )}
        <span className="review-list-chevron" aria-hidden="true">
          ›
        </span>
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
            loadSource={loadSource}
            initialSource={
              preview?.state === "loaded" ? preview.source : undefined
            }
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

type Preview =
  | { state: "loaded"; source: Source }
  | { state: "loading" | "failed" };

function ReviewList({
  data,
  onReload,
  expectedUserId,
}: {
  data: PurchaseReviews;
  onReload: () => void;
  expectedUserId: string;
}) {
  const [visibleCount, setVisibleCount] = useState(8);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const known = useRef(new Set<string>());
  const pending = useRef(new Map<string, Promise<Source>>());
  const queue = useRef<
    Array<{
      key: string;
      reviewId: string;
      resolve: (source: Source) => void;
      reject: (error: unknown) => void;
    }>
  >([]);
  const active = useRef(0);
  const abort = useRef(new AbortController());
  const groups = useMemo(() => {
    const grouped = new Map<string, PurchaseReview[]>();
    for (const review of data.reviews) {
      const key = review.sourceMessageId
        ? `source:${review.sourceMessageId}`
        : `review:${review.id}`;
      const group = grouped.get(key);
      if (group) group.push(review);
      else grouped.set(key, [review]);
    }
    return Array.from(grouped);
  }, [data.reviews]);
  const visible = useMemo(
    () => groups.slice(0, visibleCount),
    [groups, visibleCount],
  );
  const inboxes = Array.from(
    new Set(
      data.reviews.flatMap((review) =>
        review.sourceContext ? [review.sourceContext.mailboxAddress] : [],
      ),
    ),
  );
  useEffect(
    () => () => {
      abort.current.abort();
      for (const job of queue.current)
        job.reject(new DOMException("Aborted", "AbortError"));
      queue.current = [];
    },
    [],
  );
  const loadPreview = useCallback(
    (key: string, reviewId: string): Promise<Source> => {
      const existing = pending.current.get(key);
      if (existing) return existing;
      const promise = new Promise<Source>((resolve, reject) => {
        queue.current.push({ key, reviewId, resolve, reject });
      });
      pending.current.set(key, promise);
      setPreviews((current) => ({ ...current, [key]: { state: "loading" } }));
      function pump() {
        while (
          !abort.current.signal.aborted &&
          active.current < 3 &&
          queue.current.length > 0
        ) {
          const job = queue.current.shift();
          if (!job) break;
          active.current += 1;
          void readPrivateForIdentity(
            `/api/review/${encodeURIComponent(job.reviewId)}/source`,
            reviewSourceSchema,
            expectedUserId,
            abort.current.signal,
          )
            .then((source) => {
              if (abort.current.signal.aborted)
                throw new DOMException("Aborted", "AbortError");
              setPreviews((current) => ({
                ...current,
                [job.key]: { state: "loaded", source },
              }));
              job.resolve(source);
            })
            .catch((error) => {
              pending.current.delete(job.key);
              job.reject(error);
              if (abort.current.signal.aborted) return;
              if (identityFailure(error)) {
                abort.current.abort();
                for (const queued of queue.current) queued.reject(error);
                queue.current = [];
                onReload();
                return;
              }
              setPreviews((current) => ({
                ...current,
                [job.key]: { state: "failed" },
              }));
            })
            .finally(() => {
              active.current -= 1;
              pump();
            });
        }
      }
      pump();
      return promise;
    },
    [expectedUserId, onReload],
  );
  useEffect(() => {
    for (const [key, reviews] of visible) {
      const source =
        reviews.find((review) => review.sourceContext) ?? reviews[0];
      if (!source?.sourceContext?.available || known.current.has(key)) continue;
      known.current.add(key);
      void loadPreview(key, source.id).catch(() => {
        /* The shared loader renders failures and handles identity rejection. */
      });
    }
  }, [visible, loadPreview]);
  return (
    <section className="workspace-reviews" aria-label="Open purchase questions">
      <h1>Needs attention</h1>
      <p className="workspace-introduction">{text.reviewEmailIntroduction}</p>
      <p className="workspace-review-count">
        {groups.length} {text.reviewItems}
      </p>
      {inboxes.length === 1 && (
        <p className="review-list-inbox">{inboxes[0]}</p>
      )}
      {data.reviews.length === 0 && <p>No open questions were found.</p>}
      {visible.map(([key, reviews]) => (
        <ReviewEmail
          key={JSON.stringify([expectedUserId, key])}
          reviews={reviews}
          expectedUserId={expectedUserId}
          onReload={onReload}
          loadSource={() => {
            const source =
              reviews.find((review) => review.sourceContext) ?? reviews[0];
            if (!source) return Promise.reject(new Error("Source unavailable"));
            return loadPreview(key, source.id);
          }}
          preview={previews[key]}
          multipleInboxes={inboxes.length > 1}
        />
      ))}
      {data.hasMore && (
        <p className="review-list-limit">{text.moreReviewItems}</p>
      )}
      {groups.length > visibleCount && (
        <button
          className="review-list-more"
          type="button"
          onClick={() => setVisibleCount((count) => count + 8)}
        >
          Show more emails
        </button>
      )}
    </section>
  );
}

export function Reviews(props: {
  data: PurchaseReviews;
  onReload: () => void;
  expectedUserId: string;
}) {
  return <ReviewList key={props.expectedUserId} {...props} />;
}
