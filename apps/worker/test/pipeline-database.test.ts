// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import { purchaseCorrectionRequestSchema } from "@invoxim/contracts";
import {
  type JobLease,
  type LedgerInput,
  planLedgerIngestion,
  type TenantContext,
} from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCorrectionStore } from "../../../packages/adapters/src/corrections/store";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPurchaseViewReader } from "../../../packages/adapters/src/purchase-views";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

beforeAll(async () => {
  await useCurrentSchema(db);
  await useCurrentSchema(db);
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

  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('legacy','upgrade','d','document-review','operational',0)",
    )
    .run();
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
/** P7: tests pass processingDigest explicitly; fixtures accept this digest. */
const acceptedDigest = "d".repeat(64);
function repoOptions() {
  return {
    clock: () => now,
    processingDigest: async () => acceptedDigest,
  };
}
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
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES('consent',?,'c',1,'processor','local',1,?,1,?)",
      )
      .bind(user, now, acceptedDigest)
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
    const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
it("P9 failDocument runs in infer and reconcile but refuses parse", async () => {
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='reconcile',extraction_fingerprint=NULL WHERE user_id='pipeline-a'",
    )
    .run();
  const repo = createPipelineRepository(db, repoOptions());
  // Reconcile must be able to fail a document (classification-verification).
  expect(
    await repo.failDocument(lease(), {
      documentId: "d",
      code: "refusal",
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='parse',extraction_fingerprint=NULL WHERE user_id='pipeline-a'",
    )
    .run();
  const again = createPipelineRepository(db, repoOptions());
  expect(
    await again.failDocument(lease(), {
      documentId: "d",
      code: "refusal",
      nextDocumentIndex: null,
    }),
  ).toBe("stale");
});
it("T12 typed unsupported ZIP metadata remains alongside supported receipt metadata", async () => {
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='parse',extraction_fingerprint=NULL WHERE user_id='pipeline-a'",
    )
    .run();
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=? AND id=?",
    )
    .bind("f".repeat(64), current.context.userId, current.consentId)
    .run();
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

// P0.9 / P7: processingDigest is not a test-only optional mode. The
// accepted-configuration-digest consent gate must run for every pipeline
// repository; a caller cannot disable it by omitting the option.
it("P0.9 omitting processingDigest must fail closed on the consent digest gate", async () => {
  const current = lease();
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=? AND id=?",
    )
    .bind("d".repeat(64), current.context.userId, current.consentId)
    .run();
  // A resolver that rejects the consent's digest must fence checkpoint.
  const rejecting = createPipelineRepository(db, {
    clock: () => now,
    processingDigest: async () => "e".repeat(64),
  });
  expect(await rejecting.checkpoint(current)).toBe(false);
  // Omitting processingDigest must not silently skip the gate (P7).
  // Intended: this construction fails closed — checkpoint refuses — rather
  // than returning true with the consent digest unchecked.
  const omitted = createPipelineRepository(db, {
    clock: () => now,
  } as Parameters<typeof createPipelineRepository>[1]);
  await expect(omitted.checkpoint(current)).rejects.toThrow();
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
  const snapshot = await createPipelineRepository(
    db,
    repoOptions(),
  ).loadSnapshot(current, candidate);
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
    const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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
  const repo = createPipelineRepository(db, repoOptions());
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

// P0.5 / P3: source_messages.processing_status must follow one rule on both
// terminal write paths. A document whose parse_state is outside
// {ready, extracted} is unresolved content: it keeps the source at 'review'
// whether the current document was committed or classified as a non-purchase.
// Open review items also force 'review'. Otherwise a remaining 'ready'
// document yields 'discovered', a completed extraction yields 'processed',
// and nothing usable yields 'unsupported'.
it("P0.5 commit and skipDocument share one source status rule for an unresolved sibling document", async () => {
  for (const user of ["pipeline-a", "pipeline-b"]) {
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state,parse_code) VALUES('zip',?,'s','zip',?,'application/zip',20,1,'parser-v1','unsupported','unsupported-format')",
      )
      .bind(user, "e".repeat(64))
      .run();
  }
  const commitRepo = createPipelineRepository(db, repoOptions());
  const commitLease = lease("pipeline-a");
  const candidate = input();
  const snapshot = await commitRepo.loadSnapshot(commitLease, candidate);
  expect(snapshot).not.toBeNull();
  if (!snapshot) throw new Error("missing synthetic snapshot");
  expect(
    await commitRepo.commit(commitLease, {
      input: candidate,
      plan: planLedgerIngestion(candidate, snapshot),
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  const commitStatus = await db
    .prepare(
      "SELECT processing_status FROM source_messages WHERE user_id='pipeline-a' AND id='s'",
    )
    .first<string>("processing_status");

  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='infer',extraction_fingerprint=NULL WHERE user_id='pipeline-b'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,result_json,completed_at,created_at) VALUES(?,?,'extraction','d',?,'email-classification-v1',?,'hosted','processor','model','config',1,1,0,'nonce',?,?,?)",
    )
    .bind(
      "pipeline-b",
      "e".repeat(64),
      "a".repeat(64),
      "f".repeat(64),
      JSON.stringify({ status: "classified", isReceipt: 0 }),
      now,
      now,
    )
    .run();
  const skipRepo = createPipelineRepository(db, repoOptions());
  expect(
    await skipRepo.skipDocument?.(lease("pipeline-b"), {
      documentId: "d",
      classificationFingerprint: "e".repeat(64),
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  const skipStatus = await db
    .prepare(
      "SELECT processing_status FROM source_messages WHERE user_id='pipeline-b' AND id='s'",
    )
    .first<string>("processing_status");

  expect(commitStatus).toBe(skipStatus);
  expect(commitStatus).toBe("review");
});

/** Re-arm the seeded job so the same document can be reconciled again (replay). */
async function releaseForReplay(user = "pipeline-a") {
  const current = lease(user);
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=? WHERE user_id=? AND id=?",
    )
    .bind(current.leaseId, now + 300000, user, current.jobId)
    .run();
  await db
    .prepare(
      "UPDATE discovery_source_jobs SET pipeline_stage='reconcile',extraction_fingerprint=? WHERE user_id=?",
    )
    .bind(input().identity.extractionFingerprint, user)
    .run();
  return current;
}

// Retargeted from the deleted HYG-2 sources.ts test
// "T04 exact financial replay preserves a manual merchant edit and version".
it("T04 EDIT-01 exact pipeline replay preserves a manual merchant edit, version and single cash fact", async () => {
  const repo = createPipelineRepository(db, repoOptions());
  const candidate = input();
  const first = await repo.loadSnapshot(lease(), candidate);
  if (!first) throw new Error("missing synthetic snapshot");
  const initial = planLedgerIngestion(candidate, first);
  expect(
    await repo.commit(lease(), {
      input: candidate,
      plan: initial,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  const purchaseId = initial.purchases[0]?.id;
  if (!purchaseId) throw new Error("missing synthetic purchase");
  const committedVersion = await db
    .prepare(
      "SELECT version FROM purchases WHERE user_id='pipeline-a' AND id=?",
    )
    .bind(purchaseId)
    .first<number>("version");
  if (committedVersion === null) throw new Error("missing committed version");
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('pipeline-manual-edit',9999999999999,'synthetic-pipeline-edit-token',0,0,'pipeline-a')",
    )
    .run();
  const edited = await createCorrectionStore(db, () => now).execute(
    {
      tenant: { userId: "pipeline-a", authority: "session" } as TenantContext,
      sessionId: "pipeline-manual-edit",
    },
    {
      kind: "purchase-edit",
      purchaseId,
      request: purchaseCorrectionRequestSchema.parse({
        version: committedVersion,
        changes: { merchant: "Manual synthetic merchant" },
      }),
    },
    "pipeline-manual-edit-key",
  );
  const editedVersion = committedVersion + 1;
  expect(edited.version).toBe(editedVersion);

  const replayLease = await releaseForReplay();
  const snapshot = await repo.loadSnapshot(replayLease, candidate);
  if (!snapshot) throw new Error("missing replay snapshot");
  const replay = planLedgerIngestion(candidate, snapshot);
  expect(replay.purchases).toEqual([]);
  expect(
    await repo.commit(replayLease, {
      input: candidate,
      plan: replay,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  expect(
    await db
      .prepare(
        "SELECT merchant_raw,merchant_normalized,version,total_minor FROM purchases WHERE user_id='pipeline-a' AND id=?",
      )
      .bind(purchaseId)
      .first(),
  ).toEqual({
    merchant_raw: "Manual synthetic merchant",
    merchant_normalized: "manual synthetic merchant",
    version: editedVersion,
    total_minor: 1000,
  });
  expect(await tableCount("purchases")).toBe(1);
  expect(await tableCount("purchase_evidence")).toBe(1);
  expect(await tableCount("ledger_entries")).toBe(1);
  expect(await tableCount("observations")).toBe(1);
});

// Retargeted from the deleted HYG-2 sources.ts test
// "T04 concurrent event replay with a different purchase rejects phantom records".
it("T04 LEDGER-01 concurrent commits of two sources planned against the same empty snapshot keep one purchase and one payment", async () => {
  const user = "pipeline-a",
    secondFingerprint = "f".repeat(64),
    secondHash = "e".repeat(64);
  const firstInput = input();
  if (firstInput.result.status !== "accepted" || !firstInput.result.records[0])
    throw new Error("missing synthetic record");
  // Different document references (so a different planned purchase) but the
  // same merchant and payment reference (so the same cash business key).
  const secondResult = {
    ...firstInput.result,
    records: [
      {
        ...firstInput.result.records[0],
        invoiceNumber: "INV-PHANTOM",
        orderReference: "ORDER-PHANTOM",
      },
    ],
  };
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s2',?,'c','message-2',?,1)",
    )
    .bind(user, now)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state) VALUES('d2',?,'s2','body',?,'text/plain',100,0,'parser-v1','ready')",
    )
    .bind(user, secondHash)
    .run();
  const second = lease(user, "job-second");
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,'c','consent',1,'source-extract',?,'leased',?,?,?,1)",
    )
    .bind(second.jobId, user, second.jobId, now, second.leaseId, now + 300000)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage,extraction_fingerprint) VALUES(?,?,'s2','reconcile',?)",
    )
    .bind(user, second.jobId, secondFingerprint)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,result_json,completed_at,created_at) VALUES(?,?,'extraction','d2',?,'parser-v1',?,'hosted','processor','model','config',1,1,0,'nonce-2',?,?,?)",
    )
    .bind(
      user,
      secondFingerprint,
      secondHash,
      "c".repeat(64),
      JSON.stringify(secondResult),
      now,
      now,
    )
    .run();
  const secondInput: LedgerInput = {
    identity: {
      documentId: "d2",
      contentHash: secondHash,
      extractionFingerprint: secondFingerprint,
    },
    result: secondResult,
  };
  const repo = createPipelineRepository(db, repoOptions());
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    repo.loadSnapshot(lease(user), firstInput),
    repo.loadSnapshot(second, secondInput),
  ]);
  if (!firstSnapshot || !secondSnapshot)
    throw new Error("missing synthetic snapshots");
  const firstPlan = planLedgerIngestion(firstInput, firstSnapshot),
    secondPlan = planLedgerIngestion(secondInput, secondSnapshot);
  // Both racers independently plan a new purchase for the same payment identity.
  expect(firstPlan.purchases).toHaveLength(1);
  expect(secondPlan.purchases).toHaveLength(1);
  expect(firstPlan.purchases[0]?.id).not.toBe(secondPlan.purchases[0]?.id);
  expect(secondPlan.events[0]?.businessKey).toBe(
    firstPlan.events[0]?.businessKey,
  );
  const results = await Promise.allSettled([
    repo.commit(lease(user), {
      input: firstInput,
      plan: firstPlan,
      nextDocumentIndex: null,
    }),
    repo.commit(second, {
      input: secondInput,
      plan: secondPlan,
      nextDocumentIndex: null,
    }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  expect(fulfilled).toEqual([{ status: "fulfilled", value: "committed" }]);
  const rejected = results.filter((result) => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0]?.reason)).toContain("PIPELINE_CONFLICT");
  expect(await tableCount("purchases")).toBe(1);
  expect(await tableCount("ledger_entries")).toBe(1);
  expect(await tableCount("purchase_evidence")).toBe(1);
  expect(await tableCount("observations")).toBe(1);
  expect(
    (
      await db
        .prepare(
          "SELECT status FROM jobs WHERE user_id=? AND id IN (?,?) ORDER BY status",
        )
        .bind(user, lease(user).jobId, second.jobId)
        .all<{ status: string }>()
    ).results.map((row) => row.status),
  ).toEqual(["completed", "leased"]);
});

