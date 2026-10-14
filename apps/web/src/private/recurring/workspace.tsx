import {
  type RecurringCadence,
  type RecurringDecisionInput,
  recurringCreateSchema,
  type recurringDetailResponseSchema,
  type recurringListResponseSchema,
  type recurringRecordSchema,
  recurringWriteResponseSchema,
} from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { assertPrivateIdentity, identityFailure, PrivateLoadError } from "../api";
import { amount } from "../components";
import { PaymentPicker } from "./picker";
import "./styles.css";

type RecordView = typeof recurringRecordSchema._output;
type Props = {
  userId: string;
  list: typeof recurringListResponseSchema._output | undefined;
  detail: typeof recurringDetailResponseSchema._output | undefined;
  refresh: () => void;
};
export function RecurringWorkspace({ userId, list, detail, refresh }: Props) {
  const [message, setMessage] = useState("");
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  const token = list?.mutationToken ?? detail?.mutationToken ?? "";
  async function save(path: string, method: "POST" | "PATCH", body: unknown) {
    if (inFlight.current || locked || !token) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const controller = new AbortController();
    request.current = controller;
    try {
      await assertPrivateIdentity(userId, controller.signal);
      const response = await fetch(path, {
        method,
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Workspace-Token": token,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      await assertPrivateIdentity(userId, controller.signal);
      if (identityFailure(response.status)) {
        refresh();
        return;
      }
      if (!response.ok) {
        if (response.status === 409) throw new PrivateLoadError(409);
        if (response.status === 503) throw new PrivateLoadError(503);
        if (response.status >= 500) throw new PrivateLoadError(502);
        setMessage(
          "The selection could not be accepted. Check the payment evidence, service identity and dates.",
        );
        return;
      }
      if (
        !recurringWriteResponseSchema.safeParse(await response.json()).success
      )
        throw new PrivateLoadError(502);
      refresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (identityFailure(error)) {
        refresh();
        return;
      }
      setLocked(true);
      setMessage(
        error instanceof PrivateLoadError && error.status === 409
          ? "The series or payment evidence changed. Refresh and review before submitting a new decision."
          : error instanceof PrivateLoadError && error.status === 503
            ? "Recurring payments are unavailable in this workspace. Refresh before continuing."
            : "The request result is unknown. Refresh to check the saved records before making another decision.",
      );
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <p className="notice">
        Automatic suggestions are unavailable. Choose documented payments and
        confirm their service identity yourself. Saving or canceling a series
        does not change historical spending or contact the service provider.
      </p>
      {message && (
        <p id="recurring-error" role="alert">
          {message}
        </p>
      )}
      {locked && (
        <button type="button" onClick={refresh}>
          Refresh and review latest evidence
        </button>
      )}
      <fieldset
        className="recurring-controls"
        disabled={busy || locked}
        aria-describedby={message ? "recurring-error" : undefined}
      >
        <legend>Saved recurring records</legend>
        {(detail ? [detail.record] : (list?.records ?? [])).map((record) => (
          <Series
            key={record.series.id}
            record={record}
            decide={(state) => {
              const body: RecurringDecisionInput = {
                expectedVersion: record.series.version,
                state,
              };
              void save(
                `/api/recurring/${encodeURIComponent(record.series.id)}`,
                "PATCH",
                body,
              );
            }}
          />
        ))}
        {list?.records.length === 0 && (
          <p>
            No saved recurring series. This does not mean you have no
            subscriptions.
          </p>
        )}
        {list && (
          <p>
            Up to 10 series on this page. Pages reflect current records and may
            change as evidence changes.
          </p>
        )}
        {list?.nextCursor && (
          <a href={`/recurring?after=${encodeURIComponent(list.nextCursor)}`}>
            Next recurring page
          </a>
        )}
        {detail ? (
          <p>
            <a href="/recurring">Back to recurring records</a>
          </p>
        ) : (
          <PaymentPicker
            userId={userId}
            onExpired={refresh}
            onCreate={(
              identityKey: string,
              cadence: RecurringCadence,
              anchorDate: string,
              entries: Array<{ entryId: string; expectedVersion: number }>,
            ) => {
              const input = recurringCreateSchema.safeParse({
                id: crypto.randomUUID(),
                identityKey,
                cadence,
                anchorDate,
                entries,
              });
              if (!input.success) {
                setMessage(
                  "Check the service identity, anchor date and selection of 1 to 20 payments.",
                );
                return;
              }
              void save("/api/recurring", "POST", input.data);
            }}
          />
        )}
      </fieldset>
      {busy && <p role="status">Saving recurring decision…</p>}
    </>
  );
}
function Series({
  record,
  decide,
}: {
  record: RecordView;
  decide: (state: "confirmed" | "dismissed" | "paused" | "canceled") => void;
}) {
  const series = record.series;
  const projection = record.status === "current" ? record.projection : null;
  const valid = projection?.status === "series" ? projection : null;
  return (
    <article
      className="private-panel recurring-series"
      aria-label={`${series.identity_key} recurring series`}
    >
      <div className="section-heading">
        <h2>
          <a href={`/recurring/${encodeURIComponent(series.id)}`}>
            {series.identity_key}
          </a>
        </h2>
        <span className="status">{series.state}</span>
      </div>
      <p>
        {series.currency} · {series.cadence} · Anchor {series.anchor_date} ·{" "}
        {series.selected_entry_count} selected payments
      </p>
      {record.status === "stale" ? (
        <p className="notice">
          Evidence changed. Estimates are unavailable until the payment evidence
          is reviewed.
        </p>
      ) : projection?.status === "insufficient" ? (
        <p>
          Estimate unavailable: {projection.reason.replaceAll("_", " ")}. Review
          the selected evidence.
        </p>
      ) : (
        valid && (
          <>
            <p>
              Last evidenced payment:{" "}
              {amount(valid.lastPayment.amountMinor, valid.currency)} ·{" "}
              {valid.lastPayment.eventDate}
            </p>
            <a
              href={`/purchases/${encodeURIComponent(valid.lastPayment.purchaseId)}`}
            >
              View last payment history
            </a>
            {valid.forecast ? (
              <dl className="money-row">
                <div>
                  <dt>Monthly estimate:</dt>
                  <dd>{amount(valid.forecast.monthlyMinor, valid.currency)}</dd>
                </div>
                <div>
                  <dt>Annual estimate:</dt>
                  <dd>{amount(valid.forecast.annualMinor, valid.currency)}</dd>
                </div>
                <div>
                  <dt>Next date estimate</dt>
                  <dd>{valid.forecast.estimatedNextDate ?? "Unavailable"}</dd>
                </div>
              </dl>
            ) : (
              <p>No forecast for this series state.</p>
            )}
            <p className="muted">
              Estimates use the last evidenced payment. Future charges are not
              guaranteed. Charge-basis comparison is unavailable for
              user-selected payments; no price increase or unused-service claim
              is made.
            </p>
          </>
        )
      )}
      <div className="onboarding-actions">
        {(
          [
            ["confirmed", "Confirm"],
            ["dismissed", "Dismiss"],
            ["paused", "Pause"],
            ["canceled", "Mark canceled"],
          ] as const
        ).map(([state, label]) => (
          <button
            key={state}
            type="button"
            disabled={
              series.state === state ||
              (record.status === "stale" && state === "confirmed")
            }
            onClick={() => decide(state)}
          >
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}
