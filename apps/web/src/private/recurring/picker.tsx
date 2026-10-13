import {
  type PurchaseDetail,
  type PurchaseListResponse,
  purchaseDetailSchema,
  purchaseListResponseSchema,
  type RecurringCadence,
} from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { PrivateLoadError, readPrivateForIdentity } from "../api";
import { amount } from "../components";

type Selection = { entryId: string; expectedVersion: number; label: string };
export function PaymentPicker({
  userId,
  onExpired,
  onCreate,
}: {
  userId: string;
  onExpired: () => void;
  onCreate: (
    identity: string,
    cadence: RecurringCadence,
    anchor: string,
    entries: Array<{ entryId: string; expectedVersion: number }>,
  ) => void;
}) {
  const [list, setList] = useState<PurchaseListResponse | null>(null);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [identity, setIdentity] = useState("");
  const [cadence, setCadence] = useState<RecurringCadence>("monthly");
  const [anchor, setAnchor] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void readPrivateForIdentity(
      "/api/purchases?limit=10",
      purchaseListResponseSchema,
      userId,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setList(data);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof PrivateLoadError &&
          (error.status === 401 || error.status === 403)
        )
          onExpired();
        else
          setMessage(
            "Purchase records could not be loaded. Refresh to try again.",
          );
      });
    return () => request.current?.abort();
  }, [userId, onExpired]);
  async function load(id: string | null, cursor?: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setDetail(null);
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    try {
      if (id) {
        const data = await readPrivateForIdentity(
          `/api/purchases/${encodeURIComponent(id)}`,
          purchaseDetailSchema,
          userId,
          controller.signal,
        );
        if (!controller.signal.aborted) setDetail(data);
      } else {
        const data = await readPrivateForIdentity(
          `/api/purchases?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          purchaseListResponseSchema,
          userId,
          controller.signal,
        );
        if (!controller.signal.aborted) setList(data);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        error instanceof PrivateLoadError &&
        (error.status === 401 || error.status === 403)
      ) {
        onExpired();
        return;
      }
      setMessage(
        "Payment evidence could not be loaded. Refresh before continuing.",
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="private-panel recurring-picker"
      aria-labelledby="picker-heading"
    >
      <h2 id="picker-heading">Choose documented payments</h2>
      <p>
        Choose 1 to 20 eligible cash payments from your purchase records.
        Refunds and uncertain events cannot establish a recurring charge. No
        extra mailbox, Drive or AI connection is required.
      </p>
      {message && <p role="alert">{message}</p>}
      {!list && !message && <p role="status">Loading purchases…</p>}
      {list?.rows.map((row) => (
        <div className="recurring-purchase" key={row.id}>
          <a href={`/purchases/${encodeURIComponent(row.id)}`}>
            {row.merchant} · {row.date} · View history
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(row.id)}
          >
            Choose payments from {row.merchant}
          </button>
        </div>
      ))}
      {list?.rows.length === 0 && (
        <p>
          No purchase records on this page. Import history may still be
          incomplete.
        </p>
      )}
      {list?.nextCursor && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(null, list.nextCursor ?? undefined)}
        >
          Next purchases page
        </button>
      )}
      {busy && <p role="status">Loading payment evidence…</p>}
      {detail && (
        <fieldset className="recurring-controls">
          <legend>Payments from {detail.purchase.merchant}</legend>
          {detail.ledgerEntries
            .filter(
              (entry) =>
                entry.kind === "payment" &&
                entry.eligible &&
                detail.purchase.recordStatus === "active",
            )
            .map((entry) => {
              const label = `Payment · ${entry.date} · ${amount(entry.minor, entry.currency)}`;
              return (
                <label className="recurring-check" key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selection.some((s) => s.entryId === entry.id)}
                    disabled={
                      selection.length >= 20 &&
                      !selection.some((s) => s.entryId === entry.id)
                    }
                    onChange={(event) => {
                      setConfirmed(false);
                      setSelection((old) =>
                        event.target.checked
                          ? [
                              ...old.filter((s) => s.entryId !== entry.id),
                              {
                                entryId: entry.id,
                                expectedVersion: entry.version,
                                label: `${detail.purchase.merchant} · ${label}`,
                              },
                            ]
                          : old.filter((s) => s.entryId !== entry.id),
                      );
                    }}
                  />
                  {label}
                </label>
              );
            })}
          {!detail.ledgerEntries.some(
            (e) =>
              e.kind === "payment" &&
              e.eligible &&
              detail.purchase.recordStatus === "active",
          ) && <p>No eligible payments in this purchase.</p>}
        </fieldset>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && selection.length > 0)
            onCreate(
              identity.trim(),
              cadence,
              anchor,
              selection.map(({ entryId, expectedVersion }) => ({
                entryId,
                expectedVersion,
              })),
            );
        }}
      >
        <h3>Review selected payments ({selection.length}/20)</h3>
        <ul>
          {selection.map((entry) => (
            <li key={entry.entryId}>
              {entry.label}{" "}
              <button
                type="button"
                aria-label={`Remove ${entry.label}`}
                onClick={() => {
                  setSelection((old) =>
                    old.filter((s) => s.entryId !== entry.entryId),
                  );
                  setConfirmed(false);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="onboarding-field-grid">
          <label>
            Service identity
            <input
              required
              maxLength={200}
              value={identity}
              onChange={(e) => {
                setIdentity(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            Cadence
            <select
              value={cadence}
              onChange={(e) => {
                setCadence(e.target.value as RecurringCadence);
                setConfirmed(false);
              }}
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </label>
          <label>
            Anchor date
            <input
              required
              type="date"
              value={anchor}
              onChange={(e) => {
                setAnchor(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
        </div>
        <p>
          Use a service or plan identity you recognize. Repeated shopping at one
          merchant alone does not prove a subscription. An annual cadence here
          is your explicit choice, not an inference from one receipt.
        </p>
        <label className="recurring-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I confirm these payments belong to the same service and cadence.
        </label>
        <div className="onboarding-actions">
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              !confirmed ||
              selection.length === 0 ||
              !identity.trim() ||
              !anchor
            }
          >
            Save recurring series
          </button>
        </div>
      </form>
    </section>
  );
}
