import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import {
  createFxPeriodService,
  type FxPeriodResult,
} from "../../../packages/adapters/src/fx/period";
import { createInvocationDatabase } from "../src/invocation-database";

const policy = { source: "synthetic-reference", maxPriorAgeDays: 2 };
let context: TenantContext;
let fixture = 0;
const signing = {
  async sign(payload: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("synthetic-period-signing-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );
    return (
      btoa(payload) +
      "." +
      Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
    );
  },
  async verify(token: string) {
    try {
      const payload = atob(token.split(".")[0] ?? "");
      return (await this.sign(payload)) === token ? payload : null;
    } catch {
      return null;
    }
  },
};
async function run(sql: string, ...values: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...values)
    .run();
}
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((v) => v.trim())) await run(sql);
  for (const sql of revision.match(
    /ALTER TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g,
  ) ?? [])
    await run(sql);
});
beforeEach(async () => {
  context = {
    userId: `period-${++fixture}`,
    authority: "job",
  } as TenantContext;
  await run(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    context.userId,
    `${context.userId}@example.invalid`,
  );
  await run(
    "INSERT INTO profiles(user_id,reporting_currency,created_at,updated_at) VALUES(?,'USD',0,0)",
    context.userId,
  );
  await run(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,payment_state) VALUES('p',?,'Synthetic','synthetic','2026-01-01','paid')",
    context.userId,
  );
  await run(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2205) INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) SELECT printf('%05d',i),?,'p',printf('%05d',i),'payment',9000000000000,CASE WHEN i<=1102 THEN 'USD' ELSE 'EUR' END,'2026-01-01','user-confirmed-date',1,'user-confirmed' FROM n",
    context.userId,
  );
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([policy.source, 2, "fx-v1"])),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await run(
    "INSERT INTO entry_valuations(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash,policy_source,max_prior_age_days,original_kind,original_minor,original_currency,original_event_date,status,signed_minor,basis,reason,rate_id,version,updated_at) SELECT user_id,id,'USD',1,1,'fx-v1',?,'synthetic-reference',2,kind,amount_minor,currency,event_date,CASE WHEN currency='USD' THEN 'converted' ELSE 'unconverted' END,CASE WHEN currency='USD' THEN CAST(amount_minor AS TEXT) END,CASE WHEN currency='USD' THEN 'identity' END,CASE WHEN currency='EUR' THEN 'rate_missing' END,NULL,1,0 FROM ledger_entries WHERE user_id=? AND (id<='01102' OR id>'01652')",
    hash,
    context.userId,
  );
});
async function read(
  continuation?: string,
  stamp?: string,
  actorKey = "session-a",
) {
  const budget = createInvocationDatabase(env.DB, 40);
  for (let i = 0; i < 5; i++) await budget.db.prepare("SELECT 1").first();
  const result = await createFxPeriodService(budget.db, {
    policy,
    signing,
    remainingStatements: budget.remainingStatements,
    clock: () => 1000,
  }).read(context, {
    filters: { from: "2026-01-01", to: "2026-12-31" },
    actorKey,
    ...(continuation ? { continuation } : {}),
    ...(stamp ? { stamp } : {}),
  });
  expect(budget.executedStatements()).toBeLessThanOrEqual(40);
  return result;
}
it("FX-03/05 traverses more than 1000 entries with exact full-period mixed coverage and bounded continuation", async () => {
  let result: FxPeriodResult = await read();
  expect(result.status).toBe("in_progress");
  let steps = 1;
  while (result.status === "in_progress" && steps < 20) {
    result = await read(result.continuation, result.stamp);
    steps++;
  }
  expect(result).toMatchObject({
    status: "complete",
    summaryScope: "period",
    reportingCurrency: "USD",
    summary: {
      paidMinor: "9918000000000000",
      refundedMinor: "0",
      netMinor: "9918000000000000",
      convertedCount: "1102",
      pendingCount: "550",
      unconvertedCount: "553",
      reasons: { rate_missing: "553" },
    },
  });
  expect(steps).toBeGreaterThan(1);
});
it("FX-05 rejects a continuation after a same-timestamp earlier-entry mutation", async () => {
  const first = await read();
  expect(first.status).toBe("in_progress");
  if (first.status !== "in_progress") throw new Error("EXPECTED_CONTINUATION");
  await run(
    "UPDATE ledger_entries SET eligible=0 WHERE user_id=? AND id='00001'",
    context.userId,
  );
  expect(await read(first.continuation, first.stamp)).toEqual({
    status: "stale",
  });
});
it("FX-05 signed financial continuation cannot cross sessions or accept altered totals", async () => {
  const first = await read();
  if (first.status !== "in_progress") throw new Error("EXPECTED_CONTINUATION");
  await expect(
    read(first.continuation, first.stamp, "session-b"),
  ).rejects.toThrow("INVALID_FX_INPUT");
  await expect(
    read(first.continuation.replace(/.$/, "x"), first.stamp),
  ).rejects.toThrow("INVALID_FX_INPUT");
});

it("FX-05 rejects a valid signature bound to another tenant or changed filters", async () => {
  const first = await read();
  if (first.status !== "in_progress") throw new Error("EXPECTED_CONTINUATION");
  const budget = createInvocationDatabase(env.DB, 40);
  const service = createFxPeriodService(budget.db, {
    policy,
    signing,
    remainingStatements: budget.remainingStatements,
    clock: () => 1000,
  });
  await expect(
    service.read(
      { ...context, userId: "other-tenant" },
      {
        filters: { from: "2026-01-01", to: "2026-12-31" },
        actorKey: "session-a",
        stamp: first.stamp,
        continuation: first.continuation,
      },
    ),
  ).rejects.toThrow("INVALID_FX_INPUT");
  await expect(
    service.read(context, {
      filters: { from: "2026-02-01", to: "2026-12-31" },
      actorKey: "session-a",
      stamp: first.stamp,
      continuation: first.continuation,
    }),
  ).rejects.toThrow("INVALID_FX_INPUT");
});

it("FX-01/05 shares purchase selection and never includes orphan or merged events", async () => {
  await run(
    "UPDATE purchases SET record_status='merged' WHERE user_id=?",
    context.userId,
  );
  await run(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('mail',?,'mailbox','gmail','synthetic','synthetic@example.invalid')",
    context.userId,
  );
  await run(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic',0,1)",
    context.userId,
  );
  await run(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body','synthetic','text/plain',1)",
    context.userId,
  );
  await run(
    "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs',?,'doc',0,'synthetic',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    context.userId,
  );
  await run(
    "INSERT INTO ledger_entries(id,user_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('orphan',?,'obs','orphan','payment',7,'USD','2026-01-01','user-confirmed-date',1,'source')",
    context.userId,
  );
  expect(await read()).toMatchObject({
    status: "complete",
    summary: {
      paidMinor: "0",
      refundedMinor: "0",
      netMinor: "0",
      convertedCount: "0",
      pendingCount: "0",
      unconvertedCount: "0",
    },
  });
});
