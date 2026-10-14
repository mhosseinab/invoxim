import { env } from "cloudflare:workers";
import {
  type JobLease,
  type LedgerInput,
  planLedgerIngestion,
  type TenantContext,
} from "@invoxim/core";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import archive from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import recurrence from "../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import outlook from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
let owner = "";
let fixtureNumber = 0;
beforeAll(async () => {
  for (const sql of [baseline, archive, recurrence, outlook])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  for (const statement of revision.match(
    /ALTER TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g,
  ) ?? [])
    await db.prepare(statement).run();
});
afterEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS qa_revision_pipeline_abort").run();
});
async function stamp() {
  return db
    .prepare(
      "SELECT CAST(reporting_revision AS TEXT) AS revision FROM profiles WHERE user_id=?",
    )
    .bind(owner)
    .first<string>("revision");
}
async function count(
  table: "observations" | "purchase_evidence" | "ledger_entries",
) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
    .bind(owner)
    .first<number>("count");
}
const now = Date.UTC(2026, 9, 12);
function lease(user = owner, id = `job-${user}`): JobLease {
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
  fixtureNumber++;
  owner = `revision-pipeline-${fixtureNumber}`;
  const user = owner;
  {
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
      .bind(user, now, "f".repeat(64))
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

async function operation() {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,payment_state) VALUES('existing',?,'Synthetic Store','synthetic store','INV1','ORDER1','2026-10-12',1000,'EUR','unpaid')",
    )
    .bind(owner)
    .run();
  const meter = createInvocationDatabase(db, 40);
  const repository = createPipelineRepository(meter.db, {
    clock: () => now,
    remainingStatements: () => 40 - meter.executedStatements(),
    processingDigest: async () => "f".repeat(64),
  });
  const candidate = input();
  const snapshot = await repository.loadSnapshot(lease(), candidate);
  if (!snapshot) throw new Error("MISSING_SYNTHETIC_SNAPSHOT");
  const plan = planLedgerIngestion(candidate, snapshot);
  expect(plan.paymentStates).toEqual([
    { purchaseId: "existing", expectedVersion: 1, paymentState: "paid" },
  ]);
  return {
    repository,
    meter,
    value: { input: candidate, plan, nextDocumentIndex: null },
  };
}
async function purchase() {
  return db
    .prepare(
      "SELECT payment_state,version FROM purchases WHERE user_id=? AND id='existing'",
    )
    .bind(owner)
    .first();
}
async function job() {
  return db
    .prepare("SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?")
    .bind(owner, lease().jobId)
    .first();
}
it("FX-05/T12: actual pipeline financial projection and SQL changes() completion survive revision triggers within40 statements", async () => {
  const { repository, meter, value } = await operation();
  const before = await stamp();
  expect(await repository.commit(lease(), value)).toBe("committed");
  expect(await purchase()).toEqual({ payment_state: "paid", version: 2 });
  expect(await job()).toEqual({
    status: "completed",
    outcome_code: "ledger_committed",
  });
  expect(await count("observations")).toBe(1);
  expect(await count("purchase_evidence")).toBe(1);
  expect(await count("ledger_entries")).toBe(1);
  expect(await stamp()).not.toBe(before);
  const committedStamp = await stamp();
  expect(await repository.commit(lease(), value)).toBe("stale");
  expect(await stamp()).toBe(committedStamp);
  expect(await count("ledger_entries")).toBe(1);
  expect(await purchase()).toEqual({ payment_state: "paid", version: 2 });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("FX-05/T12: stale purchase CAS cannot manufacture a completion marker or financial prefix", async () => {
  const { repository, meter, value } = await operation();
  await db
    .prepare("UPDATE purchases SET version=2 WHERE user_id=? AND id='existing'")
    .bind(owner)
    .run();
  const before = await stamp();
  await expect(repository.commit(lease(), value)).rejects.toThrow(
    "PIPELINE_CONFLICT",
  );
  expect(await stamp()).toBe(before);
  expect(await purchase()).toEqual({ payment_state: "unpaid", version: 2 });
  expect(await job()).toEqual({ status: "leased", outcome_code: null });
  expect(await count("observations")).toBe(0);
  expect(await count("purchase_evidence")).toBe(0);
  expect(await count("ledger_entries")).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("FX-05/T12: native pipeline abort rolls back observation/evidence/revision prefixes and completion", async () => {
  const { repository, meter, value } = await operation();
  const before = await stamp();
  await db
    .prepare(
      "CREATE TRIGGER qa_revision_pipeline_abort AFTER INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT,'qa_revision_pipeline_abort'); END;",
    )
    .run();
  await expect(repository.commit(lease(), value)).rejects.toThrow();
  expect(await stamp()).toBe(before);
  expect(await purchase()).toEqual({ payment_state: "unpaid", version: 1 });
  expect(await job()).toEqual({ status: "leased", outcome_code: null });
  expect(await count("observations")).toBe(0);
  expect(await count("purchase_evidence")).toBe(0);
  expect(await count("ledger_entries")).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("FX-01/05: public quote snapshot rejects changed provenance and rate while accepting a no-op", async () => {
  const id = fixtureNumber.toString(16).padStart(64, "0");
  await db
    .prepare(
      "INSERT INTO fx_rates(id,source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version) VALUES(?,'synthetic-reference','EUR','USD','2026-10-12','2026-10-12','1.5',0,'v1')",
    )
    .bind(id)
    .run();
  const quote = () =>
    db.prepare("SELECT * FROM fx_rates WHERE id=?").bind(id).first();
  const before = await quote();
  const revisionBefore = await stamp();
  for (const assignment of [
    "rate='2'",
    "source='changed'",
    "source_version='v2'",
    "retrieved_at=1",
    "effective_date='2026-10-11'",
  ])
    await expect(
      db
        .prepare(`UPDATE OR IGNORE fx_rates SET ${assignment} WHERE id=?`)
        .bind(id)
        .run(),
    ).rejects.toThrow("IMMUTABLE_FX_RATE");
  await db
    .prepare(
      "UPDATE fx_rates SET rate=rate,source=source,source_version=source_version,retrieved_at=retrieved_at,effective_date=effective_date WHERE id=?",
    )
    .bind(id)
    .run();
  expect(await quote()).toEqual(before);
  expect(await stamp()).toBe(revisionBefore);
});
