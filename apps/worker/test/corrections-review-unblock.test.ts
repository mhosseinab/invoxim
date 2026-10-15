// Independent review of review-unblock.ts: resolving a review recomputes
// credit (not only ledger entries), fences every purchase it blocks, keeps
// within the command batch cap, and correct-missing-fields recomputes the
// owned purchase. Synthetic data only.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createCorrectionStore } from "../../../packages/adapters/src/corrections/store";
import { recomputeConnectionPurchase } from "../../../packages/adapters/src/lifecycle/connection-recompute";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

beforeAll(async () => {
  await useCurrentSchema(db);
});

async function owner(id: string) {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    )
    .bind(id, `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,0,0,?)",
    )
    .bind(`session-${id}`, `synthetic-token-${id}`, id)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('mail',?,'mailbox','gmail',?,'mail@example.invalid','connected')",
    )
    .bind(id, `subject-${id}`)
    .run();
  return {
    tenant: { userId: id, authority: "session" } as TenantContext,
    sessionId: `session-${id}`,
  };
}
type Session = Awaited<ReturnType<typeof owner>>;
async function purchase(
  user: string,
  id: string,
  options: { total?: number | null; status?: string } = {},
) {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,record_status,category) VALUES(?,?,'Synthetic','synthetic','2026-01-10',?,'EUR','unknown',?,'other')",
    )
    .bind(
      id,
      user,
      options.total === undefined ? 10000 : options.total,
      options.status ?? "active",
    )
    .run();
}
/**
 * An accepted explicitly-paid source observation on its own document,
 * attached to `purchaseId`, with an optional payment entry.
 */
async function source(
  user: string,
  purchaseId: string,
  id: string,
  record: {
    total: string;
    paymentMethodHint?: "card" | "store-credit";
    paymentAmount?: string | null;
    storeCreditAmount?: string | null;
  },
  entryMinor: number | null,
) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,'mail',?,0,1)",
    )
    .bind(`${id}-msg`, user, `${id}-msg`)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(`${id}-doc`, user, `${id}-msg`, `hash-${id}`)
    .run();
  const structured = JSON.stringify({
    schemaVersion: 1,
    documentType: "receipt",
    record: {
      currency: "EUR",
      total: record.total,
      paymentEvidence: "explicitly-paid",
      paymentMethodHint: record.paymentMethodHint ?? "card",
      paymentAmount: record.paymentAmount ?? null,
      storeCreditAmount: record.storeCreditAmount ?? null,
    },
  });
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,structured_fields,review_state) VALUES(?,?,?,0,'v1',1,'explicitly-paid','{\"schemaVersion\":1}',?,'accepted')",
    )
    .bind(`${id}-obs`, user, `${id}-doc`, structured)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
    )
    .bind(user, purchaseId, `${id}-obs`)
    .run();
  if (entryMinor !== null)
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,?,'payment',?,'EUR','2026-01-10','explicit-event-date',1,'source')",
      )
      .bind(
        `${id}-entry`,
        user,
        purchaseId,
        `${id}-obs`,
        `key-${id}`,
        entryMinor,
      )
      .run();
}
async function review(
  user: string,
  id: string,
  values: {
    purchaseId: string | null;
    documentId: string | null;
    reason: string;
    missingFields?: string[];
  },
) {
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at,missing_fields_json) VALUES(?,?,?,NULL,?,?,'financial','open',0,?)",
    )
    .bind(
      id,
      user,
      values.documentId,
      values.purchaseId,
      values.reason,
      values.missingFields ? JSON.stringify(values.missingFields) : null,
    )
    .run();
}
async function state(user: string, id: string) {
  return db
    .prepare("SELECT payment_state FROM purchases WHERE user_id=? AND id=?")
    .bind(user, id)
    .first<string>("payment_state");
}
async function version(user: string, id: string) {
  const value = await db
    .prepare("SELECT version FROM purchases WHERE user_id=? AND id=?")
    .bind(user, id)
    .first<number>("version");
  if (!value) throw new Error("missing synthetic purchase version");
  return value;
}
/** The lifecycle recompute over the same facts (its own credit-proof SQL). */
async function recomputed(user: string, id: string) {
  await db
    .prepare(
      "UPDATE purchases SET lifecycle_recompute_connection_id='mail' WHERE user_id=? AND id=?",
    )
    .bind(user, id)
    .run();
  await recomputeConnectionPurchase(db, user, "mail", "1=1", []);
  return state(user, id);
}
const completeRecord = (
  session: Session,
  reviewId: string,
  key: string,
  extra: Record<string, string> = {},
) =>
  createCorrectionStore(db).execute(
    session,
    {
      kind: "review-resolve",
      reviewId,
      request: {
        version: 1,
        action: "complete-record",
        record: {
          merchant: "Synthetic completed",
          documentDate: "2026-01-11",
          currency: "EUR",
          totalMinor: "500",
          category: "other",
          ...extra,
        },
      },
    },
    key,
  );

it("unblock credit: resolving a document review over 60 card + 40 store credit settles the 100 EUR purchase like the recompute", async () => {
  const session = await owner("unblock-credit-resolve");
  const user = session.tenant.userId;
  await purchase(user, "mixed");
  await source(
    user,
    "mixed",
    "mixed-src",
    { total: "100.00", paymentAmount: "60.00", storeCreditAmount: "40.00" },
    6000,
  );
  await review(user, "mixed-r", {
    purchaseId: null,
    documentId: "mixed-src-doc",
    reason: "extraction-review",
  });
  await completeRecord(session, "mixed-r", "mixed-resolve");
  expect(await state(user, "mixed")).toBe("paid");
  expect(await recomputed(user, "mixed")).toBe("paid");
});

it("unblock credit: confirming payment for the blocking question counts the store credit it no longer blocks", async () => {
  const session = await owner("unblock-credit-cash");
  const user = session.tenant.userId;
  await purchase(user, "mixed-cash");
  await source(
    user,
    "mixed-cash",
    "mc-src",
    { total: "100.00", paymentAmount: "60.00", storeCreditAmount: "40.00" },
    6000,
  );
  await review(user, "mc-r", {
    purchaseId: "mixed-cash",
    documentId: "mc-src-doc",
    reason: "unknown-payment",
  });
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "mixed-cash",
      entryKind: "payment",
      request: {
        version: 1,
        confirmed: true,
        amountMinor: "100",
        currency: "EUR",
        eventDate: "2026-01-12",
        review: { id: "mc-r", version: 1 },
      },
    },
    "mc-confirm",
  );
  // 6000 card + 100 confirmed + 4000 store credit of 10000.
  expect(await state(user, "mixed-cash")).toBe("paid");
  expect(await recomputed(user, "mixed-cash")).toBe("paid");
});

it("unblock credit: a credit-only purchase linked through its evidence is recomputed", async () => {
  const session = await owner("unblock-credit-only");
  const user = session.tenant.userId;
  await purchase(user, "credit-only");
  await source(
    user,
    "credit-only",
    "co-src",
    {
      total: "100.00",
      paymentMethodHint: "store-credit",
      storeCreditAmount: "100.00",
    },
    null,
  );
  await review(user, "co-r", {
    purchaseId: null,
    documentId: "co-src-doc",
    reason: "extraction-review",
  });
  await completeRecord(session, "co-r", "co-resolve");
  expect(await state(user, "credit-only")).toBe("paid");
  expect(await version(user, "credit-only")).toBe(2);
  expect(await recomputed(user, "credit-only")).toBe("paid");
});

/**
 * Holds every batch until `count` commands reached their commit, so both
 * plans are built from the same pre-commit state.
 */
function commitBarrier(count: number): D1Database {
  const waiting: (() => void)[] = [];
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      await new Promise<void>((release) => {
        waiting.push(release);
        if (waiting.length === count) for (const go of waiting) go();
      });
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

it("unblock concurrency: two resolutions of reviews that both block E fence X, so a retry re-enables E", async () => {
  const session = await owner("unblock-concurrent");
  const user = session.tenant.userId;
  await purchase(user, "x");
  await source(
    user,
    "x",
    "x-src",
    { total: "100.00", paymentAmount: "100.00" },
    10000,
  );
  // Re-include left E ineligible while both reviews were open. X is linked
  // to the reviews only through E (no credit evidence row).
  await db
    .prepare("UPDATE ledger_entries SET eligible=0 WHERE user_id=?")
    .bind(user)
    .run();
  await db
    .prepare("DELETE FROM purchase_evidence WHERE user_id=?")
    .bind(user)
    .run();
  for (const id of ["x-r1", "x-r2"])
    await review(user, id, {
      purchaseId: null,
      documentId: "x-src-doc",
      reason: "extraction-review",
    });
  const barrier = commitBarrier(2);
  const resolve = (reviewId: string, database: D1Database) =>
    createCorrectionStore(database).execute(
      session,
      {
        kind: "review-resolve",
        reviewId,
        request: {
          version: 1,
          action: "complete-record",
          record: {
            merchant: "Synthetic completed",
            documentDate: "2026-01-11",
            currency: "EUR",
            totalMinor: "500",
            category: "other",
          },
        },
      },
      `${reviewId}-resolve`,
    );
  const outcomes = await Promise.allSettled([
    resolve("x-r1", barrier),
    resolve("x-r2", barrier),
  ]);
  const rejected = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected" ? [{ index, reason: outcome.reason }] : [],
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: "CONFLICT" });
  // The client retries the rejected command with the same key.
  const retry = rejected[0]?.index === 0 ? "x-r1" : "x-r2";
  await resolve(retry, db);
  expect(
    await db
      .prepare(
        "SELECT (SELECT eligible FROM ledger_entries WHERE user_id=? AND id='x-src-entry') AS eligible,(SELECT payment_state FROM purchases WHERE user_id=? AND id='x') AS state,(SELECT group_concat(status) FROM review_items WHERE user_id=? AND id IN('x-r1','x-r2')) AS reviews",
      )
      .bind(user, user, user)
      .first(),
  ).toEqual({ eligible: 1, state: "paid", reviews: "resolved,resolved" });
});

/**
 * One source document whose segment i is the accepted observation of
 * purchase `${prefix}-${i}` with a re-include-ineligible 50.00 payment; the
 * purchases were stored 'paid' so each recompute also opens a remainder
 * question (the largest per-purchase write set).
 */
async function sharedDocument(user: string, prefix: string, count: number) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,'mail',?,0,1)",
    )
    .bind(`${prefix}-msg`, user, `${prefix}-msg`)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(`${prefix}-doc`, user, `${prefix}-msg`, `hash-${prefix}`)
    .run();
  for (let index = 0; index < count; index++) {
    const id = `${prefix}-${index}`;
    await purchase(user, id);
    await db
      .prepare(
        "UPDATE purchases SET payment_state='paid' WHERE user_id=? AND id=?",
      )
      .bind(user, id)
      .run();
    await db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,?,'v1',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
      )
      .bind(`${id}-obs`, user, `${prefix}-doc`, index)
      .run();
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,?,'payment',5000,'EUR','2026-01-10','explicit-event-date',0,'source')",
      )
      .bind(`${id}-entry`, user, id, `${id}-obs`, `key-${id}`)
      .run();
  }
  await review(user, `${prefix}-r`, {
    purchaseId: null,
    documentId: `${prefix}-doc`,
    reason: "extraction-review",
  });
}
const sevenFields = {
  invoiceReference: "INV-SEVEN",
  orderReference: "ORD-SEVEN",
};

it("unblock caps: 5 linked purchases with 4 recomputable resolve a 7-field complete-record within the batch cap", async () => {
  const session = await owner("unblock-caps");
  const user = session.tenant.userId;
  await sharedDocument(user, "cap", 5);
  await db
    .prepare(
      "UPDATE purchases SET record_status='excluded' WHERE user_id=? AND id='cap-4'",
    )
    .bind(user)
    .run();
  const result = await completeRecord(
    session,
    "cap-r",
    "cap-resolve",
    sevenFields,
  );
  expect(result.reviewStatus).toBe("resolved");
  expect(
    (
      await db
        .prepare(
          "SELECT p.id,p.payment_state AS state,p.version,(SELECT eligible FROM ledger_entries l WHERE l.user_id=p.user_id AND l.purchase_id=p.id) AS eligible,(SELECT COUNT(*) FROM review_items r WHERE r.user_id=p.user_id AND r.purchase_id=p.id AND r.reason='payment-allocation-review' AND r.status='open') AS remainder FROM purchases p WHERE p.user_id=? AND p.id LIKE 'cap-%' ORDER BY p.id",
        )
        .bind(user)
        .all()
    ).results,
  ).toEqual([
    ...[0, 1, 2, 3].map((index) => ({
      id: `cap-${index}`,
      state: "partially_paid",
      version: 2,
      eligible: 1,
      remainder: 1,
    })),
    // Excluded: not recomputed or counted, only version-fenced (restore race).
    { id: "cap-4", state: "paid", version: 2, eligible: 0, remainder: 0 },
  ]);
});

it("unblock caps: 4 recomputed purchases with remainder questions plus a 7-field complete-record stay within the 32-statement batch", async () => {
  const session = await owner("unblock-caps-four");
  const user = session.tenant.userId;
  await sharedDocument(user, "four", 4);
  const result = await completeRecord(
    session,
    "four-r",
    "four-resolve",
    sevenFields,
  );
  expect(result.reviewStatus).toBe("resolved");
  expect(
    await db
      .prepare(
        "SELECT (SELECT SUM(eligible) FROM ledger_entries WHERE user_id=?) AS eligible,(SELECT COUNT(*) FROM review_items WHERE user_id=? AND reason='payment-allocation-review' AND status='open') AS remainders,(SELECT COUNT(*) FROM correction_audit WHERE user_id=? AND action IN('review-resolution-recomputed','payment-allocation-recomputed')) AS audits",
      )
      .bind(user, user, user)
      .first(),
  ).toEqual({ eligible: 4, remainders: 4, audits: 8 });
});

it("unblock caps: more than 4 recomputable purchases is the documented TOO_LARGE limit and writes nothing", async () => {
  const session = await owner("unblock-caps-over");
  const user = session.tenant.userId;
  await sharedDocument(user, "over", 5);
  await expect(
    completeRecord(session, "over-r", "over-resolve", sevenFields),
  ).rejects.toMatchObject({ code: "TOO_LARGE" });
  expect(
    await db
      .prepare(
        "SELECT (SELECT status FROM review_items WHERE user_id=? AND id='over-r') AS review,(SELECT COUNT(*) FROM purchases WHERE user_id=?) AS purchases,(SELECT SUM(eligible) FROM ledger_entries WHERE user_id=?) AS eligible",
      )
      .bind(user, user, user)
      .first(),
  ).toEqual({ review: "open", purchases: 5, eligible: 0 });
});

/** A purchase without total, 60.00 supported cash, and a total question on another document. */
async function missingTotal(user: string, prefix: string, missing: string[]) {
  await purchase(user, prefix, { total: null });
  await source(
    user,
    prefix,
    `${prefix}-src`,
    { total: "60.00", paymentAmount: "60.00" },
    6000,
  );
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'attachment',?,'text/plain',10)",
    )
    .bind(
      `${prefix}-other-doc`,
      user,
      `${prefix}-src-msg`,
      `hash-${prefix}-other`,
    )
    .run();
  await review(user, `${prefix}-r`, {
    purchaseId: prefix,
    documentId: `${prefix}-other-doc`,
    reason: "extraction-review",
    missingFields: missing,
  });
}
const correctMissing = async (
  session: Session,
  purchaseId: string,
  changes: Record<string, string>,
) =>
  createCorrectionStore(db).execute(
    session,
    {
      kind: "review-resolve",
      reviewId: `${purchaseId}-r`,
      request: {
        version: 1,
        action: "correct-missing-fields",
        purchaseVersion: await version(session.tenant.userId, purchaseId),
        changes,
      },
    },
    `${purchaseId}-correct`,
  );

it("correct-missing-fields: correcting the total recomputes payment state although nothing unblocks", async () => {
  const session = await owner("missing-total");
  const user = session.tenant.userId;
  await missingTotal(user, "mt", ["total"]);
  expect(await state(user, "mt")).toBe("unknown");
  const result = await correctMissing(session, "mt", { totalMinor: "6000" });
  expect(result.reviewStatus).toBe("resolved");
  expect(await state(user, "mt")).toBe("paid");
  expect(await version(user, "mt")).toBe(result.version);
  expect(await recomputed(user, "mt")).toBe("paid");
});

it("correct-missing-fields: a total correction that leaves the question open still recomputes payment state", async () => {
  const session = await owner("missing-total-open");
  const user = session.tenant.userId;
  await missingTotal(user, "mo", ["total", "merchant"]);
  const result = await correctMissing(session, "mo", { totalMinor: "10000" });
  expect(result.reviewStatus).toBe("open");
  expect(await state(user, "mo")).toBe("partially_paid");
});

it("correct-missing-fields adversarial: a merchant-only correction with nothing unblocked leaves payment state alone", async () => {
  const session = await owner("missing-merchant");
  const user = session.tenant.userId;
  await missingTotal(user, "mm", ["merchant"]);
  await correctMissing(session, "mm", { merchant: "Synthetic fixed" });
  expect(await state(user, "mm")).toBe("unknown");
});

/**
 * Two databases for two concurrent commands: both build their plans, then
 * `first` commits before `second`, whichever reaches its batch first.
 */
function orderedCommits() {
  let arrivals = 0;
  let bothArrived: () => void = () => {};
  const both = new Promise<void>((release) => {
    bothArrived = release;
  });
  let firstCommitted: () => void = () => {};
  const committed = new Promise<void>((release) => {
    firstCommitted = release;
  });
  const wrap = (after: Promise<void> | null, finish: () => void) =>
    ({
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        arrivals += 1;
        if (arrivals === 2) bothArrived();
        await both;
        if (after) await after;
        try {
          return await db.batch(statements);
        } finally {
          finish();
        }
      },
    }) as unknown as D1Database;
  return {
    first: wrap(null, firstCommitted),
    second: wrap(committed, () => {}),
  };
}

it.each(["restore", "resolve"] as const)(
  "restore vs resolve race (%s commits first): exactly one CONFLICT, and after the retry E is eligible",
  async (winner) => {
    const session = await owner(`race-${winner}`);
    const user = session.tenant.userId;
    await purchase(user, "rx");
    await source(
      user,
      "rx",
      "rx-src",
      { total: "100.00", paymentAmount: "100.00" },
      10000,
    );
    // X was paid by E, then excluded (E ineligible); R now blocks E.
    await db
      .prepare(
        "UPDATE purchases SET payment_state='paid',record_status='excluded',version=2 WHERE user_id=? AND id='rx'",
      )
      .bind(user)
      .run();
    await db
      .prepare("UPDATE ledger_entries SET eligible=0 WHERE user_id=?")
      .bind(user)
      .run();
    await review(user, "rx-r", {
      purchaseId: null,
      documentId: "rx-src-doc",
      reason: "extraction-review",
    });
    const restore = (database: D1Database) =>
      createCorrectionStore(database).execute(
        session,
        { kind: "restore", purchaseId: "rx", request: { version: 2 } },
        "rx-restore",
      );
    const resolve = (database: D1Database) =>
      createCorrectionStore(database).execute(
        session,
        {
          kind: "review-resolve",
          reviewId: "rx-r",
          request: {
            version: 1,
            action: "complete-record",
            record: {
              merchant: "Synthetic completed",
              documentDate: "2026-01-11",
              currency: "EUR",
              totalMinor: "500",
              category: "other",
            },
          },
        },
        "rx-resolve",
      );
    const gate = orderedCommits();
    const [restored, resolved] = await Promise.allSettled([
      restore(winner === "restore" ? gate.first : gate.second),
      resolve(winner === "resolve" ? gate.first : gate.second),
    ]);
    const loser = winner === "restore" ? resolved : restored;
    expect({
      restore: restored.status,
      resolve: resolved.status,
    }).toEqual(
      winner === "restore"
        ? { restore: "fulfilled", resolve: "rejected" }
        : { restore: "rejected", resolve: "fulfilled" },
    );
    expect(loser.status === "rejected" ? loser.reason : null).toMatchObject({
      code: "CONFLICT",
    });
    // The client reloads and retries the rejected command.
    if (winner === "restore") await resolve(db);
    else
      await createCorrectionStore(db).execute(
        session,
        {
          kind: "restore",
          purchaseId: "rx",
          request: { version: await version(user, "rx") },
        },
        "rx-restore-retry",
      );
    expect(
      await db
        .prepare(
          "SELECT p.record_status AS status,p.payment_state AS state,(SELECT eligible FROM ledger_entries l WHERE l.user_id=p.user_id AND l.id='rx-src-entry') AS eligible,(SELECT status FROM review_items r WHERE r.user_id=p.user_id AND r.id='rx-r') AS review FROM purchases p WHERE p.user_id=? AND p.id='rx'",
        )
        .bind(user)
        .first(),
    ).toEqual({
      status: "active",
      state: "paid",
      eligible: 1,
      review: "resolved",
    });
  },
);
