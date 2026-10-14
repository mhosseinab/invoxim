import {
  extractionSchema,
  type PurchaseCoverage,
  purchaseListRequestSchema,
} from "@invoxim/contracts";
import { Icon } from "../icons";
import { categoryLabel, privateCopy as text } from "./copy";

export function filtersFromUrl() {
  const entries = Object.fromEntries(
    Array.from(new URLSearchParams(window.location.search)).filter(
      ([, value]) => value !== "",
    ),
  );
  return purchaseListRequestSchema.safeParse(entries);
}

export function Search({ coverage }: { coverage: PurchaseCoverage }) {
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
