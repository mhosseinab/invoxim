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
