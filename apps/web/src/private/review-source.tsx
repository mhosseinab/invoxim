import { type PurchaseReview, reviewSourceSchema } from "@invoxim/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { identityFailure, readPrivateForIdentity } from "./api";

type Source = ReturnType<typeof reviewSourceSchema.parse>;
export function ReviewSource({
  review,
  expectedUserId,
  onReload,
  autoLoad = false,
  initialSource,
  loadSource,
}: {
  autoLoad?: boolean;
  initialSource?: Source | undefined;
  loadSource?: () => Promise<Source>;
  review: PurchaseReview;
  expectedUserId: string;
  onReload: () => void;
}) {
  const [source, setSource] = useState<Source | null>(initialSource ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const autoRequested = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (initialSource) setSource(initialSource);
  }, [initialSource]);
  const context = review.sourceContext;
  const load = useCallback(async () => {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setLoading(true);
    setError("");
    try {
      const result = loadSource
        ? await loadSource()
        : await readPrivateForIdentity(
            `/api/review/${encodeURIComponent(review.id)}/source`,
            reviewSourceSchema,
            expectedUserId,
            request.signal,
          );
      if (!request.signal.aborted) {
        setSource(result);
      }
    } catch (failure) {
      if (!loadSource && identityFailure(failure)) {
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
  }, [expectedUserId, onReload, review.id, loadSource]);
  useEffect(() => {
    if (autoLoad && !source && context?.available && !autoRequested.current) {
      autoRequested.current = true;
      void load();
    }
  }, [autoLoad, context?.available, load, source]);
  if (!context)
    return review.documentId !== null ? (
      <p className="muted">
        Source email details are unavailable for this question.
      </p>
    ) : null;
  const date = new Date(context.receivedAt);
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
          <h3 className="source-review-subject">
            {source.subject ?? "Email subject unavailable"}
          </h3>
          <p>From: {source.sender ?? "Sender unavailable"}</p>
          {source.attachments && (
            <section aria-label="Email attachments">
              <h4>Attachments</h4>
              {source.attachments.length === 0 ? (
                <p>No attachments listed.</p>
              ) : (
                <ul className="source-review-attachments">
                  {source.attachments.map((attachment, index) => (
                    <li key={JSON.stringify([index, attachment.filename])}>
                      <strong>
                        {attachment.filename || "Unnamed attachment"}
                      </strong>
                      <span>
                        {attachment.mimeType} ·{" "}
                        {attachment.size === null
                          ? "Size unavailable"
                          : `${attachment.size.toLocaleString("en-GB")} bytes`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
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