// CORE-6 OQ-A/B/C through the real pipeline snapshot, planner and commit:
// an earlier persisted document `d0` already settled part of purchase
// `existing`; the current document `d` adds a 4.00 installment.
async function seedEarlierPayment(options: {
  storedState: "unknown" | "paid";
  cashMinor: number | null;
  record?: Record<string, unknown>;
  connection?: "c" | "c-old";
  review?: "document" | "observation";
  reviewStatus?: "open" | "resolved";
}) {
  const user = "pipeline-a";
  const connection = options.connection ?? "c";
  if (connection === "c-old") {
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('c-old',?,'mailbox','gmail','old-subject','old@example.invalid','disconnected')",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'connection','c-old','oq-c-deletion',0,1)",
      )
      .bind(user)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,payment_state) VALUES('existing',?,'Synthetic Store','synthetic store','INV1','ORDER1','2026-10-12',1000,'EUR',?)",
    )
    .bind(user, options.storedState)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s0',?,?,'message-0',0,1)",
    )
    .bind(user, connection)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state) VALUES('d0',?,'s0','body',?,'text/plain',100,0,'parser-v1','extracted')",
    )
    .bind(user, "e".repeat(64))
    .run();
  const base = input();
  if (base.result.status !== "accepted" || !base.result.records[0])
    throw new Error("missing synthetic record");
  const record = {
    ...base.result.records[0],
    paymentAmount: "6.00",
    paymentReference: "PAID0",
    ...options.record,
  };
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,structured_fields,merchant_key,invoice_ref,order_ref,review_state) VALUES('o0',?,'d0',0,?,1,'explicitly-paid','{\"schemaVersion\":1}',?,'synthetic store','INV1','ORDER1','accepted')",
    )
    .bind(
      user,
      "f".repeat(64),
      JSON.stringify({ schemaVersion: 1, documentType: "receipt", record }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'existing','o0','document')",
    )
    .bind(user)
    .run();
  if (options.cashMinor !== null)
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('e0',?,'existing','o0',?,'payment',?,'EUR','2026-10-12','explicit-event-date',1)",
      )
      .bind(
        user,
        `cash-reference:${JSON.stringify(["synthetic store", "payment", "PAID0"])}`,
        options.cashMinor,
      )
      .run();
  if (options.review)
    await db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES('earlier-review',?,'d0',?,NULL,'extraction-review','financial',?,0)",
      )
      .bind(
        user,
        options.review === "observation" ? "o0" : null,
        options.reviewStatus ?? "open",
      )
      .run();
  const installment = input();
  if (
    installment.result.status !== "accepted" ||
    !installment.result.records[0]
  )
    throw new Error("missing synthetic record");
  const current: LedgerInput = {
    ...installment,
    result: {
      ...installment.result,
      records: [{ ...installment.result.records[0], paymentAmount: "4.00" }],
    },
  };
  await db
    .prepare("UPDATE ai_extractions SET result_json=? WHERE user_id=?")
    .bind(JSON.stringify(current.result), user)
    .run();
  return current;
}
async function ingest(current: LedgerInput) {
  const repo = createPipelineRepository(db, repoOptions());
  const snapshot = await repo.loadSnapshot(lease(), current);
  if (!snapshot) throw new Error("missing synthetic snapshot");
  const plan = planLedgerIngestion(current, snapshot);
  expect(
    await repo.commit(lease(), {
      input: current,
      plan,
      nextDocumentIndex: null,
    }),
  ).toBe("committed");
  expect(plan.events.map((event) => event.amountMinor)).toEqual([400]);
  return db
    .prepare(
      "SELECT payment_state FROM purchases WHERE user_id='pipeline-a' AND id='existing'",
    )
    .first<string>("payment_state");
}
it("CORE-6 OQ-A pipeline: a persisted store-credit proof plus new cash keeps the purchase paid", async () => {
  const current = await seedEarlierPayment({
    storedState: "paid",
    cashMinor: null,
    record: {
      paymentMethodHint: "store-credit",
      paymentAmount: null,
      storeCreditAmount: "10.00",
      paymentReference: null,
    },
  });
  expect(await ingest(current)).toBe("paid");
});
it("CORE-6 OQ-A pipeline: stored 'paid' without current cash/credit support is recomputed from the new cash", async () => {
  const current = await seedEarlierPayment({
    storedState: "paid",
    cashMinor: null,
    record: { paymentEvidence: "unknown", paymentAmount: null },
  });
  expect(await ingest(current)).toBe("partially_paid");
});
it.each(["document", "observation"] as const)(
  "CORE-6 OQ-B pipeline: an open financial review linked only via the earlier entry's %s excludes its cash",
  async (review) => {
    const current = await seedEarlierPayment({
      storedState: "unknown",
      cashMinor: 600,
      review,
    });
    // 6.00 blocked + 4.00 new of 10.00: not paid.
    expect(await ingest(current)).toBe("partially_paid");
  },
);
it("CORE-6 OQ-B pipeline adversarial: a resolved review on the earlier document does not exclude its cash", async () => {
  const current = await seedEarlierPayment({
    storedState: "unknown",
    cashMinor: 600,
    review: "document",
    reviewStatus: "resolved",
  });
  expect(await ingest(current)).toBe("paid");
});
it("CORE-6 OQ-C pipeline: cash from a connection with a pending deletion is excluded before cleanup marks the purchase", async () => {
  const current = await seedEarlierPayment({
    storedState: "unknown",
    cashMinor: 600,
    connection: "c-old",
  });
  // 6.00 from the deleting connection is unsupported; 4.00 new of 10.00.
  expect(await ingest(current)).toBe("partially_paid");
});
it("CORE-6 OQ-C pipeline adversarial: a pending deletion of another tenant's connection does not exclude cash", async () => {
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES('pipeline-b','connection','c','oq-c-other-tenant',0,1)",
    )
    .run();
  const current = await seedEarlierPayment({
    storedState: "unknown",
    cashMinor: 600,
  });
  expect(await ingest(current)).toBe("paid");
});
