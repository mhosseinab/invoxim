import {
  type CorrectionState,
  correctionReviewSchema,
  type PurchaseView,
  purchaseDetailSchema,
  reviewResolutionRequestSchema,
} from "@invoxim/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { assertPrivateIdentity, identityFailure, readPrivate } from "./api";
import { missingQuestions, reviewQuestions } from "./copy";
import { CategoryField, CurrencyField, moneyMinor } from "./correction-forms";
import { type CorrectionMutation, useCorrectionMutation } from "./mutations";

type Review = CorrectionState["reviews"][number];
function submitResolve(
  mutation: CorrectionMutation,
  review: Review,
  body: unknown,
) {
  const parsed = reviewResolutionRequestSchema.safeParse(body);
  if (!parsed.success) return mutation.invalid();
  mutation.submit(
    `/api/review/${encodeURIComponent(review.id)}/resolve`,
    "POST",
    parsed.data,
  );
}
function ReviewFields({
  review,
  purchase,
  mutation,
  complete,
}: {
  review: Review;
  purchase?: PurchaseView;
  mutation: CorrectionMutation;
  complete: boolean;
}) {
  const [merchant, setMerchant] = useState("");
  const [currency, setCurrency] = useState(
    complete || review.missingFields.includes("currency")
      ? ""
      : (purchase?.currency ?? ""),
  );
  const [total, setTotal] = useState("");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("uncategorized");
  const fields = complete
    ? (["merchant", "currency", "total", "documentDate"] as const)
    : review.missingFields;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          let body: unknown;
          if (complete)
            body = {
              version: review.version,
              action: "complete-record",
              record: {
                merchant,
                currency,
                documentDate: date,
                totalMinor: moneyMinor(total, currency),
                category,
              },
            };
          else {
            const changes: Record<string, unknown> = {};
            for (const field of fields) {
              if (field === "merchant") changes.merchant = merchant;
              if (field === "currency") changes.currency = currency;
              if (field === "total")
                changes.totalMinor = moneyMinor(total, currency);
              if (field === "documentDate") changes.documentDate = date;
            }
            body = {
              version: review.version,
              action: "correct-missing-fields",
              purchaseVersion: purchase?.version,
              changes,
            };
          }
          submitResolve(mutation, review, body);
        } catch {
          mutation.invalid();
        }
      }}
    >
      <fieldset disabled={mutation.locked} aria-describedby={mutation.errorId}>
        <legend>
          {complete ? "Purchase details" : "Correct the requested details"}
        </legend>
        <p>
          {complete
            ? "These details are supplied by you. Use the receipt or invoice; saving does not confirm a payment."
            : "Only the requested fields are changed. Other review questions remain open."}
        </p>
        <div className="private-filter-grid">
          {fields.includes("merchant") && (
            <label>
              Merchant
              <input
                aria-label="Merchant"
                value={merchant}
                onChange={(event) => setMerchant(event.target.value)}
                maxLength={200}
                required
              />
            </label>
          )}
          {fields.includes("currency") && (
            <CurrencyField value={currency} onChange={setCurrency} />
          )}
          {fields.includes("total") && (
            <label>
              Document total
              <input
                aria-label="Document total"
                inputMode="decimal"
                value={total}
                onChange={(event) => setTotal(event.target.value)}
                required
              />
            </label>
          )}
          {fields.includes("documentDate") && (
            <label>
              Receipt date
              <input
                aria-label="Document date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          )}
          {complete && (
            <CategoryField value={category} onChange={setCategory} />
          )}
        </div>
        {fields.includes("total") &&
          currency === "" &&
          !fields.includes("currency") && (
            <p>
              The purchase currency must be known before correcting its amount.
              Address its currency question first.
            </p>
          )}
        <button
          type="submit"
          disabled={fields.includes("total") && currency === ""}
        >
          {complete ? "Save purchase details" : "Save requested details"}
        </button>
      </fieldset>
    </form>
  );
}
export function ReviewControls({
  reviews,
  purchase,
  mutation,
  onCash,
  showQuestion = true,
  showNotPurchase = true,
}: {
  showNotPurchase?: boolean;
  showQuestion?: boolean;
  reviews: Review[];
  purchase?: PurchaseView;
  mutation: CorrectionMutation;
  onCash?: (
    kind: "payment" | "refund",
    review: { id: string; version: number },
  ) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <section aria-label="Review actions">
      {reviews
        .filter((review) => review.status === "open")
        .map((review) => (
          <article key={review.id}>
            {showQuestion && (
              <>
                <h3>
                  {review.blockingScope === "financial"
                    ? "Financial question"
                    : "Operational warning"}
                </h3>
                <p>
                  {reviewQuestions[review.reason] ??
                    "The source needs review before this issue can be resolved."}
                </p>
                {review.missingFields.length > 0 && (
                  <ul>
                    {review.missingFields.map((field) => (
                      <li key={field}>{missingQuestions[field]}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {showNotPurchase && review.actions.includes("not-a-purchase") && (
              <div className="review-discard-action">
                <button
                  type="button"
                  disabled={mutation.locked}
                  onClick={() => {
                    submitResolve(mutation, review, {
                      version: review.version,
                      action: "not-a-purchase",
                    });
                  }}
                >
                  Not a purchase
                </button>
                <span>Your email stays in your inbox.</span>
              </div>
            )}
            {review.actions.includes("complete-record") && (
              <p className="source-review-help">
                If this is a receipt, you can add its details. Saving does not
                confirm a payment.
              </p>
            )}
            {review.actions.includes("correct-missing-fields") &&
              purchase &&
              review.missingFields.length > 0 && (
                <button
                  type="button"
                  disabled={mutation.locked}
                  onClick={() => setEditingId(review.id)}
                >
                  Correct requested details
                </button>
              )}
            {review.actions.includes("complete-record") && (
              <button
                type="button"
                disabled={mutation.locked}
                onClick={() => setEditingId(review.id)}
              >
                Add purchase details
              </button>
            )}
            {editingId === review.id && (
              <ReviewFields
                key={review.id}
                review={review}
                mutation={mutation}
                {...(purchase ? { purchase } : {})}
                complete={review.actions.includes("complete-record")}
              />
            )}
            {review.actions.includes("dismiss-operational") && (
              <details
                className="review-other-actions"
                open={!review.actions.includes("not-a-purchase")}
              >
                <summary>Other actions</summary>
                <button
                  type="button"
                  disabled={mutation.locked}
                  onClick={() => {
                    submitResolve(mutation, review, {
                      version: review.version,
                      action: "dismiss-operational",
                    });
                  }}
                >
                  Dismiss operational warning
                </button>
              </details>
            )}
            {review.actions.includes("different-purchase") && purchase && (
              <button
                type="button"
                disabled={mutation.locked}
                onClick={() => {
                  submitResolve(mutation, review, {
                    version: review.version,
                    action: "different-purchase",
                    purchaseVersion: purchase.version,
                  });
                }}
              >
                These are different purchases
              </button>
            )}
            {onCash &&
              (["payment", "refund"] as const).map(
                (kind) =>
                  review.actions.includes(`confirm-${kind}`) && (
                    <button
                      key={kind}
                      type="button"
                      disabled={mutation.locked}
                      onClick={() =>
                        onCash(kind, { id: review.id, version: review.version })
                      }
                    >
                      Confirm {kind} for this question
                    </button>
                  ),
              )}
            {review.actions.length === 0 && (
              <p>No correction action is available for this question yet.</p>
            )}
          </article>
        ))}
    </section>
  );
}
export function StandaloneReview({
  reviewId,
  onReload,
  expectedUserId,
  autoLoad = false,
  hideNotPurchase = false,
}: {
  autoLoad?: boolean;
  hideNotPurchase?: boolean;
  reviewId: string;
  onReload: () => void;
  expectedUserId: string;
}) {
  const [loaded, setLoaded] = useState<{
    review: Review;
    purchase?: PurchaseView;
    mutationToken: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const autoRequested = useRef(false);
  const mutation = useCorrectionMutation(
    onReload,
    expectedUserId,
    loaded?.mutationToken ?? "",
  );
  useEffect(() => () => controller.current?.abort(), []);
  const load = useCallback(async () => {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setLoading(true);
    setMessage("");
    try {
      await assertPrivateIdentity(expectedUserId, request.signal);
      const data = await readPrivate(
        `/api/review/${encodeURIComponent(reviewId)}/corrections`,
        correctionReviewSchema,
        request.signal,
      );
      let purchase: PurchaseView | undefined;
      if (data.purchaseId)
        purchase = (
          await readPrivate(
            `/api/purchases/${encodeURIComponent(data.purchaseId)}`,
            purchaseDetailSchema,
            request.signal,
          )
        ).purchase;
      if (purchase && purchase.version !== data.purchaseVersion) {
        setMessage(
          "The purchase changed. Load the available actions again before correcting it.",
        );
        return;
      }
      await assertPrivateIdentity(expectedUserId, request.signal);
      if (!request.signal.aborted)
        setLoaded({
          review: data.review,
          mutationToken: data.mutationToken,
          ...(purchase ? { purchase } : {}),
        });
    } catch (error) {
      if (identityFailure(error)) {
        onReload();
        return;
      }
      if (!request.signal.aborted)
        setMessage(
          "Correction actions are currently unavailable. The question remains open.",
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [expectedUserId, onReload, reviewId]);
  useEffect(() => {
    if (autoLoad && !autoRequested.current) {
      autoRequested.current = true;
      void load();
    }
  }, [autoLoad, load]);
  return (
    <section>
      {!loaded && (
        <button type="button" disabled={loading} onClick={() => void load()}>
          Show available actions
        </button>
      )}
      <p role="status">{loading ? "Loading available actions…" : message}</p>
      {loaded && (
        <>
          <ReviewControls
            reviews={[loaded.review]}
            showQuestion={false}
            showNotPurchase={!hideNotPurchase}
            mutation={mutation}
            {...(loaded.purchase ? { purchase: loaded.purchase } : {})}
          />
          {loaded.purchase &&
            loaded.review.actions.some(
              (action) =>
                action === "confirm-payment" || action === "confirm-refund",
            ) && (
              <p>
                Open the supported purchase history to confirm a completed cash
                event.
              </p>
            )}
          {mutation.notice}
        </>
      )}
    </section>
  );
}
