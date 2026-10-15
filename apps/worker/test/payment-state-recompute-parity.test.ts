// CORE-6/PIPE-7 (ext#2, C1): the lifecycle recompute SQL in
// packages/adapters/src/lifecycle/connection-recompute.ts runs against real D1
// and must reach the same conservative payment state as the corrections TS
// path (settlementEvents + evaluateCorrectionSettlement) on the same facts.
// Rule 04: excluded, pending, ambiguous or unproven cash never raises payment state.

import { env } from "cloudflare:workers";
import {
  type CorrectionEventFact,
  type CorrectionReviewFact,
  evaluateCorrectionSettlement,
  settlementEvents,
} from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { recomputeConnectionPurchase } from "../../../packages/adapters/src/lifecycle/connection-recompute";
import { useCurrentSchema } from "./support/db";

const db = env.DB;
const user = "recompute-parity-owner";

type PaymentState = "unknown" | "unpaid" | "partially_paid" | "paid";

interface Entry {
  kind: "payment" | "refund";
  amountMinor: number;
  origin: "source" | "user-confirmed";
  eligible: boolean;
  /** Source entries: the observation (and its document/message) to create. */
  source?: {
    evidenceCode:
      | "explicitly-paid"
      | "completed-refund"
      | "manual-confirmation";
    accepted: boolean;
    connection: string;
  };
}

interface Review {
  reason: CorrectionReviewFact["reason"];
  /**
   * "purchase": purchase_id set, observation NULL, document = an unrelated
   * document (review_items CHECK requires document_id). Otherwise linked only
   * through entry `index`'s observation (with its document) or its document
   * alone (purchase_id NULL).
   */
  link: "purchase" | { observationOf: number } | { documentOf: number };
}

interface Case {
  name: string;
  recordStatus: "active" | "excluded";
  paymentState: PaymentState;
  entries: Entry[];
  reviews?: Review[];
  expected: PaymentState;
  /**
   * Known loader gap, reported to the PIPE lane: corrections/data.ts reviews()
   * loads only reviews with purchase_id = the purchase, so a review linked only
   * through the entry's observation/document is invisible to corrections. The
   * recompute keeps the stricter superset; this records what corrections sees.
   */
  correctionsLoaderState?: PaymentState;
}

const cases: Case[] = [
  {
    name: "clean source payment settles the purchase",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-live",
        },
      },
    ],
    expected: "paid",
  },
  {
    name: "excluded purchase: proven user-confirmed cash (eligible=0) stays unsupported",
    recordStatus: "excluded",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "user-confirmed",
        eligible: false,
      },
    ],
    expected: "unknown",
  },
  {
    name: "excluded purchase: proven source cash (eligible=0) stays unsupported",
    recordStatus: "excluded",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: false,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-live",
        },
      },
    ],
    expected: "unknown",
  },
  {
    name: "open review on another document of the purchase does not block proven cash",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-live",
        },
      },
    ],
    reviews: [{ reason: "unknown-payment", link: "purchase" }],
    expected: "paid",
  },
  {
    // Rule-level guard: cleanup stage 3 resets payment_state to 'unknown' before
    // recompute, so through cleanup this flag cannot change the stored state.
    name: "open purchase-level refund-exceeds-payment review blocks a user-confirmed refund",
    recordStatus: "active",
    paymentState: "unpaid",
    entries: [
      {
        kind: "refund",
        amountMinor: 5000,
        origin: "user-confirmed",
        eligible: true,
      },
    ],
    reviews: [{ reason: "refund-exceeds-payment", link: "purchase" }],
    expected: "unpaid",
  },
  {
    name: "observation-matched review not linked to the purchase still blocks the entry",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-live",
        },
      },
    ],
    reviews: [{ reason: "event-conflict", link: { observationOf: 0 } }],
    expected: "unknown",
    correctionsLoaderState: "paid",
  },
  {
    name: "document-matched review without observation still blocks the entry",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-live",
        },
      },
    ],
    reviews: [{ reason: "extraction-review", link: { documentOf: 0 } }],
    expected: "unknown",
    correctionsLoaderState: "paid",
  },
  {
    name: "source cash from a connection with pending deletion is unsupported",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: true,
          connection: "mail-deleted",
        },
      },
    ],
    expected: "unknown",
  },
  {
    name: "unaccepted observation is not cash proof",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 10000,
        origin: "source",
        eligible: true,
        source: {
          evidenceCode: "explicitly-paid",
          accepted: false,
          connection: "mail-live",
        },
      },
    ],
    expected: "unknown",
  },
  {
    name: "independent user-confirmed cash survives a purchase-level unknown-payment review",
    recordStatus: "active",
    paymentState: "unknown",
    entries: [
      {
        kind: "payment",
        amountMinor: 4000,
        origin: "user-confirmed",
        eligible: true,
      },
    ],
    reviews: [{ reason: "unknown-payment", link: "purchase" }],
    expected: "partially_paid",
  },
];

const ids = (caseIndex: number, entryIndex: number) => ({
  entry: `c${caseIndex}-e${entryIndex}`,
  observation: `c${caseIndex}-obs${entryIndex}`,
  document: `c${caseIndex}-doc${entryIndex}`,
  message: `c${caseIndex}-msg${entryIndex}`,
});
const purchaseId = (caseIndex: number) => `c${caseIndex}-purchase`;
const marker = (caseIndex: number) => `c${caseIndex}-recompute`;

