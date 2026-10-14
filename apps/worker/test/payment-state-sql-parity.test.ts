// CORE-1 adapters SQL case: the supportedCash CASE in
// packages/adapters/src/lifecycle/connection-recompute.ts:14 must agree with
// core's hasCashProof && restorationEligibility on clean facts, and the suite
// pins the documented divergences (user-confirmed short-circuit, connection
// deletion, fallback review reasons).

import { env } from "cloudflare:workers";
import {
  type CorrectionEventFact,
  type CorrectionReviewFact,
  hasCashProof,
  restorationEligibility,
} from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import auth from "./migrations/historical/0001_auth.sql?raw";
import records from "./migrations/historical/0002_records.sql?raw";
import indexes from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import credentials from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import profile from "./migrations/historical/0005_profile_version.sql?raw";
import jobs from "./migrations/historical/0006_jobs.sql?raw";
import mailbox from "./migrations/historical/0007_mailbox.sql?raw";
import discovery from "./migrations/historical/0008_discovery.sql?raw";
import ai from "./migrations/historical/0009_ai.sql?raw";
import pipeline from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import lifecycle from "./migrations/historical/0011_lifecycle.sql?raw";
import reviewFields from "./migrations/historical/0012_review_fields.sql?raw";
import corrections from "./migrations/historical/0013_corrections.sql?raw";

const db = env.DB;

const supportedCash = `CASE WHEN l.origin='user-confirmed' THEN 1 WHEN o.review_state='accepted' AND (o.evidence_code='manual-confirmation' OR o.evidence_code=CASE WHEN l.kind='payment' THEN 'explicitly-paid' ELSE 'completed-refund' END) AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=s.user_id AND ld.scope='connection' AND ld.target_id=s.connection_id) AND NOT EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=l.user_id AND r.status='open' AND r.blocking_scope='financial' AND r.reason!='payment-allocation-review' AND (r.observation_id=l.observation_id OR (r.observation_id IS NULL AND r.document_id=o.document_id AND r.reason NOT IN ('refund-exceeds-payment','refund-currency-mismatch')))) THEN 1 ELSE 0 END`;

async function apply(sql: string) {
  for (const statement of sql.split(";").filter((s) => s.trim()))
    await db.prepare(statement).run();
}

interface Case {
  name: string;
  connection: string;
  entry: {
    id: string;
    origin: "source" | "user-confirmed";
    kind: "payment" | "refund";
    observationId: string | null;
    accepted: boolean;
    evidenceCode: string | null;
    documentId: string | null;
  };
  reviews: CorrectionReviewFact[];
  /** Documented verdict for this case. */
  expectSqlSupported: boolean;
  expectTsSupported: boolean;
}

const cases: Case[] = [
  {
    name: "clean source payment agrees",
    connection: "mail-clean",
    entry: {
      id: "e-clean",
      origin: "source",
      kind: "payment",
      observationId: "obs-clean",
      accepted: true,
      evidenceCode: "explicitly-paid",
      documentId: "doc-clean",
    },
    reviews: [],
    expectSqlSupported: true,
    expectTsSupported: true,
  },
  {
    name: "user-confirmed refund short-circuits SQL but TS blocks on refund-exceeds-payment",
    connection: "mail-confirmed",
    entry: {
      id: "e-confirmed",
      origin: "user-confirmed",
      kind: "refund",
      observationId: null,
      accepted: true,
      evidenceCode: "manual-confirmation",
      documentId: null,
    },
    reviews: [
      {
        id: "r-confirmed",
        observationId: null,
        documentId: null,
        reason: "refund-exceeds-payment",
        blockingScope: "financial",
        status: "open",
        missingFields: [],
        purchaseId: "p",
      },
    ],
    expectSqlSupported: true,
    expectTsSupported: false,
  },
  {
    name: "connection deletion pending unsupports SQL only",
    connection: "mail-deleted",
    entry: {
      id: "e-deleted",
      origin: "source",
      kind: "payment",
      observationId: "obs-deleted",
      accepted: true,
      evidenceCode: "explicitly-paid",
      documentId: "doc-deleted",
    },
    reviews: [],
    expectSqlSupported: false,
    expectTsSupported: true,
  },
];

