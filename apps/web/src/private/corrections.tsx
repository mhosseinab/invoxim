import {
  type CorrectionState,
  correctionStateSchema,
  type PurchaseDetail,
} from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { identityFailure, readPrivateForIdentity } from "./api";
import { cashEvents } from "./cash";
import { reviewQuestions } from "./copy";
import { InclusionControl, MergeControl } from "./correction-actions";
import { CashEditor, PurchaseEditor } from "./correction-forms";
import { useCorrectionMutation } from "./mutations";
import { ReviewControls } from "./review-controls";

type Editor =
  | { kind: "purchase" }
  | {
      kind: "payment" | "refund";
      entryId?: string;
      review?: { id: string; version: number };
    }
  | null;
export function Corrections({
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
  const [state, setState] = useState<CorrectionState | null>(null);
  const [availability, setAvailability] = useState(
    "Checking correction availability…",
  );
  const [editor, setEditor] = useState<Editor>(null);
  const mutation = useCorrectionMutation(
    onReload,
    expectedUserId,
    state?.mutationToken ?? "",
  );
  const purchaseId = detail.purchase.id;
  const askedReload = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a re-fetch trigger; onReload is only used on identity failure and must not re-run the fetch
  useEffect(() => {
    const controller = new AbortController();
    void readPrivateForIdentity(
      `/api/purchases/${encodeURIComponent(purchaseId)}/corrections`,
      correctionStateSchema,
      expectedUserId,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          askedReload.current = false;
          setState(value);
          setAvailability("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          if (identityFailure(error)) {
            if (!askedReload.current) {
              askedReload.current = true;
              onReload();
            }
          } else
            setAvailability(
              "Corrections are currently unavailable. Your existing purchase records remain readable.",
            );
        }
      });
    return () => controller.abort();
  }, [purchaseId, expectedUserId, reloadKey]);
  if (!state)
    return (
      <section className="workspace-correction-unavailable">
        <p className="muted">{availability}</p>
        {detail.purchase.reviewReasons.length > 0 && (
          <>
            <h2>Open questions</h2>
            <ul>
              {detail.purchase.reviewReasons.map((reason) => (
                <li key={reason}>
                  {reviewQuestions[reason] ??
                    "Some source details need review. Uncertain events are excluded from spending."}
                </li>
              ))}
            </ul>
            <a href="/needs-attention">Review questions →</a>
          </>
        )}
      </section>
    );
  if (state.version !== detail.purchase.version)
    return (
      <section className="private-panel">
        <p role="alert">
          This purchase changed after it was loaded. Reload the latest version
          before making a correction.
        </p>
        <button type="button" onClick={onReload}>
          Reload latest version
        </button>
      </section>
    );
  return (
    <section
      className="private-panel workspace-corrections"
      aria-label="Purchase corrections"
    >
      <h2>Corrections and confirmations</h2>
      <p className="workspace-caption">
        {state.origin === "user-supplied" ? "User supplied" : "Source evidence"}{" "}
        · {state.recordStatus}
      </p>
      <details className="workspace-provenance">
        <summary>Record provenance</summary>
        <p>
          Record origin:{" "}
          {state.origin === "user-supplied"
            ? "User supplied"
            : "Source evidence"}
          . Status: {state.recordStatus}. Corrections are retained as explicit
          overrides.
        </p>
      </details>
      {state.overriddenFields.length > 0 && (
        <p>User-corrected fields: {state.overriddenFields.join(", ")}.</p>
      )}
      {state.recordStatus !== "merged" && (
        <>
          <div className="workspace-correction-actions">
            <button
              type="button"
              disabled={mutation.locked}
              onClick={() => setEditor({ kind: "purchase" })}
            >
              Edit purchase details
            </button>
            {state.recordStatus === "active" && (
              <>
                <button
                  type="button"
                  disabled={mutation.locked}
                  onClick={() => setEditor({ kind: "payment" })}
                >
                  Confirm a payment
                </button>
                <button
                  type="button"
                  disabled={mutation.locked}
                  onClick={() => setEditor({ kind: "refund" })}
                >
                  Confirm a refund
                </button>
              </>
            )}
          </div>
          {state.entries.map((entry) => {
            const event = cashEvents(detail).find(
              (event) => event.id === entry.id,
            );
            return (
              <div key={entry.id}>
                <p>
                  {event
                    ? `${event.kind === "payment" ? "Payment" : "Refund"} · ${event.date}`
                    : "Cash event"}{" "}
                  ·{" "}
                  {entry.origin === "user-confirmed"
                    ? "User confirmed"
                    : "Source documented"}
                  {entry.overriddenFields.length > 0 &&
                    ` · User-corrected fields: ${entry.overriddenFields.join(", ")}`}
                </p>
                {event && (
                  <button
                    type="button"
                    disabled={mutation.locked}
                    onClick={() =>
                      setEditor({ kind: event.kind, entryId: entry.id })
                    }
                  >
                    Edit {event.kind} event
                  </button>
                )}
              </div>
            );
          })}
          {editor?.kind === "purchase" && (
            <PurchaseEditor detail={detail} state={state} mutation={mutation} />
          )}
          {editor && editor.kind !== "purchase" && (
            <CashEditor
              key={`${editor.kind}-${editor.entryId ?? editor.review?.id ?? "new"}`}
              kind={editor.kind}
              detail={detail}
              state={state}
              mutation={mutation}
              {...(editor.entryId ? { entryId: editor.entryId } : {})}
              {...(editor.review ? { review: editor.review } : {})}
            />
          )}
          {editor && (
            <button
              type="button"
              disabled={mutation.locked}
              onClick={() => setEditor(null)}
            >
              Cancel editing
            </button>
          )}
          {mutation.notice}
          <details>
            <summary>Inclusion and merge controls</summary>
            <InclusionControl state={state} mutation={mutation} />
            <MergeControl
              state={state}
              mutation={mutation}
              expectedUserId={expectedUserId}
              onSessionChanged={onReload}
            />
          </details>
        </>
      )}
      {state.recordStatus === "merged" && (
        <p>
          This purchase was merged. Open the target purchase to reverse the
          recorded merge.
        </p>
      )}
      <ReviewControls
        reviews={state.reviews}
        purchase={detail.purchase}
        mutation={mutation}
        onCash={(kind, review) => setEditor({ kind, review })}
      />
    </section>
  );
}
