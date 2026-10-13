import {
  type CorrectionState,
  exclusionRequestSchema,
  mergeRequestSchema,
  type PurchaseView,
  purchaseListResponseSchema,
  restorationRequestSchema,
  unmergeRequestSchema,
} from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { PrivateLoadError, readPrivateForIdentity } from "./api";
import type { CorrectionMutation } from "./mutations";
export function InclusionControl({
  state,
  mutation,
}: {
  state: CorrectionState;
  mutation: CorrectionMutation;
}) {
  const [reason, setReason] = useState("not-spending");
  const excluded = state.recordStatus === "excluded";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = excluded
          ? restorationRequestSchema.safeParse({ version: state.version })
          : exclusionRequestSchema.safeParse({
              version: state.version,
              reason,
            });
        if (!parsed.success) return mutation.invalid();
        mutation.submit(
          `/api/purchases/${encodeURIComponent(state.purchaseId)}/${excluded ? "restore" : "exclude"}`,
          "POST",
          parsed.data,
        );
      }}
    >
      <h3>
        {excluded
          ? "Excluded from recorded spending"
          : "Include in recorded spending"}
      </h3>
      <p>
        {excluded
          ? "Restore is available only when financial blockers have been addressed."
          : "Exclusion keeps the purchase and its evidence, but removes its events from recorded spending."}
      </p>
      <fieldset disabled={mutation.locked} aria-describedby={mutation.errorId}>
        <legend>
          {excluded ? "Restore inclusion" : "Exclude this purchase"}
        </legend>
        {!excluded && (
          <label>
            Exclusion reason
            <select
              aria-label="Exclusion reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="not-my-purchase">Not my purchase</option>
              <option value="duplicate">Duplicate</option>
              <option value="not-spending">Not spending</option>
              <option value="other">Other</option>
            </select>
          </label>
        )}
        <button type="submit">
          {excluded ? "Restore purchase" : "Exclude purchase"}
        </button>
      </fieldset>
    </form>
  );
}
export function MergeControl({
  state,
  mutation,
  expectedUserId,
  onSessionChanged,
}: {
  state: CorrectionState;
  mutation: CorrectionMutation;
  expectedUserId: string;
  onSessionChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<PurchaseView[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function search() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setMessage("");
    setCandidates([]);
    setSourceId("");
    try {
      const result = await readPrivateForIdentity(
        `/api/purchases?q=${encodeURIComponent(query)}&limit=25`,
        purchaseListResponseSchema,
        expectedUserId,
        request.signal,
      );
      if (!request.signal.aborted) {
        setCandidates(
          result.rows.filter((purchase) => purchase.id !== state.purchaseId),
        );
        if (result.nextCursor)
          setMessage(
            "More records match. Narrow the search to select the right purchase.",
          );
      }
    } catch (error) {
      if (
        error instanceof PrivateLoadError &&
        (error.status === 401 || error.status === 403)
      ) {
        onSessionChanged();
        return;
      }
      if (!request.signal.aborted)
        setMessage("Could not load matching purchases. Try the search again.");
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  return (
    <section>
      <h3>Merge purchase records</h3>
      <p>
        Merge only records that describe the same purchase. The server preserves
        source evidence and unique cash events. Up to{" "}
        {state.capabilities.maxMergeEvents} events and{" "}
        {state.capabilities.maxMergeEvidence} evidence links are supported.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <fieldset disabled={mutation.locked || loading}>
          <legend>Find another purchase</legend>
          <label>
            Find purchase to merge
            <input
              aria-label="Find purchase to merge"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={120}
            />
          </label>
          <button type="submit">Find matching purchases</button>
        </fieldset>
      </form>
      <p role="status">{loading ? "Loading matching purchases…" : message}</p>
      {candidates.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const source = candidates.find(
              (candidate) => candidate.id === sourceId,
            );
            if (!source) return mutation.invalid();
            const parsed = mergeRequestSchema.safeParse({
              target: { id: state.purchaseId, version: state.version },
              source: { id: source.id, version: source.version },
            });
            if (!parsed.success) return mutation.invalid();
            mutation.submit("/api/purchases/merge", "POST", parsed.data);
          }}
        >
          <fieldset disabled={mutation.locked}>
            <legend>Confirm same purchase</legend>
            <label>
              Select purchase to merge
              <select
                aria-label="Select purchase to merge"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                required
              >
                <option value="">Choose a purchase</option>
                {candidates.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.merchant} · {source.date} ·{" "}
                    {source.currency ?? "Currency unknown"}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Merge into this purchase</button>
          </fieldset>
        </form>
      )}
      {state.merges
        .filter((merge) => merge.active && merge.targetId === state.purchaseId)
        .map((merge) => (
          <form
            key={merge.id}
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = unmergeRequestSchema.safeParse({
                mergeId: merge.id,
                version: state.version,
                sourceVersion: merge.sourceVersion,
              });
              if (!parsed.success) return mutation.invalid();
              mutation.submit(
                `/api/purchases/${encodeURIComponent(state.purchaseId)}/unmerge`,
                "POST",
                parsed.data,
              );
            }}
          >
            <p>
              This purchase has a recorded merge. Reversal restores the original
              evidence relationships without creating another payment.
            </p>
            <button type="submit" disabled={mutation.locked}>
              Reverse merge
            </button>
          </form>
        ))}
    </section>
  );
}