beforeAll(async () => {
  await useCurrentSchema(db);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','recompute-parity@example.invalid',1,0,0)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES(?,'active',0,0)",
    )
    .bind(user)
    .run();
  for (const connection of ["mail-live", "mail-deleted"])
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES(?,?,'mailbox','gmail',?,?,'connected')",
      )
      .bind(connection, user, connection, `${connection}@example.invalid`)
      .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('msg-unrelated',?,'mail-live','msg-unrelated',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc-unrelated',?,'msg-unrelated','body','hash-unrelated','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'connection','mail-deleted','recompute-parity-deletion',0,8,0)",
    )
    .bind(user)
    .run();
  for (const [caseIndex, testCase] of cases.entries()) {
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,record_status,lifecycle_recompute_connection_id) VALUES(?,?,'Synthetic','synthetic','2026-01-01',10000,'EUR',?,?,?)",
      )
      .bind(
        purchaseId(caseIndex),
        user,
        testCase.paymentState,
        testCase.recordStatus,
        marker(caseIndex),
      )
      .run();
    for (const [entryIndex, entry] of testCase.entries.entries()) {
      const id = ids(caseIndex, entryIndex);
      if (entry.source) {
        await db
          .prepare(
            "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,0,1)",
          )
          .bind(id.message, user, entry.source.connection, id.message)
          .run();
        await db
          .prepare(
            "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',1)",
          )
          .bind(id.document, user, id.message, `hash-${id.document}`)
          .run();
        await db
          .prepare(
            "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,'fp',1,?,'{\"schemaVersion\":1}',?)",
          )
          .bind(
            id.observation,
            user,
            id.document,
            entry.source.evidenceCode,
            entry.source.accepted ? "accepted" : "needs_review",
          )
          .run();
      }
      await db
        .prepare(
          "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,?,?,?,'EUR','2026-01-01',?,?,?)",
        )
        .bind(
          id.entry,
          user,
          purchaseId(caseIndex),
          entry.source ? id.observation : null,
          `key-${id.entry}`,
          entry.kind,
          entry.amountMinor,
          entry.source ? "document-date" : "user-confirmed-date",
          entry.eligible ? 1 : 0,
          entry.origin,
        )
        .run();
    }
    for (const [reviewIndex, review] of (testCase.reviews ?? []).entries()) {
      const link = review.link;
      const observation =
        typeof link === "object" && "observationOf" in link
          ? ids(caseIndex, link.observationOf).observation
          : null;
      const document =
        link === "purchase"
          ? "doc-unrelated"
          : ids(
              caseIndex,
              "documentOf" in link ? link.documentOf : link.observationOf,
            ).document;
      await db
        .prepare(
          "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,?,?,?,?,'financial','open',0)",
        )
        .bind(
          `c${caseIndex}-r${reviewIndex}`,
          user,
          document,
          observation,
          link === "purchase" ? purchaseId(caseIndex) : null,
          review.reason,
        )
        .run();
    }
  }
});

/** The corrections TS path over the same facts (mirrors corrections/data.ts). */
function correctionsState(caseIndex: number, testCase: Case): PaymentState {
  const facts: CorrectionEventFact[] = testCase.entries.map(
    (entry, entryIndex) => ({
      id: ids(caseIndex, entryIndex).entry,
      observationId: entry.source
        ? ids(caseIndex, entryIndex).observation
        : null,
      documentId: entry.source ? ids(caseIndex, entryIndex).document : null,
      kind: entry.kind,
      amountMinor: String(entry.amountMinor),
      currency: "EUR",
      eventDate: "2026-01-01",
      origin: entry.origin,
      eligible: entry.eligible,
      accepted:
        entry.source?.accepted === true &&
        entry.source.connection !== "mail-deleted",
      evidenceCode: entry.source?.evidenceCode ?? null,
    }),
  );
  // data.ts reviews() is purchase-scoped (WHERE purchase_id=?).
  const reviews: CorrectionReviewFact[] = (testCase.reviews ?? []).flatMap(
    (review, reviewIndex) => {
      const link = review.link;
      if (link !== "purchase") return [];
      return {
        id: `c${caseIndex}-r${reviewIndex}`,
        observationId: null,
        documentId: "doc-unrelated",
        reason: review.reason,
        blockingScope: "financial",
        status: "open",
        missingFields: [],
        purchaseId: purchaseId(caseIndex),
      };
    },
  );
  return evaluateCorrectionSettlement(
    {
      currency: "EUR",
      totalMinor: "10000",
      paymentState: testCase.paymentState,
    },
    settlementEvents(facts, reviews),
    [],
  ).paymentState;
}

for (const [caseIndex, testCase] of cases.entries())
  it(`lifecycle recompute agrees with corrections: ${testCase.name}`, async () => {
    await recomputeConnectionPurchase(db, user, marker(caseIndex), "1=1", []);
    const row = await db
      .prepare(
        "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE user_id=? AND id=?",
      )
      .bind(user, purchaseId(caseIndex))
      .first<{
        payment_state: string;
        lifecycle_recompute_connection_id: string | null;
      }>();
    expect(row).toEqual({
      payment_state: testCase.expected,
      lifecycle_recompute_connection_id: null,
    });
    expect(correctionsState(caseIndex, testCase)).toBe(
      testCase.correctionsLoaderState ?? testCase.expected,
    );
  });
