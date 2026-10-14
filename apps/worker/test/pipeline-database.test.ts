// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import {
  type JobLease,
  type LedgerInput,
  planLedgerIngestion,
  type TenantContext,
} from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPurchaseViewReader } from "../../../packages/adapters/src/purchase-views";
import auth from "./migrations/historical/0001_auth.sql?raw";
import records from "./migrations/historical/0002_records.sql?raw";
import indexes from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import vault from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import profile from "./migrations/historical/0005_profile_version.sql?raw";
import jobs from "./migrations/historical/0006_jobs.sql?raw";
import mailbox from "./migrations/historical/0007_mailbox.sql?raw";
import discovery from "./migrations/historical/0008_discovery.sql?raw";
import ai from "./migrations/historical/0009_ai.sql?raw";
import pipeline from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import lifecycle from "./migrations/historical/0011_lifecycle.sql?raw";
import reviewFields from "./migrations/historical/0012_review_fields.sql?raw";
import corrections from "./migrations/historical/0013_corrections.sql?raw";
import onboarding from "./migrations/historical/0014_onboarding.sql?raw";

const db = env.DB;

async function apply(sql: string) {
  for (const statement of sql.split(";").filter((s) => s.trim()))
    await db.prepare(statement).run();
}
beforeAll(async () => {
  for (const sql of [
    auth,
    records,
    indexes,
    vault,
    profile,
    jobs,
    mailbox,
    discovery,
    ai,
  ])
    await apply(sql);
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('upgrade','Synthetic','upgrade@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('upgrade',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('c','upgrade','mailbox','gmail','synthetic','synthetic@example.invalid')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s','upgrade','c','m',0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('d','upgrade','s','body',?,'text/plain',10)",
    )
    .bind("a".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('o','upgrade','d',0,'v1',1,'unknown','{\"schemaVersion\":1,\"totalMinor\":\"100\"}','accepted')",
    )
    .run();
  await apply(pipeline);
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('legacy','upgrade','d','document-review','operational',0)",
    )
    .run();
  await apply(lifecycle);
  await apply(reviewFields);
  await apply(corrections);
  await apply(onboarding);
});
it("T12 DB populated upgrade preserves original observations and adds financial review ownership", async () => {
  expect(
    await db
      .prepare(
        "SELECT normalized_fields FROM observations WHERE user_id='upgrade' AND id='o'",
      )
      .first("normalized_fields"),
  ).toBe('{"schemaVersion":1,"totalMinor":"100"}');
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='review_items'",
        )
        .all()
    ).results,
  ).toHaveLength(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

const now = Date.UTC(2026, 9, 12);
function lease(user = "pipeline-a", id = `job-${user}`): JobLease {
  return {
    context: { userId: user, authority: "job" } as TenantContext,
    jobId: id,
    connectionId: "c",
    consentId: "consent",
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: `lease-${id}`,
    fence: 1,
    expiresAt: now + 300000,
    attempt: 1,
  };
}
function input(): LedgerInput {
  return {
    identity: {
      documentId: "d",
      contentHash: "a".repeat(64),
      extractionFingerprint: "b".repeat(64),
    },
    result: {
      status: "accepted",
      documentType: "receipt",
      warnings: [],
      records: [
        {
          merchant: "Synthetic Store",
          documentDate: "2026-10-12",
          eventDate: "2026-10-12",
          currency: "EUR",
          total: "10.00",
          tax: null,
          invoiceNumber: "INV1",
          orderReference: "ORDER1",
          paymentReference: "PAID1",
          refundReference: null,
          category: "other",
          paymentEvidence: "explicitly-paid",
          refundEvidence: "none",
          paymentMethodHint: "card",
          recurringCadence: "unknown",
          paymentAmount: "10.00",
          refundAmount: null,
          storeCreditAmount: null,
          provenance: [],
        },
      ],
    },
  };
}
beforeEach(async () => {
  for (const user of ["pipeline-a", "pipeline-b"]) {
    await db.prepare('DELETE FROM "user" WHERE id=?').bind(user).run();
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(user, "Synthetic", `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version,credential_version) VALUES('c',?,'mailbox','gmail','subject','synthetic@example.invalid','active','synthetic-envelope',1,1)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','processor','model','config',1,1)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent',?,'c',1,'processor','local',1,?,1)",
      )
      .bind(user, now)
      .run();
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s',?,'c','message',?,1)",
      )
      .bind(user, now)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state) VALUES('d',?,'s','body',?,'text/plain',100,0,'parser-v1','ready')",
      )
      .bind(user, "a".repeat(64))
      .run();
    const current = lease(user);
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,'c','consent',1,'source-extract',?,'leased',?,?,?,1)",
      )
      .bind(
        current.jobId,
        user,
        current.jobId,
        now,
        current.leaseId,
        now + 300000,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage,extraction_fingerprint) VALUES(?,?,'s','reconcile',?)",
      )
      .bind(user, current.jobId, "b".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,result_json,completed_at,created_at) VALUES(?,?,'extraction','d',?,'parser-v1',?,'hosted','processor','model','config',1,1,0,'nonce',?,?,?)",
      )
      .bind(
        user,
        "b".repeat(64),
        "a".repeat(64),
        "c".repeat(64),
        JSON.stringify(input().result),
        now,
        now,
      )
      .run();
  }
});
async function tableCount(
  table:
    | "observations"
    | "purchases"
    | "purchase_evidence"
    | "ledger_entries"
    | "review_items",
  user = "pipeline-a",
) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
    .bind(user)
    .first<number>("count");
}
it("T12 LEDGER-01 native atomic accepted observation/evidence/event and completed job", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const current = lease();
  const candidate = input();
  const snapshot = await repo.loadSnapshot(current, candidate);
  expect(snapshot).not.toBeNull();
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const plan = planLedgerIngestion(candidate, snapshot);
  expect(
    await repo.commit(current, {
      input: candidate,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  expect(await tableCount("observations")).toBe(1);
  expect(await tableCount("purchases")).toBe(1);
  expect(await tableCount("purchase_evidence")).toBe(1);
  expect(await tableCount("ledger_entries")).toBe(1);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(current.jobId)
      .first("status"),
  ).toBe("completed");
  expect(
    await repo.commit(current, {
      input: candidate,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("stale");
  expect(await tableCount("ledger_entries")).toBe(1);
});
it("T12 LEDGER-08 same document ID/hash are completely independent across tenants", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  for (const user of ["pipeline-a", "pipeline-b"]) {
    const current = lease(user);
    const candidate = input();
    const snapshot = await repo.loadSnapshot(current, candidate);
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error("missing synthetic snapshot");
    expect(snapshot.purchases).toEqual([]);
    expect(
      await repo.commit(current, {
        input: candidate,
        plan: planLedgerIngestion(candidate, snapshot),
        nextDocumentIndex: null,
      }),
    ).toBe("committed");
    expect(await tableCount("ledger_entries", user)).toBe(1);
  }
  expect(
    await repo.load({ ...lease(), context: lease("pipeline-b").context }),
  ).toBeNull();
  await expect(
    db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('invalid','pipeline-a','document-only-b','document-review','operational',0)",
      )
      .run(),
  ).rejects.toThrow();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("T12 native D1 injected financial write failure rolls back observation, purchase, evidence and source completion", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const current = lease();
  const candidate = input();
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  await db
    .prepare(
      "CREATE TRIGGER injected_pipeline_failure BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT,'synthetic financial failure'); END",
    )
    .run();
  try {
    await expect(
      repo.commit(current, {
        input: candidate,
        plan: planLedgerIngestion(candidate, snapshot),
        nextDocumentIndex: null,
      }),
    ).rejects.toThrow("PIPELINE_");
  } finally {
    await db.prepare("DROP TRIGGER injected_pipeline_failure").run();
  }
  for (const table of [
    "observations",
    "purchases",
    "purchase_evidence",
    "ledger_entries",
  ] as const)
    expect(await tableCount(table)).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(current.jobId)
      .first("status"),
  ).toBe("leased");
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id='pipeline-a' AND id='s'",
      )
      .first("processing_status"),
  ).toBe("discovered");
});
for (const mutation of [
  "UPDATE jobs SET fence=fence+1 WHERE user_id='pipeline-a'",
  "UPDATE jobs SET lease_expires_at=0 WHERE user_id='pipeline-a'",
  "UPDATE profiles SET status='deleting' WHERE user_id='pipeline-a'",
  "UPDATE connections SET generation=generation+1 WHERE user_id='pipeline-a'",
  "UPDATE processing_consents SET revoked_at=1 WHERE user_id='pipeline-a'",
  "UPDATE ai_settings SET revision=revision+1 WHERE user_id='pipeline-a'",
  "UPDATE source_messages SET available=0 WHERE user_id='pipeline-a'",
])
  it(`T12 stale lease/identity/config cannot write: ${mutation.split(" SET ")[1]}`, async () => {
    const repo = createPipelineRepository(db, { clock: () => now });
    const current = lease();
    const candidate = input();
    const snapshot = await repo.loadSnapshot(current, candidate);
    if (!snapshot) throw new Error("missing synthetic snapshot");
    await db.prepare(mutation).run();
    expect(await repo.checkpoint(current)).toBe(false);
    expect(
      await repo.commit(current, {
        input: candidate,
        plan: planLedgerIngestion(candidate, snapshot),
        nextDocumentIndex: null,
      }),
    ).toBe("stale");
    expect(await tableCount("observations")).toBe(0);
    expect(await tableCount("ledger_entries")).toBe(0);
  });
it("T12 populated upgrade and account deletion cascade retained financial/review rows without orphan ownership", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const candidate = input();
  const current = lease();
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const plan = planLedgerIngestion(candidate, snapshot);
  const observation = plan.observations[0];
  if (!observation) throw new Error("missing synthetic observation");
  await repo.commit(current, {
    input: candidate,
    plan: {
      ...plan,
      reviews: [
        {
          id: "review-for-deletion",
          documentId: "d",
          observationId: observation.id,
          purchaseId: observation.purchaseId,
          reason: "mixed-tender",
          blockingScope: "financial",
        },
      ],
    },
    nextDocumentIndex: null,
  });
  await db.prepare("DELETE FROM \"user\" WHERE id='pipeline-a'").run();
  for (const table of [
    "observations",
    "purchases",
    "purchase_evidence",
    "ledger_entries",
    "review_items",
  ] as const)
    expect(await tableCount(table)).toBe(0);
  expect(await tableCount("purchases", "pipeline-b")).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("T12 observation payload rejects raw text and quotes before any native D1 financial write", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const candidate = input();
  const current = lease();
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const contaminated = {
    ...candidate,
    result: { ...candidate.result, rawTranscript: "synthetic forbidden text" },
  };
  await expect(
    repo.commit(current, {
      input: contaminated,
      plan: planLedgerIngestion(candidate, snapshot),
      nextDocumentIndex: null,
    }),
  ).rejects.toThrow("INVALID_PIPELINE");
  expect(await tableCount("observations")).toBe(0);
  expect(await tableCount("ledger_entries")).toBe(0);
  if (candidate.result.status !== "accepted" || !candidate.result.records[0])
    throw new Error("missing synthetic record");
  const withQuote = {
    ...candidate,
    result: {
      ...candidate.result,
      records: [
        {
          ...candidate.result.records[0],
          provenance: [
            {
              field: "merchant" as const,
              inputPartId: "body",
              quote: "synthetic forbidden quote",
            },
          ],
        },
      ],
    },
  };
  await expect(
    repo.commit(current, {
      input: withQuote,
      plan: planLedgerIngestion(candidate, snapshot),
      nextDocumentIndex: null,
    }),
  ).rejects.toThrow("INVALID_PIPELINE");
  expect(await tableCount("observations")).toBe(0);
});
it("T12 reference and event lookups use tenant indexes", async () => {
  for (const [sql, index] of [
    [
      "SELECT id FROM purchases WHERE user_id='pipeline-a' AND merchant_normalized='synthetic store' AND invoice_ref='INV1'",
      "purchases_invoice_reference",
    ],
    [
      "SELECT id FROM observations WHERE user_id='pipeline-a' AND merchant_key='synthetic store' AND order_ref='ORDER1'",
      "observations_order_reference",
    ],
    [
      "SELECT id FROM ledger_entries WHERE user_id='pipeline-a' AND purchase_id='purchase' ORDER BY id",
      "ledger_entries_purchase",
    ],
  ]) {
    const plans = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{
      detail: string;
    }>();
    expect(plans.results.map((row) => row.detail).join(" ")).toContain(index);
  }
});
it("T12 failed first document persists an operational review and continues the next document", async () => {
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='infer',extraction_fingerprint=NULL WHERE user_id='pipeline-a'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state) VALUES('d2','pipeline-a','s','second',?,'text/plain',100,1,'parser-v1','ready')",
    )
    .bind("c".repeat(64))
    .run();
  const repo = createPipelineRepository(db, { clock: () => now });
  expect(
    await repo.failDocument(lease(), {
      documentId: "d",
      code: "refusal",
      nextDocumentIndex: 1,
    }),
  ).toBe("committed");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs j JOIN discovery_source_jobs dj ON dj.user_id=j.user_id AND dj.job_id=j.id WHERE j.user_id='pipeline-a' AND j.status='ready' AND dj.pipeline_stage='infer' AND dj.document_index=1",
      )
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT blocking_scope FROM review_items WHERE user_id='pipeline-a' AND document_id='d'",
      )
      .first("blocking_scope"),
  ).toBe("operational");
  expect(
    await db
      .prepare(
        "SELECT parse_state FROM documents WHERE user_id='pipeline-a' AND id='d'",
      )
      .first("parse_state"),
  ).toBe("needs_review");
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id='pipeline-a' AND id='s'",
      )
      .first("processing_status"),
  ).toBe("discovered");
});
it("T12 typed unsupported ZIP metadata remains alongside supported receipt metadata", async () => {
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='parse',extraction_fingerprint=NULL WHERE user_id='pipeline-a'",
    )
    .run();
  const repo = createPipelineRepository(db, { clock: () => now });
  await expect(
    repo.stageDocuments(lease(), [
      {
        id: "d",
        partKey: "body",
        contentHash: "a".repeat(64),
        mime: "text/plain",
        byteLength: 100,
        parseState: "ready",
        parserVersion: "parser-v1",
      },
      {
        id: "zip",
        partKey: "zip",
        contentHash: "d".repeat(64),
        mime: "application/zip",
        byteLength: 20,
        parseState: "unsupported",
        parserVersion: "parser-v1",
        code: "unsupported-format",
      },
    ]),
  ).resolves.toBe("committed");
  expect(
    await db
      .prepare(
        "SELECT mime FROM documents WHERE user_id='pipeline-a' AND id='zip'",
      )
      .first("mime"),
  ).toBe("application/zip");
});

it("T12 actual bounded snapshot candidate query uses reference/content/event indexes", async () => {
  const spy = vi.spyOn(db, "prepare");
  const repo = createPipelineRepository(db, { clock: () => now });
  let sql: string | undefined;
  try {
    expect(await repo.loadSnapshot(lease(), input())).not.toBeNull();
    sql = spy.mock.calls.find(([query]) => query.startsWith("WITH q AS"))?.[0];
  } finally {
    spy.mockRestore();
  }
  if (!sql) throw new Error("missing actual snapshot query");
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(
      ...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null),
    )
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join(" ");
  for (const index of [
    "purchases_invoice_reference",
    "purchases_order_reference",
    "observations_invoice_reference",
    "observations_order_reference",
    "documents_tenant_hash",
  ])
    expect(details).toContain(index);
  expect(details).not.toMatch(/SCAN p(?:\s|$)/);
});
it("T12 an external version bump cannot masquerade as this batch's financial projection", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,payment_state) VALUES('existing','pipeline-a','Synthetic Store','synthetic store','INV1','ORDER1','2026-10-12',1000,'EUR','unpaid')",
    )
    .run();
  const current = lease();
  const candidate = input();
  const repo = createPipelineRepository(db, { clock: () => now });
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const plan = planLedgerIngestion(candidate, snapshot);
  expect(plan.paymentStates).toEqual([
    { purchaseId: "existing", expectedVersion: 1, paymentState: "paid" },
  ]);
  await db
    .prepare(
      "UPDATE purchases SET version=2 WHERE user_id='pipeline-a' AND id='existing'",
    )
    .run();
  await expect(
    repo.commit(current, { input: candidate, plan, nextDocumentIndex: null }),
  ).rejects.toThrow("PIPELINE_CONFLICT");
  expect(await tableCount("ledger_entries")).toBe(0);
  expect(await tableCount("observations")).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE user_id='pipeline-a' AND id=?")
      .bind(current.jobId)
      .first("status"),
  ).toBe("leased");
});
async function twoExistingPurchases() {
  const candidate = input();
  if (candidate.result.status !== "accepted" || !candidate.result.records[0])
    throw new Error("missing synthetic record");
  const first = candidate.result.records[0];
  const second = {
    ...first,
    merchant: "Synthetic Second",
    invoiceNumber: "INV2",
    orderReference: "ORDER2",
    paymentReference: "PAID2",
  };
  const multiple = {
    ...candidate,
    result: { ...candidate.result, records: [first, second] },
  };
  for (const [id, merchant, invoice, order] of [
    ["existing", "Synthetic Store", "INV1", "ORDER1"],
    ["second", "Synthetic Second", "INV2", "ORDER2"],
  ])
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,payment_state) VALUES(?,'pipeline-a',?,?,?,?, '2026-10-12',1000,'EUR','unpaid')",
      )
      .bind(id, merchant, merchant?.toLowerCase() ?? "", invoice, order)
      .run();
  await db
    .prepare(
      "UPDATE ai_extractions SET result_json=? WHERE user_id='pipeline-a'",
    )
    .bind(JSON.stringify(multiple.result))
    .run();
  const repo = createPipelineRepository(db, { clock: () => now });
  const snapshot = await repo.loadSnapshot(lease(), multiple);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const plan = planLedgerIngestion(multiple, snapshot);
  expect(plan.paymentStates).toHaveLength(2);
  return { repo, candidate: multiple, plan };
}
it("T12 two existing purchase projections complete atomically in one native D1 batch", async () => {
  const { repo, candidate, plan } = await twoExistingPurchases();
  expect(
    await repo.commit(lease(), {
      input: candidate,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  expect(await tableCount("ledger_entries")).toBe(2);
  expect(
    (
      await db
        .prepare(
          "SELECT id,payment_state,version FROM purchases WHERE user_id='pipeline-a' ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual([
    { id: "existing", payment_state: "paid", version: 2 },
    { id: "second", payment_state: "paid", version: 2 },
  ]);
});
it("T12 one stale version prevents both planned purchase projections and all financial effects", async () => {
  const { repo, candidate, plan } = await twoExistingPurchases();
  await db
    .prepare(
      "UPDATE purchases SET version=2 WHERE user_id='pipeline-a' AND id='second'",
    )
    .run();
  await expect(
    repo.commit(lease(), { input: candidate, plan, nextDocumentIndex: null }),
  ).rejects.toThrow("PIPELINE_CONFLICT");
  expect(await tableCount("ledger_entries")).toBe(0);
  expect(await tableCount("observations")).toBe(0);
  expect(await tableCount("purchase_evidence")).toBe(0);
  expect(
    (
      await db
        .prepare(
          "SELECT id,payment_state,version FROM purchases WHERE user_id='pipeline-a' ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual([
    { id: "existing", payment_state: "unpaid", version: 1 },
    { id: "second", payment_state: "unpaid", version: 2 },
  ]);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE user_id='pipeline-a' AND id=?")
      .bind(lease().jobId)
      .first("status"),
  ).toBe("leased");
});

it("T13 HOME05 review storage accepts field names and rejects hidden source text", async () => {
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at,missing_fields_json) VALUES('missing','pipeline-a','d','extraction-review','financial',0,?)",
    )
    .bind('["currency","total"]')
    .run();
  expect(
    await db
      .prepare(
        "SELECT missing_fields_json FROM review_items WHERE user_id='pipeline-a' AND id='missing'",
      )
      .first("missing_fields_json"),
  ).toBe('["currency","total"]');
  for (const invalid of [
    '["receipt body"]',
    '{"currency":"EUR"}',
    '["currency","currency"]',
    '["currency",42]',
  ]) {
    await expect(
      db
        .prepare(
          "UPDATE review_items SET missing_fields_json=? WHERE user_id='pipeline-a' AND id='missing'",
        )
        .bind(invalid)
        .run(),
    ).rejects.toThrow();
  }
});

it("T13 HOME05 incomplete extraction persists an unlinked question without creating cash", async () => {
  const candidate: LedgerInput = {
    ...input(),
    result: {
      status: "needs-review",
      reason: "incomplete",
      missingFields: ["currency", "total"],
    },
  };
  await db
    .prepare(
      "UPDATE ai_extractions SET result_json=? WHERE user_id='pipeline-a'",
    )
    .bind(JSON.stringify(candidate.result))
    .run();
  const repo = createPipelineRepository(db, { clock: () => now });
  const snapshot = await repo.loadSnapshot(lease(), candidate);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  expect(
    await repo.commit(lease(), {
      input: candidate,
      plan: planLedgerIngestion(candidate, snapshot),
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  expect(
    (
      await db
        .prepare(
          "SELECT purchase_id,missing_fields_json FROM review_items WHERE user_id='pipeline-a'",
        )
        .all()
    ).results,
  ).toEqual([
    { purchase_id: null, missing_fields_json: '["currency","total"]' },
  ]);
  expect(await tableCount("ledger_entries")).toBe(0);
});

it("T13 HOME05 populated review upgrade leaves legacy context unknown", async () => {
  expect(
    await db
      .prepare(
        "SELECT reason,missing_fields_json FROM review_items WHERE user_id='upgrade' AND id='legacy'",
      )
      .first(),
  ).toEqual({ reason: "document-review", missing_fields_json: null });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("T14 EDIT-01 trusted pipeline snapshot loads durable purchase overrides and original corrected cash values", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const candidate = input();
  const emptySnapshot = await repo.loadSnapshot(lease(), candidate);
  if (!emptySnapshot) throw new Error("missing synthetic snapshot");
  const initial = planLedgerIngestion(candidate, emptySnapshot);
  expect(
    await repo.commit(lease(), {
      input: candidate,
      plan: initial,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  const purchase = initial.purchases[0],
    entry = initial.events[0];
  if (!purchase || !entry) throw new Error("missing synthetic cash");
  await db
    .prepare(
      "UPDATE purchases SET merchant_raw='Corrected Synthetic',merchant_normalized='corrected synthetic',version=version+1 WHERE user_id='pipeline-a' AND id=?",
    )
    .bind(purchase.id)
    .run();
  await db
    .prepare(
      "UPDATE ledger_entries SET amount_minor=450,version=version+1 WHERE user_id='pipeline-a' AND id=?",
    )
    .bind(entry.id)
    .run();
  await db
    .prepare(
      "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES('pipeline-a','purchase',?,'merchant',?,?,1)",
    )
    .bind(
      purchase.id,
      JSON.stringify(purchase.merchant),
      JSON.stringify("Corrected Synthetic"),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES('pipeline-a','entry',?,'amountMinor',?,?,1)",
    )
    .bind(entry.id, JSON.stringify(entry.amountMinor), JSON.stringify(450))
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=? WHERE user_id='pipeline-a' AND id=?",
    )
    .bind(lease().leaseId, now + 300000, lease().jobId)
    .run();
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='reconcile',extraction_fingerprint=? WHERE user_id='pipeline-a'",
    )
    .bind(candidate.identity.extractionFingerprint)
    .run();
  const snapshot = await repo.loadSnapshot(lease(), candidate);
  if (!snapshot) throw new Error("missing updated synthetic snapshot");
  expect(
    snapshot.purchases.find((row) => row.id === purchase.id)?.overriddenFields,
  ).toEqual(["merchant"]);
  expect(snapshot.events.find((row) => row.id === entry.id)).toMatchObject({
    amountMinor: 450,
    sourceValues: { amountMinor: 1000 },
  });
  await db
    .prepare(
      "UPDATE purchases SET total_minor=NULL WHERE user_id='pipeline-a' AND id=?",
    )
    .bind(purchase.id)
    .run();
  await db
    .prepare(
      "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES('pipeline-a','purchase',?,'totalMinor','1000','null',1)",
    )
    .bind(purchase.id)
    .run();
  const unknownGross = await repo.loadSnapshot(lease(), candidate);
  expect(
    unknownGross?.purchases.find((row) => row.id === purchase.id),
  ).toMatchObject({
    totalMinor: null,
    overriddenFields: ["merchant", "totalMinor"],
  });
});

it("T29 processing digest gates initial checkpoint and changed-consent writes without an extra query", async () => {
  const current = lease();
  const accepted = "d".repeat(64);
  const repository = createPipelineRepository(db, {
    clock: () => now,
    processingDigest: async () => accepted,
  });
  expect(await repository.checkpoint(current)).toBe(false);
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=? AND id=?",
    )
    .bind(accepted, current.context.userId, current.consentId)
    .run();
  expect(await repository.checkpoint(current)).toBe(true);
  expect(await repository.load(current)).not.toBeNull();
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=? AND id=?",
    )
    .bind("e".repeat(64), current.context.userId, current.consentId)
    .run();
  expect(await repository.checkpoint(current)).toBe(false);
  expect(
    await repository.fail(current, { status: "review", code: "stale-policy" }),
  ).toBe("stale");
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
      .bind(current.context.userId, current.jobId)
      .first("status"),
  ).toBe("leased");
});

it("T14 pipeline snapshot preserves a manual source association without model observations", async () => {
  const current = lease();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,category,payment_state,origin) VALUES('manual-record',?,'User merchant','user merchant','2026-10-12',1000,'EUR','other','unknown','user-supplied')",
    )
    .bind(current.context.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) VALUES(?,'manual-record','d')",
    )
    .bind(current.context.userId)
    .run();
  const candidate = input();
  const snapshot = await createPipelineRepository(db, {
    clock: () => now,
  }).loadSnapshot(current, candidate);
  expect(snapshot?.manualEvidence).toEqual([
    {
      contentHash: candidate.identity.contentHash,
      purchaseId: "manual-record",
    },
  ]);
  expect(snapshot?.purchases.map((purchase) => purchase.id)).toContain(
    "manual-record",
  );
  expect(snapshot?.observations).toEqual([]);
});

for (const column of [
  "lifecycle_delete_connection_id",
  "lifecycle_recompute_connection_id",
] as const) {
  it(`T14 pipeline retries a related purchase fenced by ${column} without creating replacement cash`, async () => {
    const current = lease();
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,category,payment_state,origin) VALUES('manual-fenced',?,'User merchant','user merchant','2026-10-12',1000,'EUR','other','unknown','user-supplied')",
      )
      .bind(current.context.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) VALUES(?,'manual-fenced','d')",
      )
      .bind(current.context.userId)
      .run();
    await db
      .prepare(
        `UPDATE purchases SET ${column}='c' WHERE user_id=? AND id='manual-fenced'`,
      )
      .bind(current.context.userId)
      .run();
    const repo = createPipelineRepository(db, { clock: () => now });
    await expect(repo.loadSnapshot(current, input())).rejects.toThrow(
      "PIPELINE_CONFLICT",
    );
    expect(await tableCount("purchases")).toBe(1);
    expect(await tableCount("ledger_entries")).toBe(0);
    await db
      .prepare(
        `UPDATE purchases SET ${column}=NULL WHERE user_id=? AND id='manual-fenced'`,
      )
      .bind(current.context.userId)
      .run();
    expect(
      (await repo.loadSnapshot(current, input()))?.purchases.map(
        (purchase) => purchase.id,
      ),
    ).toContain("manual-fenced");
  });
}

it("T14 reprocessing an excluded purchase keeps new cash excluded in list summary and export", async () => {
  const current = lease();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,category,payment_state,record_status,version) VALUES('excluded-source',?,'Synthetic Store','synthetic store','INV1','ORDER1','2026-10-12',1000,'EUR','other','unknown','excluded',2)",
    )
    .bind(current.context.userId)
    .run();
  const repo = createPipelineRepository(db, { clock: () => now });
  const candidate = input();
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("missing owned synthetic snapshot");
  const plan = planLedgerIngestion(candidate, snapshot);
  expect(
    await repo.commit(current, {
      input: candidate,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  const reader = createPurchaseViewReader(db);
  const summary = await reader.summary(current.context);
  expect(summary.totals).toEqual([]);
  expect(summary.excludedEntryCount).toBe(1);
  const list = await reader.list(current.context, { limit: 25 });
  expect(list.rows).toHaveLength(1);
  expect(list.rows[0]?.recordStatus).toBe("excluded");
  expect(list.rows[0]?.lifecycle).toEqual([]);
  const exported = await reader.exportSnapshot(current.context);
  expect(exported.ledgerEntries).toHaveLength(1);
  expect(exported.ledgerEntries[0]?.eligible).toBe(false);
  expect(exported.summary.totals).toEqual([]);
});

it("manual false-positive decision fences future checkpoints and stale financial commits without crossing tenants", async () => {
  const repo = createPipelineRepository(db, { clock: () => now });
  const current = lease();
  const candidate = input();
  const snapshot = await repo.loadSnapshot(current, candidate);
  if (!snapshot) throw new Error("Synthetic snapshot missing");
  const plan = planLedgerIngestion(candidate, snapshot);
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('discarded-source','pipeline-a','d','document-review','operational',?)",
    )
    .bind(now)
    .run();
  await db
    .prepare(
      "INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) VALUES('discard-audit','pipeline-a','review','discarded-source','not-a-purchase','{}','{}',?)",
    )
    .bind(now)
    .run();
  expect(await repo.checkpoint(current)).toBe(false);
  expect(await repo.checkpoint(lease("pipeline-b"))).toBe(true);
  expect(
    await repo.commit(current, {
      input: candidate,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("stale");
  expect(await tableCount("purchases")).toBe(0);
  expect(await tableCount("ledger_entries")).toBe(0);
});