function tsSupported(entry: Case["entry"], reviews: CorrectionReviewFact[]) {
  const fact: CorrectionEventFact = {
    id: entry.id,
    observationId: entry.observationId,
    documentId: entry.documentId,
    kind: entry.kind,
    amountMinor: "100",
    currency: "EUR",
    eventDate: "2026-01-01",
    origin: entry.origin,
    eligible: true,
    accepted: entry.accepted,
    evidenceCode: entry.evidenceCode,
  };
  return hasCashProof(fact) && restorationEligibility(fact, reviews);
}

beforeAll(async () => {
  for (const sql of [
    auth,
    records,
    indexes,
    credentials,
    profile,
    jobs,
    mailbox,
    discovery,
    ai,
    pipeline,
    lifecycle,
    reviewFields,
    corrections,
  ])
    await apply(sql);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('sql-parity-owner','Synthetic','sql-parity@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES('sql-parity-owner','active',0,0)",
    )
    .run();
  for (const mail of ["mail-clean", "mail-confirmed", "mail-deleted"])
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES(?,'sql-parity-owner','mailbox','gmail',?,?,'connected')",
      )
      .bind(mail, mail, `${mail}@example.invalid`)
      .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('msg-clean','sql-parity-owner','mail-clean','m1',0,1),('msg-confirmed','sql-parity-owner','mail-confirmed','m2',0,1),('msg-deleted','sql-parity-owner','mail-deleted','m3',0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc-clean','sql-parity-owner','msg-clean','body','hash-clean','text/plain',1),('doc-confirmed','sql-parity-owner','msg-confirmed','body','hash-confirmed','text/plain',1),('doc-deleted','sql-parity-owner','msg-deleted','body','hash-deleted','text/plain',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs-clean','sql-parity-owner','doc-clean',0,'fp',1,'explicitly-paid','{\"schemaVersion\":1}','accepted'),('obs-confirmed','sql-parity-owner','doc-confirmed',0,'fp',1,'manual-confirmation','{\"schemaVersion\":1}','accepted'),('obs-deleted','sql-parity-owner','doc-deleted',0,'fp',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('p','sql-parity-owner','Synthetic','synthetic','2026-01-01',10000,'EUR','unknown')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('e-clean','sql-parity-owner','p','obs-clean','k-clean','payment',100,'EUR','2026-01-01','document-date',1,'source'),('e-confirmed','sql-parity-owner','p',NULL,'k-confirmed','refund',100,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed'),('e-deleted','sql-parity-owner','p','obs-deleted','k-deleted','payment',100,'EUR','2026-01-01','document-date',1,'source')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES('r-confirmed','sql-parity-owner','doc-confirmed',NULL,'p','refund-exceeds-payment','financial','open',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES('sql-parity-owner','connection','mail-deleted','sql-parity-del',0,8,0)",
    )
    .run();
});

it("CORE-1 SQL case: supportedCash CASE matches the documented TS verdicts", async () => {
  for (const testCase of cases) {
    const row = await db
      .prepare(
        `SELECT l.id,${supportedCash} AS supported FROM ledger_entries l LEFT JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id LEFT JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id LEFT JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE l.user_id=? AND l.id=?`,
      )
      .bind("sql-parity-owner", testCase.entry.id)
      .first<{ id: string; supported: number }>();
    expect(row, testCase.name).toBeTruthy();
    const sqlSupported = row?.supported === 1;
    const ts = tsSupported(testCase.entry, testCase.reviews);
    expect({ name: testCase.name, sqlSupported }).toEqual({
      name: testCase.name,
      sqlSupported: testCase.expectSqlSupported,
    });
    expect({ name: testCase.name, tsSupported: ts }).toEqual({
      name: testCase.name,
      tsSupported: testCase.expectTsSupported,
    });
    if (testCase.expectSqlSupported === testCase.expectTsSupported)
      expect({ name: testCase.name, agree: sqlSupported === ts }).toEqual({
        name: testCase.name,
        agree: true,
      });
  }
});
