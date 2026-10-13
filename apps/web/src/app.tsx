import { type PublicConfig, publicConfigSchema } from "@invoxim/contracts";
import { useEffect, useRef, useState } from "react";
import { copy } from "./copy";
import type { DemoPurchase } from "./demo";
import { demo, money, totals } from "./demo";
import { BrandMark, Icon } from "./icons";
import { OnboardingPage } from "./onboarding/page";
import { readPrivate } from "./private/api";
import { PrivatePage } from "./private/page";
import { RecurringPage } from "./private/recurring/page";

const unavailable = copy["release.unavailable"];

function Availability() {
  const [loginAvailable, setLoginAvailable] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    void readPrivate("/api/public-config", publicConfigSchema, request.signal)
      .then((config) => {
        if (!request.signal.aborted) setLoginAvailable(config.loginEnabled);
      })
      .catch(() => {
        if (!request.signal.aborted) setLoginAvailable(false);
      });
    return () => request.abort();
  }, []);
  if (loginAvailable)
    return (
      <div className="availability">
        <a href="/onboarding">Sign in with Google</a>
        <p>Sign in to your private workspace, then choose a receipt inbox.</p>
      </div>
    );
  return (
    <div className="availability">
      <button type="button" disabled aria-describedby="release-note">
        {copy["landing.cta.beta"]}
      </button>
      <p id="release-note">
        {unavailable} {copy["release.liveUnavailable"]}{" "}
      </p>
    </div>
  );
}

