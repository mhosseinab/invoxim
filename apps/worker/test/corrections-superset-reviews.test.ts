// Reviewer findings P2 (superset reviews in the purchase view, unmerge) and
// P2 (re-include then resolve): corrections over the review superset that the
// pipeline snapshot and lifecycle recompute use (OQ-B). Synthetic data only.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { CorrectionError } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createCorrectionStore } from "../../../packages/adapters/src/corrections/store";
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
async function purchase(
  user: string,
  id: string,
  options: { total?: number; state?: string; status?: string } = {},
) {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,record_status,category) VALUES(?,?,'Synthetic','synthetic','2026-01-10',?,'EUR',?,?,'other')",
    )
    .bind(
      id,
      user,
      options.total ?? 10000,
      options.state ?? "unknown",
      options.status ?? "active",
    )
    .run();
}
/** An accepted explicitly-paid source observation with one payment entry. */
async function sourcePayment(
  user: string,
  purchaseId: string,
  id: string,
  amount: number,
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
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,'v1',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .bind(`${id}-obs`, user, `${id}-doc`)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
    )
    .bind(user, purchaseId, `${id}-obs`)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,?,'payment',?,'EUR','2026-01-10','explicit-event-date',1,'source')",
    )
    .bind(`${id}-entry`, user, purchaseId, `${id}-obs`, `key-${id}`, amount)
    .run();
}
async function review(
  user: string,
  id: string,
  values: {
    purchaseId: string | null;
    documentId: string | null;
    observationId?: string | null;
    reason: string;
  },
) {
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,?,?,?,?,'financial','open',0)",
    )
    .bind(
      id,
      user,
      values.documentId,
      values.observationId ?? null,
      values.purchaseId,
      values.reason,
    )
    .run();
}

it("reviewer P2 purchase view lists superset reviews without offering their actions", async () => {
  const session = await owner("superset-view");
  const user = session.tenant.userId;
  await purchase(user, "view-p");
  await purchase(user, "view-other");
  await sourcePayment(user, "view-p", "view-cash", 10000);
  // Linked to view-p's cash only through its document, owned by nobody.
  await review(user, "view-r-unowned", {
    purchaseId: null,
    documentId: "view-cash-doc",
    reason: "extraction-review",
  });
  // Linked through view-p's entry observation, owned by another purchase.
  await review(user, "view-r-foreign", {
    purchaseId: "view-other",
    documentId: "view-cash-doc",
    observationId: "view-cash-obs",
    reason: "unknown-payment",
  });
  // The purchase's own question keeps its action.
  await review(user, "view-r-own", {
    purchaseId: "view-p",
    documentId: null,
    reason: "payment-allocation-review",
  });
  const store = createCorrectionStore(db);
  const state = await store.readPurchase(session.tenant, "view-p");
  expect(
    state?.reviews.map((item) => ({ id: item.id, actions: item.actions })),
  ).toEqual([
    { id: "view-r-foreign", actions: [] },
    { id: "view-r-own", actions: ["confirm-payment"] },
    { id: "view-r-unowned", actions: [] },
  ]);
  // The review's own page still offers its actions there.
  expect(
    (await store.readReview(session.tenant, "view-r-foreign"))?.review.actions,
  ).toEqual(["confirm-payment"]);
  // Adversarial: the purchase-scoped cash endpoint rejects a superset review
  // id for this purchase without writing anything.
  for (const id of ["view-r-foreign", "view-r-unowned"])
    await expect(
      store.execute(
        session,
        {
          kind: "cash-confirm",
          purchaseId: "view-p",
          entryKind: "payment",
          request: {
            version: 1,
            confirmed: true,
            amountMinor: "10000",
            currency: "EUR",
            eventDate: "2026-01-10",
            review: { id, version: 1 },
          },
        },
        `superset-cash-${id}`,
      ),
    ).rejects.toEqual(new CorrectionError("CONFLICT"));
  expect(
    await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM ledger_entries WHERE user_id=?) AS entries,(SELECT COUNT(*) FROM correction_commands WHERE user_id=?) AS commands,(SELECT group_concat(status) FROM review_items WHERE user_id=?) AS statuses",
      )
      .bind(user, user, user)
      .first(),
  ).toEqual({ entries: 1, commands: 0, statuses: "open,open,open" });
});

