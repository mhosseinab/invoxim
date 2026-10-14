import {
  extractionSchema,
  type ProfileView,
  type PurchaseCoverage,
  type PurchaseDetail,
  type PurchaseListResponse,
  type PurchaseReviews,
  type PurchaseSummary,
  profileViewSchema,
  publicConfigSchema,
  purchaseCoverageSchema,
  purchaseDetailSchema,
  purchaseFiltersSchema,
  purchaseListRequestSchema,
  purchaseListResponseSchema,
  purchaseReviewsSchema,
  purchaseSummarySchema,
} from "@invoxim/contracts";
import { useEffect, useState } from "react";
import { BrandMark, Icon } from "../icons";
import { identityFailure, PrivateLoadError, readPrivate } from "./api";
import { amount, Coverage, isPaused, PurchaseCard, Totals } from "./components";
import {
  categoryLabel,
  paymentStateLabel,
  sourceReasonLabel,
  privateCopy as text,
} from "./copy";
import { Corrections } from "./corrections";
import { Reviews } from "./reviews";
import "./purchases.css";
import "./workspace.css";

type Data = {
  profile: ProfileView;
  coverage: PurchaseCoverage;
  list?: PurchaseListResponse;
  summary?: PurchaseSummary;
  detail?: PurchaseDetail;
  reviews?: PurchaseReviews;
};
type State =
  | { kind: "loading" }
  | { kind: "error"; status: number; loginReady: boolean }
  | { kind: "ready"; data: Data };