function Purchase({
  purchase,
  preview = false,
  historyOpen = false,
}: {
  purchase: DemoPurchase;
  preview?: boolean;
  historyOpen?: boolean;
}) {
  const amount = totals(purchase);
  const unpaid = amount.paidMinor === "0";
  return (
    <article
      aria-label={`${purchase.merchant} ${copy["purchase.recordNoun"]}`}
      className="purchase"
    >
      <div className="purchase-heading">
        <span className="merchant-mark">
          <Icon name="document" />
        </span>
        <div>
          <p className="eyebrow">
            {purchase.date} · {demo.currency}
          </p>
          <h3>{purchase.merchant}</h3>
        </div>
        <span className="status">
          {unpaid
            ? copy["purchase.unpaidInvoice"]
            : copy["purchase.paymentDocumented"]}
        </span>
      </div>
      <dl className="money-row">
        <div>
          <dt>{copy["purchase.paid"]}</dt>
          <dd>{money(amount.paidMinor)}</dd>
        </div>
        <div>
          <dt>{copy["purchase.refunded"]}</dt>
          <dd>{money(amount.refundedMinor)}</dd>
        </div>
        <div>
          <dt>{copy["purchase.net"]}</dt>
          <dd data-testid="purchase-net">{money(amount.netMinor)}</dd>
        </div>
      </dl>
      {unpaid && (
        <p className="notice">
          <span>{copy["purchase.unpaid"]}</span> ·{" "}
          {copy["purchase.documentTotal"]}: {money(purchase.documentTotalMinor)}
        </p>
      )}
      {preview ? (
        <p className="muted"> {copy["demo.previewHistory"]} </p>
      ) : (
        <details className="history" open={historyOpen || undefined}>
          <summary> {copy["purchase.viewHistory"]} </summary>
          <p>{copy["purchase.lifecycle"]}</p>
          <p>
            {copy["purchase.documentTotal"]}:{" "}
            {money(purchase.documentTotalMinor)}
          </p>
          <ol className="timeline">
            {purchase.evidenceIds.map((id) => {
              const evidence = demo.evidence.find((item) => item.id === id);
              if (!evidence) throw new Error("Missing synthetic evidence");
              const entry = demo.ledgerEntries.find(
                (item) => item.evidenceId === id,
              );
              const labels = {
                order: copy["timeline.order"],
                invoice: copy["timeline.invoice"],
                payment: copy["purchase.paymentDocumented"],
                refund: copy["timeline.refund"],
                unpaid_invoice: copy["purchase.unpaidInvoice"],
              };
              return (
                <li key={id}>
                  <details>
                    <summary>
                      {labels[evidence.kind]}
                      {entry ? ` · ${entry.date}` : ""}
                    </summary>
                    <p className="eyebrow">{copy["demo.syntheticEvidence"]}</p>
                    <p className="evidence">{evidence.text}</p>
                  </details>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </article>
  );
}

function Landing() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow"> {copy["landing.previewEyebrow"]} </p>
        <h1>{copy["landing.headline"]}</h1>
        <p className="lead">{copy["landing.description"]}</p>
        <a className="primary" href="/demo">
          {copy["landing.cta.example"]}
          <span aria-hidden="true"> ↗</span>
        </a>
        <Availability />
      </section>
      <section className="preview" aria-labelledby="preview-title">
        <div className="section-heading">
          <h2 id="preview-title"> {copy["landing.previewTitle"]} </h2>
          <span className="example-label"> {copy["demo.shortLabel"]} </span>
        </div>
        <Purchase purchase={demo.purchases[0]} preview />
        <p className="muted">{copy["demo.banner"]}</p>
      </section>
      <section id="how-it-works" className="explanation">
        <h2> {copy["landing.outcomesTitle"]} </h2>
        <div className="outcomes">
          <div>
            <h3> {copy["landing.findTitle"]} </h3>
            <p> {copy["landing.findDescription"]} </p>
          </div>
          <div>
            <h3> {copy["landing.amountsTitle"]} </h3>
            <p> {copy["landing.amountsDescription"]} </p>
          </div>
        </div>
        <h3> {copy["landing.futureTitle"]} </h3>
        <ol className="steps">
          <li> {copy["landing.stepSignin"]} </li>
          <li> {copy["landing.stepConnect"]} </li>
          <li> {copy["landing.stepStart"]} </li>
        </ol>
        <p> {copy["landing.futureHistory"]} </p>
      </section>
      <section id="privacy" className="explanation">
        <h2> {copy["privacy.title"]} </h2>
        <p> {copy["privacy.example"]} </p>
        <details>
          <summary> {copy["privacy.mailboxQuestion"]} </summary>
          <p>{copy["mailbox.permission"]}</p>
          <p> {copy["privacy.startExplanation"]} </p>
        </details>
        <details>
          <summary> {copy["privacy.coverageQuestion"]} </summary>
          <p> {copy["privacy.coverageExplanation"]} </p>
        </details>
        <details>
          <summary> {copy["privacy.originalsQuestion"]} </summary>
          <p>
            {copy["import.review.originals"]}{" "}
            {copy["drive.previewUnavailable"]}{" "}
          </p>
        </details>
        <details>
          <summary> {copy["privacy.integrationsQuestion"]} </summary>
          <p> {copy["privacy.integrationsUnavailable"]} </p>
        </details>
      </section>
    </>
  );
}

type PaymentStatus = "all" | "paid" | "unpaid" | "refunded";
const statusOptions = [
  ["all", "demo.filterAll"],
  ["paid", "demo.filterPaid"],
  ["unpaid", "purchase.filterUnpaid"],
  ["refunded", "demo.filterRefunded"],
] as const;

function matchesStatus(purchase: DemoPurchase, status: PaymentStatus) {
  const amount = totals(purchase);
  if (status === "paid") return amount.paidMinor !== "0";
  if (status === "unpaid") return amount.paidMinor === "0";
  if (status === "refunded") return amount.refundedMinor !== "0";
  return true;
}

function DemoPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PaymentStatus>("all");
  const [guidedStatus, setGuidedStatus] = useState<PaymentStatus | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const summary = totals();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const purchases = demo.purchases.filter((purchase) => {
    const evidence = demo.evidence.filter((item) =>
      purchase.evidenceIds.some((id) => id === item.id),
    );
    const searchable = [
      purchase.merchant,
      purchase.date,
      ...evidence.flatMap((item) => [item.id, item.text]),
    ]
      .join(" ")
      .toLowerCase();
    return (
      tokens.every((token) => searchable.includes(token)) &&
      matchesStatus(purchase, status)
    );
  });
  function resetFilters() {
    setQuery("");
    setStatus("all");
    setGuidedStatus(null);
    searchInput.current?.focus();
  }
  function explore(nextStatus: PaymentStatus) {
    setQuery("");
    setStatus(nextStatus);
    setGuidedStatus(nextStatus);
    requestAnimationFrame(() => {
      const results = document.getElementById("purchase-results");
      results?.focus();
      results?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }
  return (
    <>
      <div className="demo-banner">{copy["demo.banner"]}</div>
      <section className="demo-heading">
        <p className="eyebrow"> {copy["demo.dateCaption"]} </p>
        <h1>{copy["demo.purchasesRegion"]}</h1>
        <p>{copy["demo.searchInstruction"]}</p>
      </section>
      <div className="demo-columns">
        <div className="records-column">
          <section aria-label={copy["demo.searchRegion"]} className="filters">
            <div>
              <label htmlFor="search">{copy["home.search"]}</label>
              <div className="search-field">
                <Icon name="search" />
                <input
                  ref={searchInput}
                  id="search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy["demo.searchPlaceholder"]}
                />
                {query && (
                  <button
                    className="clear-search"
                    type="button"
                    aria-label={copy["demo.clearSearch"]}
                    onClick={() => {
                      setQuery("");
                      searchInput.current?.focus();
                    }}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </div>
            </div>
            <fieldset className="status-filters">
              <legend className="filter-label">
                {copy["purchase.statusLabel"]}
              </legend>
              <div className="filter-chips">
                {statusOptions.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={status === value}
                    onClick={() => {
                      setStatus(value);
                      setGuidedStatus(null);
                    }}
                  >
                    {copy[label]}
                    <span aria-hidden="true">
                      {
                        demo.purchases.filter((purchase) =>
                          matchesStatus(purchase, value),
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
            {(query || status !== "all") && (
              <button
                className="reset-filters"
                type="button"
                onClick={resetFilters}
              >
                {copy["demo.resetFilters"]}
              </button>
            )}
          </section>
          <section
            id="purchase-results"
            tabIndex={-1}
            aria-label={copy["demo.purchasesRegion"]}
          >
            <p className="result-count" role="status">
              {copy[
                purchases.length === 1 ? "demo.countOne" : "demo.countMany"
              ].replace("{count}", String(purchases.length))}
            </p>
            <div className="purchase-list">
              {purchases.map((purchase) => (
                <Purchase
                  key={purchase.id}
                  purchase={purchase}
                  historyOpen={
                    guidedStatus !== null &&
                    matchesStatus(purchase, guidedStatus)
                  }
                />
              ))}
            </div>
            {purchases.length === 0 && (
              <div className="empty-results">
                <Icon name="search" />
                <p>{copy["demo.emptySearch"]}</p>
                <button type="button" onClick={resetFilters}>
                  {copy["demo.showAll"]}
                </button>
              </div>
            )}
          </section>
        </div>
        <aside className="insight-column">
          <section
            id="spending-summary"
            tabIndex={-1}
            className="spending"
            aria-labelledby="spending-title"
          >
            <span className="panel-icon">
              <Icon name="chart" />
            </span>
            <p className="eyebrow"> {copy["demo.summaryRange"]} </p>
            <h2 id="spending-title">{copy["home.spendingLabel"]}</h2>
            <p>{copy["home.spendingCaption"]}</p>
            <dl className="money-row">
              <div>
                <dt>{copy["purchase.paid"]}</dt>
                <dd data-testid="summary-paid">{money(summary.paidMinor)}</dd>
              </div>
              <div>
                <dt>{copy["purchase.refunded"]}</dt>
                <dd data-testid="summary-refunded">
                  {money(summary.refundedMinor)}
                </dd>
              </div>
              <div>
                <dt>{copy["purchase.net"]}</dt>
                <dd data-testid="summary-net">{money(summary.netMinor)}</dd>
              </div>
            </dl>
            <p className="muted"> {copy["demo.summaryExplanation"]} </p>
          </section>
          <section
            className="read-only"
            aria-label={copy["demo.actionsRegion"]}
          >
            <span className="panel-icon">
              <Icon name="shield" />
            </span>
            <h2> {copy["demo.exploreTitle"]} </h2>
            <p>{copy["demo.exploreDescription"]}</p>
            <div className="guided-actions">
              <button
                type="button"
                onClick={() => explore("refunded")}
                aria-describedby="refund-guide-description"
              >
                {copy["demo.seeRefund"]}
                <span aria-hidden="true"> →</span>
              </button>
              <p id="refund-guide-description">{copy["demo.refundGuide"]}</p>
              <button
                type="button"
                onClick={() => explore("unpaid")}
                aria-describedby="unpaid-guide-description"
              >
                {copy["demo.findUnpaid"]}
                <span aria-hidden="true"> →</span>
              </button>
              <p id="unpaid-guide-description">{copy["demo.unpaidGuide"]}</p>
            </div>
            <p className="example-note">{copy["demo.localOnly"]}</p>
          </section>
        </aside>
      </div>
    </>
  );
}

export function App({
  displayName = copy["product.workingName"],
}: {
  displayName?: PublicConfig["displayName"];
}) {
  const path = window.location.pathname;
  if (path === "/recurring" || path.startsWith("/recurring/"))
    return <RecurringPage displayName={displayName} />;
  if (path === "/onboarding" || path === "/onboarding/review")
    return <OnboardingPage displayName={displayName} />;
  if (
    path === "/home" ||
    path === "/purchases" ||
    path.startsWith("/purchases/") ||
    path === "/connections" ||
    path === "/needs-attention"
  )
    return <PrivatePage displayName={displayName} />;
  const example = path === "/demo";
  return (
    <div
      className={example ? "app-frame example-app" : "app-frame landing-app"}
    >
      <a className="skip" href="#content">
        {" "}
        {copy["navigation.skip"]}{" "}
      </a>
      {example && (
        <aside className="sidebar">
          <a className="wordmark" href="/">
            <BrandMark />
            {displayName}
          </a>
          <nav aria-label={copy["navigation.main"]} className="sidebar-nav">
            <a href="/demo" aria-current="page">
              <Icon name="document" />
              {copy["navigation.purchases"]}
            </a>
            <a href="#spending-summary">
              <Icon name="chart" />
              {copy["navigation.summary"]}
            </a>
            <a href="/#privacy">
              <Icon name="shield" />
              {copy["navigation.privacy"]}
            </a>
          </nav>
          <section className="sidebar-privacy">
            <span className="panel-icon">
              <Icon name="lock" />
            </span>
            <h2>{copy["demo.privacyTitle"]}</h2>
            <p>{copy["demo.privacyCaption"]}</p>
            <a href="/#privacy">
              {copy["navigation.privacy"]}
              <span aria-hidden="true"> →</span>
            </a>
          </section>
        </aside>
      )}
      <div className="app-stage">
        <header className="topbar">
          <a className="wordmark" href="/">
            <BrandMark />
            {displayName}
          </a>
          <nav aria-label={copy["navigation.preview"]}>
            <a href="/#how-it-works"> {copy["navigation.how"]} </a>
            <a href="/#privacy"> {copy["navigation.privacy"]} </a>
            <a href={example ? "/" : "/demo"}>
              {example
                ? copy["navigation.introduction"]
                : copy["landing.cta.example"]}
            </a>
          </nav>
          {example && (
            <span className="header-caption">{copy["demo.headerCaption"]}</span>
          )}
        </header>
        <main id="content">{example ? <DemoPage /> : <Landing />}</main>
        <footer>
          <p>
            {displayName} {copy["product.previewSuffix"]}{" "}
          </p>
          <p> {copy["release.staticAvailable"]} </p>
        </footer>
      </div>
    </div>
  );
}