async function states(user: string) {
  return (
    await db
      .prepare(
        "SELECT id,payment_state,record_status FROM purchases WHERE user_id=? ORDER BY id",
      )
      .bind(user)
      .all()
  ).results;
}
async function version(user: string, id: string) {
  const value = await db
    .prepare("SELECT version FROM purchases WHERE user_id=? AND id=?")
    .bind(user, id)
    .first<number>("version");
  if (!value) throw new Error("missing synthetic purchase version");
  return value;
}

it("reviewer P2 unmerge keeps OQ-B: cash blocked by an observation- or document-linked review stays excluded", async () => {
  const session = await owner("superset-unmerge");
  const user = session.tenant.userId;
  await purchase(user, "um-target");
  await purchase(user, "um-source");
  await sourcePayment(user, "um-source", "um-cash", 10000);
  await sourcePayment(user, "um-target", "um-target-cash", 10000);
  // Owned by neither purchase: linked only through the source cash document
  // and the target cash observation.
  await review(user, "um-r-document", {
    purchaseId: null,
    documentId: "um-cash-doc",
    reason: "extraction-review",
  });
  await review(user, "um-r-observation", {
    purchaseId: null,
    documentId: "um-target-cash-doc",
    observationId: "um-target-cash-obs",
    reason: "event-conflict",
  });
  const store = createCorrectionStore(db);
  const merged = await store.execute(
    session,
    {
      kind: "merge",
      request: {
        target: { id: "um-target", version: 1 },
        source: { id: "um-source", version: 1 },
      },
    },
    "superset-merge",
  );
  if (!merged.mergeId || !merged.version) throw new Error("missing merge");
  expect(await states(user)).toEqual([
    { id: "um-source", payment_state: "unknown", record_status: "merged" },
    { id: "um-target", payment_state: "unknown", record_status: "active" },
  ]);
  await store.execute(
    session,
    {
      kind: "unmerge",
      purchaseId: "um-target",
      request: {
        mergeId: merged.mergeId,
        version: merged.version,
        sourceVersion: await version(user, "um-source"),
      },
    },
    "superset-unmerge",
  );
  expect(await states(user)).toEqual([
    { id: "um-source", payment_state: "unknown", record_status: "active" },
    { id: "um-target", payment_state: "unknown", record_status: "active" },
  ]);
});

it("reviewer P2 unmerge adversarial: a superset review on the other side's cash does not block this side", async () => {
  const session = await owner("superset-unmerge-other");
  const user = session.tenant.userId;
  await purchase(user, "uo-target");
  await purchase(user, "uo-source");
  await sourcePayment(user, "uo-source", "uo-cash", 10000);
  await sourcePayment(user, "uo-target", "uo-target-cash", 10000);
  // Linked to the source cash document only; target cash stays supported.
  await review(user, "uo-r-document", {
    purchaseId: null,
    documentId: "uo-cash-doc",
    reason: "extraction-review",
  });
  const store = createCorrectionStore(db);
  const merged = await store.execute(
    session,
    {
      kind: "merge",
      request: {
        target: { id: "uo-target", version: 1 },
        source: { id: "uo-source", version: 1 },
      },
    },
    "superset-merge-other",
  );
  if (!merged.mergeId || !merged.version) throw new Error("missing merge");
  await store.execute(
    session,
    {
      kind: "unmerge",
      purchaseId: "uo-target",
      request: {
        mergeId: merged.mergeId,
        version: merged.version,
        sourceVersion: await version(user, "uo-source"),
      },
    },
    "superset-unmerge-other",
  );
  expect(await states(user)).toEqual([
    { id: "uo-source", payment_state: "unknown", record_status: "active" },
    { id: "uo-target", payment_state: "paid", record_status: "active" },
  ]);
});
