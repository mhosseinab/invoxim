import { type PurchaseReview, reviewSourceSchema } from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { PrivateLoadError, readPrivateForIdentity } from "./api";

type Source = ReturnType<typeof reviewSourceSchema.parse>;
export function ReviewSource({
  review,
  expectedUserId,
  onReload,
}: {
  review: PurchaseReview;
  expectedUserId: string;
  onReload: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const context = review.sourceContext;
  if (!context)
    return review.documentId !== null ? (
      <p className="muted">
        Source email details are unavailable for this question.
      </p>
    ) : null;
  const date = new Date(context.receivedAt);
  async function load() {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setLoading(true);
    setError("");
    try {
      const result = await readPrivateForIdentity(
        `/api/review/${encodeURIComponent(review.id)}/source`,
        reviewSourceSchema,
        expectedUserId,
        request.signal,
      );
      if (!request.signal.aborted) setSource(result);
    } catch (failure) {
      if (
        failure instanceof PrivateLoadError &&
        (failure.status === 401 || failure.status === 403)
      ) {
        onReload();
        return;
      }
      if (!request.signal.aborted)
        setError(
          "The source email could not be opened. It may have been deleted, or your inbox may need reconnecting. You can retry without changing this question.",
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  return (
    <section aria-label="Source email">
      <p>
        Inbox: <strong>{context.mailboxAddress}</strong>
        <br />
        Received:{" "}
        <time dateTime={date.toISOString()}>
          {date.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </p>
      {source ? (
        <>
          <p>
            <strong>{source.subject ?? "Email subject unavailable"}</strong>
            <br />
            From: {source.sender ?? "Sender unavailable"}
          </p>
          {source.originalUrl ? (
            <a
              href={source.originalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open original email
            </a>
          ) : (
            <p className="muted">
              A direct link is unavailable. Find the email in the inbox above
              using its sender and received date.
            </p>
          )}
        </>
      ) : context.available ? (
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "Loading source email…" : "Show source email"}
        </button>
      ) : (
        <p className="muted">The source email is no longer available.</p>
      )}
      <p role="status">{error}</p>
    </section>
  );
}