const filterNames = [
  "q",
  "from",
  "to",
  "category",
  "currency",
  "mailbox",
  "paymentState",
  "reviewState",
] as const;
function filtersFromUrl() {
  const entries = Object.fromEntries(
    Array.from(new URLSearchParams(window.location.search)).filter(
      ([, value]) => value !== "",
    ),
  );
  return purchaseListRequestSchema.safeParse(entries);
}
function Search({ coverage }: { coverage: PurchaseCoverage }) {
  const current = new URLSearchParams(window.location.search);
  return (
    <form
      className="private-search"
      action={window.location.pathname === "/home" ? "/home" : "/purchases"}
      method="get"
    >
      <label htmlFor="private-search">{text["home.search"]}</label>
      <div className="private-search-line">
        <div className="search-field">
          <Icon name="search" />
          <input
            id="private-search"
            name="q"
            type="search"
            defaultValue={current.get("q") ?? ""}
            placeholder="Merchant or reference"
            maxLength={120}
          />
        </div>
        <button className="primary" type="submit">
          {text.search}
        </button>
      </div>
      <details className="private-filter-details">
        <summary>Filter by date, status or inbox</summary>
        <div className="private-filter-grid">
          <label>
            From
            <input
              name="from"
              type="date"
              defaultValue={current.get("from") ?? ""}
            />
          </label>
          <label>
            To (inclusive)
            <input
              name="to"
              type="date"
              defaultValue={current.get("to") ?? ""}
            />
          </label>
          <label>
            Payment status
            <select
              name="paymentState"
              defaultValue={current.get("paymentState") ?? ""}
            >
              <option value="">All statuses</option>
              <option value="paid">Paid</option>
              <option value="partially_paid">Partially paid</option>
              <option value="unpaid">Unpaid</option>
              <option value="unknown">Unconfirmed</option>
            </select>
          </label>
          <label htmlFor="private-category">
            Category
            <select
              id="private-category"
              aria-label="Category"
              name="category"
              defaultValue={current.get("category") ?? ""}
            >
              <option value="">All categories</option>
              {extractionSchema.shape.records.element.shape.category.options.map(
                (category) => (
                  <option key={category} value={category}>
                    {categoryLabel(category)}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Inbox
            <select name="mailbox" defaultValue={current.get("mailbox") ?? ""}>
              <option value="">All inboxes</option>
              {coverage.connections.map((connection) => (
                <option value={connection.id} key={connection.id}>
                  {connection.address}
                </option>
              ))}
            </select>
          </label>
          <label>
            Currency
            <input
              name="currency"
              pattern="[A-Z]{3}"
              maxLength={3}
              defaultValue={current.get("currency") ?? ""}
              placeholder="EUR"
            />
          </label>
          <label>
            Review
            <select
              name="reviewState"
              defaultValue={current.get("reviewState") ?? ""}
            >
              <option value="">All records</option>
              <option value="open">Needs attention</option>
              <option value="clear">Clear</option>
            </select>
          </label>
        </div>
      </details>
      {current.size > 0 && <a href={window.location.pathname}>Reset filters</a>}
    </form>
  );
}
function Detail({
  detail,
  onReload,
  expectedUserId,
}: {
  detail: PurchaseDetail;
  onReload: () => void;
  expectedUserId: string;
}) {
  const purchase = detail.purchase;
  return (
    <div className="workspace-detail">
      <a href="/purchases">← Back to purchases</a>
      <section className="private-heading workspace-detail-heading">
        <div>
          <p className="eyebrow">
            {purchase.date} · {purchase.evidenceCount}{" "}
            {purchase.evidenceCount === 1
              ? text.supportingDocument
              : text.supportingDocuments}
          </p>
          <h1>{purchase.merchant}</h1>
          <p>
            {categoryLabel(purchase.category)}
            {purchase.invoiceReference &&
              ` · Invoice ${purchase.invoiceReference}`}
            {purchase.orderReference && ` · Order ${purchase.orderReference}`}
          </p>
          <span className="status">
            {paymentStateLabel(purchase.paymentState)}
          </span>
        </div>
        {purchase.documentTotalMinor !== null && purchase.currency && (
          <div className="workspace-detail-document">
            <span>{text["purchase.documentTotal"]}</span>
            <strong>
              {amount(purchase.documentTotalMinor, purchase.currency)}
            </strong>
          </div>
        )}
      </section>
      {purchase.origin === "user-supplied" && (
        <p className="notice">{text["manualSource.userSuppliedRecord"]}</p>
      )}
      <div className="workspace-detail-finances">
        <Totals values={purchase.lifecycle} label={text.lifecycle} />
      </div>
      {purchase.paymentState === "unpaid" && (
        <p className="workspace-caption">{text["purchase.unpaid"]}</p>
      )}
      {purchase.paymentState === "unknown" && (
        <p className="workspace-caption">
          Payment is unconfirmed. The document total is not counted as a
          payment.
        </p>
      )}
      {detail.ledgerEntries.some(
        (entry) => entry.origin === "user-confirmed",
      ) && (
        <section
          className="private-panel"
          aria-label="User-confirmed cash events"
        >
          <h2>Manual confirmations</h2>
          <p>
            These cash events were confirmed by you. No source document was
            created for the confirmation.
          </p>
          <ul>
            {detail.ledgerEntries
              .filter((entry) => entry.origin === "user-confirmed")
              .map((entry) => (
                <li key={entry.id}>
                  {entry.kind === "payment" ? "Payment" : "Refund"} ·{" "}
                  {amount(entry.minor, entry.currency)} · {entry.date} · User
                  confirmed
                  {entry.dateBasis === "user-corrected-date" &&
                    " · Date corrected by you"}
                  {!entry.eligible && " · Excluded from spending"}
                </li>
              ))}
          </ul>
        </section>
      )}
      {detail.manualEvidence.length > 0 && (
        <section
          className="private-panel"
          aria-label={text["manualSource.title"]}
        >
          <h2>{text["manualSource.title"]}</h2>
          <p>{text["manualSource.associationNotice"]}</p>
          <ul>
            {detail.manualEvidence.map((evidence) => (
              <li key={evidence.documentId}>
                <h3>{text["manualSource.document"]}</h3>
                <p>
                  {text["manualSource.sourceLabel"]}: {evidence.source.provider}
                </p>
                <p>
                  <strong>{text["purchase.originalUnavailable"]}</strong>
                </p>
                <p className="muted">
                  {sourceReasonLabel(evidence.source.reason)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="workspace-detail-content">
        <section className="private-panel workspace-evidence">
          <h2>Purchase timeline</h2>
          <p className="muted">
            Supporting source records and documented events. Pending refunds do
            not reduce the net.
          </p>
          <ol className="private-timeline">
            {detail.timeline.map((item) => (
              <li key={item.observationId}>
                <p className="eyebrow">{item.date ?? "Date not available"}</p>
                <h3>{item.documentType.replaceAll("-", " ")}</h3>
                {item.refundEvidence === "pending" && (
                  <p className="notice">{text.pendingRefund}</p>
                )}
                {item.events.map((event) => (
                  <p key={event.id}>
                    {event.kind === "payment"
                      ? "Payment documented"
                      : "Refund documented"}{" "}
                    · {amount(event.minor, event.currency)} · {event.date}
                    {!event.eligible && " · Excluded from spending"}
                  </p>
                ))}
                <p>
                  <strong>{text["purchase.originalUnavailable"]}</strong>
                </p>
                <details>
                  <summary>{text["purchase.why"]}</summary>
                  <p className="muted">
                    {sourceReasonLabel(item.source.reason)}
                  </p>

                  <p>
                    Source: {item.source.provider}. Relationship:{" "}
                    {item.relationship.replaceAll("_", " ")}. Evidence:{" "}
                    {item.evidenceCode.replaceAll("_", " ")}. Review:{" "}
                    {item.reviewState.replaceAll("_", " ")}. Event dates follow
                    the supporting evidence.
                  </p>
                </details>
              </li>
            ))}
          </ol>
        </section>
        <details className="workspace-about">
          <summary>About these amounts</summary>
          <p>{text["home.spendingCaption"]}</p>
          <p>
            The document total describes the purchase. Paid and refunded amounts
            describe documented financial events.
          </p>
          <p>Opening originals is not available on this screen yet.</p>
        </details>
      </div>
      <Corrections
        detail={detail}
        onReload={onReload}
        expectedUserId={expectedUserId}
      />
    </div>
  );
}
export function PrivatePage({ displayName }: { displayName: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const path = window.location.pathname;
  const connectionPage = path === "/connections";
  const attentionPage = path === "/needs-attention";
  const detailId = path.startsWith("/purchases/")
    ? path.slice("/purchases/".length)
    : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a re-fetch trigger, not a value read in the body
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const filters = filtersFromUrl();
        if (!filters.success && !detailId && !connectionPage && !attentionPage)
          throw new PrivateLoadError(400);
        const profile = await readPrivate(
          "/api/me",
          profileViewSchema,
          controller.signal,
        );
        const coverage = await readPrivate(
          "/api/purchases/coverage",
          purchaseCoverageSchema,
          controller.signal,
        );
        const data: Data = { profile, coverage };
        if (attentionPage)
          data.reviews = await readPrivate(
            "/api/purchase-reviews?limit=25",
            purchaseReviewsSchema,
            controller.signal,
          );
        else if (detailId)
          data.detail = await readPrivate(
            `/api/purchases/${encodeURIComponent(decodeURIComponent(detailId))}`,
            purchaseDetailSchema,
            controller.signal,
          );
        else if (!connectionPage && filters.success) {
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(filters.data))
            if (value !== undefined && value !== "")
              query.set(key, String(value));
          const summaryQuery = new URLSearchParams();
          const selected = purchaseFiltersSchema.parse(
            Object.fromEntries(
              filterNames.flatMap((key) =>
                filters.data[key] === undefined
                  ? []
                  : [[key, filters.data[key]]],
              ),
            ),
          );
          for (const [key, value] of Object.entries(selected))
            if (value !== undefined && value !== "")
              summaryQuery.set(key, String(value));
          [data.list, data.summary] = await Promise.all([
            readPrivate(
              `/api/purchases?${query}`,
              purchaseListResponseSchema,
              controller.signal,
            ),
            readPrivate(
              `/api/purchases/summary?${summaryQuery}`,
              purchaseSummarySchema,
              controller.signal,
            ),
          ]);
        }
        const currentProfile = await readPrivate(
          "/api/me",
          profileViewSchema,
          controller.signal,
        );
        if (currentProfile.user.id !== profile.user.id)
          throw new PrivateLoadError(401);
        data.profile = currentProfile;
        if (active) setState({ kind: "ready", data });
      } catch (error) {
        const status = error instanceof PrivateLoadError ? error.status : 502;
        let loginReady = false;
        if (active && !controller.signal.aborted && identityFailure(status)) {
          try {
            const config = await readPrivate(
              "/api/public-config",
              publicConfigSchema,
              controller.signal,
            );
            loginReady = config.loginEnabled;
          } catch {
            // Unavailable or invalid capabilities cannot enable login.
          }
        }
        if (active && !controller.signal.aborted)
          setState({
            kind: "error",
            status,
            loginReady,
          });
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [revision, detailId, connectionPage, attentionPage]);
  function refresh() {
    setState({ kind: "loading" });
    setRevision((value) => value + 1);
  }
  useEffect(() => {
    function revalidate() {
      setState({ kind: "loading" });
      setRevision((value) => value + 1);
    }
    function visibility() {
      if (document.visibilityState === "visible") revalidate();
    }
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <div
      className={`app-frame private-app workspace-page${!detailId && !connectionPage && !attentionPage ? " purchase-list-page" : ""}`}
    >
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="wordmark" href="/home">
          <BrandMark />
          {displayName}
        </a>
        <nav className="sidebar-nav" aria-label="Main">
          {[
            ["/home", "Home", "home"],
            ["/purchases", "Purchases", "document"],
            ["/connections", "Connections", "link"],
            ["/needs-attention", "Needs attention", "review"],
          ].map(([href, label]) => (
            <a
              href={href}
              key={href}
              aria-current={path === href ? "page" : undefined}
            >
              <Icon
                name={
                  href === "/home"
                    ? "home"
                    : href === "/purchases"
                      ? "document"
                      : href === "/needs-attention"
                        ? "review"
                        : "connections"
                }
              />
              {label}
            </a>
          ))}
        </nav>
        <section className="sidebar-privacy">
          <Icon name="lock" />
          <h2>Your private purchase records</h2>
          <p>{text["home.spendingCaption"]}</p>
          <a href="/#privacy">Privacy details →</a>
        </section>
      </aside>
      <div className="app-stage">
        <header className="topbar">
          <p className="eyebrow">Private workspace</p>
          {state.kind === "ready" && (
            <span className="private-account">
              {state.data.profile.user.email}
            </span>
          )}
          <button type="button" onClick={refresh}>
            {text.refresh}
          </button>
        </header>
        <main id="content">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`private-load-status${state.kind === "ready" ? " purchase-ready-status" : ""}`}
          >
            {state.kind === "loading"
              ? text.loading
              : state.kind === "error"
                ? "Records could not be loaded."
                : `${state.data.coverage.readyPurchaseCount} purchase records ready.${state.data.coverage.connections.some(isPaused) ? " Processing is paused. Existing records remain available." : ""}`}
          </p>
          {state.kind === "error" && (
            <section className="private-panel" role="alert">
              <h1>
                {state.status === 400
                  ? "Check your filters"
                  : "Workspace unavailable"}
              </h1>
              <p>
                {state.status === 400
                  ? text.invalidFilters
                  : identityFailure(state.status)
                    ? text.signedOut
                    : state.status === 503
                      ? text.unavailable
                      : text.failed}
              </p>
              {identityFailure(state.status) &&
                (state.loginReady ? (
                  <a className="primary" href="/onboarding">
                    {text.signIn}
                  </a>
                ) : (
                  <p>{text.loginUnavailable}</p>
                ))}
              <a className="primary" href="/demo">
                Try an example
              </a>
            </section>
          )}
          {state.kind === "ready" &&
            (state.data.reviews ? (
              <Reviews
                data={state.data.reviews}
                onReload={refresh}
                expectedUserId={state.data.profile.user.id}
              />
            ) : state.data.detail ? (
              <Detail
                detail={state.data.detail}
                onReload={refresh}
                expectedUserId={state.data.profile.user.id}
              />
            ) : connectionPage ? (
              <>
                <h1>{text.connections}</h1>
                <p className="workspace-introduction">
                  Mailbox access and receipt import status.
                </p>
                <Coverage coverage={state.data.coverage} full />
              </>
            ) : (
              <>
                <section className="private-heading">
                  <h1>{path === "/home" ? text.home : text.purchases}</h1>
                </section>
                <Search coverage={state.data.coverage} />
                <Coverage coverage={state.data.coverage} />
                <section
                  aria-label="Purchase records"
                  className="private-records"
                >
                  <div className="section-heading">
                    <h2>
                      {path === "/home"
                        ? "Recent purchases"
                        : "Purchase records"}
                    </h2>
                    <span>
                      {state.data.list?.rows.length ?? 0} records on this page
                    </span>
                  </div>
                  {state.data.list?.rows.map((purchase) => (
                    <PurchaseCard key={purchase.id} purchase={purchase} />
                  ))}
                  {state.data.list?.rows.length === 0 && (
                    <p>
                      {window.location.search ? text.noMatch : text.noRecords}
                    </p>
                  )}
                  {state.data.list?.nextCursor && (
                    <form method="get" action={path}>
                      {Array.from(new URLSearchParams(window.location.search))
                        .filter(([key]) => key !== "cursor")
                        .map(([key, value]) => (
                          <input
                            type="hidden"
                            key={key}
                            name={key}
                            value={value}
                          />
                        ))}
                      <input
                        type="hidden"
                        name="cursor"
                        value={state.data.list.nextCursor}
                      />
                      <button type="submit">Next page</button>
                    </form>
                  )}
                </section>
                {state.data.summary && (
                  <section
                    aria-label="Recorded spending"
                    className="private-panel private-summary"
                  >
                    <h2>{text["home.spendingLabel"]}</h2>
                    <details className="compact-spending-details">
                      <summary>{text.spendingDetails}</summary>
                      <p>{text["home.spendingCaption"]}</p>
                      <p>
                        {text.period}{" "}
                        {new URLSearchParams(window.location.search).get(
                          "from",
                        ) ?? "All available dates"}{" "}
                        —{" "}
                        {new URLSearchParams(window.location.search).get(
                          "to",
                        ) ?? "present"}
                      </p>
                      <p className="muted">{text.notConverted}</p>
                    </details>
                    {state.data.summary.totals.length > 0 ? (
                      <Totals
                        values={state.data.summary.totals}
                        label="In the selected range"
                      />
                    ) : (
                      <p>{text.noEvents}</p>
                    )}
                    <p className="compact-spending-counts">
                      {state.data.summary.unpaidCount} unpaid ·{" "}
                      {state.data.summary.unknownCount} unconfirmed ·{" "}
                      {state.data.summary.reviewCount} need attention ·{" "}
                      {state.data.summary.excludedEntryCount} excluded events
                    </p>
                    {state.data.summary.missingCurrencyCount > 0 && (
                      <p className="notice">
                        {state.data.summary.missingCurrencyCount} records have
                        no confirmed currency and are excluded from totals.
                      </p>
                    )}
                  </section>
                )}
              </>
            ))}
        </main>
      </div>
    </div>
  );
}
