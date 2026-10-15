import { env } from "cloudflare:workers";
import {
  createDocumentTextExtractor,
  createJobEngine,
  type JobLease,
  type TenantContext,
} from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { aiConfiguration } from "../../../packages/adapters/src/ai/configuration";
import { createAiProviderFactory } from "../../../packages/adapters/src/ai/provider-factory";
import { createDiscoveryService } from "../../../packages/adapters/src/discovery/service";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { gmailConfiguration } from "../../../packages/adapters/src/mailbox/configuration";
import { createOnboardingReads } from "../../../packages/adapters/src/onboarding/read";
import { readOnboardingView } from "../../../packages/adapters/src/onboarding/view";
import { createGmailContentFactory } from "../../../packages/adapters/src/pipeline/gmail-factory";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import { planLedgerIngestion } from "../../../packages/core/src/ledger/plan";
import { createInvocationDatabase } from "../src/invocation-database";
import { syntheticClassificationBindings } from "./classification-fixture";

const db = env.DB;

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.prepare("DROP TRIGGER IF EXISTS qa_abort_ledger").run();
  await db.prepare('DELETE FROM "user" WHERE id LIKE ?').bind("qa-%").run();
});
const keyring = {
  activeVersion: 1,
  keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
};
const policy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 1,
  globalConcurrency: 2,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 1000,
};
const budget = {
  dailyDocuments: 100,
  monthlyDocuments: 100,
  dailyUnits: 1000000,
  monthlyUnits: 1000000,
  globalDailyUsdMicros: "1000000",
  globalMonthlyUsdMicros: "1000000",
};
const destination = {
  id: "qa-inference",
  endpoint: "https://model.example.invalid/v1/chat/completions",
  configVersion: "qa-v1",
  policyVersion: 1,
  noticeRefs: ["synthetic-no-live-policy"],
  timeoutMs: 1000,
  maxInputBytes: 24000,
  maxOutputBytes: 64000,
  maxOutputTokens: 1000,
  models: [
    {
      id: "qa-model",
      capabilities: {
        jsonSchema: false,
        jsonObject: true,
        outputLimit: "max_tokens",
        usage: true,
        idempotency: false,
      },
      pricing: {
        version: "qa-v1",
        approved: true,
        currency: "USD",
        source: "https://prices.example.invalid/synthetic",
        checkedAt: "2026-10-12T00:00:00Z",
        inputUsdMicrosPerMillion: "100",
        outputUsdMicrosPerMillion: "200",
        otherUsdMicrosPerMillion: "200",
      },
    },
  ],
};
function configuration() {
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-qa-secret-never-production-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: '["qa@example.invalid"]',
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "synthetic",
    GMAIL_CLIENT_SECRET: "synthetic",
    CREDENTIAL_KEYRING: JSON.stringify(keyring),
    AI_ENABLED: "true",
    AI_REGISTRY_JSON: JSON.stringify([destination]),
    AI_BUDGET_JSON: JSON.stringify(budget),
    AI_HOSTED_DESTINATION: destination.id,
    AI_HOSTED_MODEL: "qa-model",
    AI_HOSTED_KEY: "synthetic-hosted-key",
  };
  const mail = gmailConfiguration(bindings),
    inference = aiConfiguration({
      ...syntheticClassificationBindings,
      ...bindings,
    });
  if (!mail || !inference)
    throw new Error("Invalid positive-control configuration");
  return { mail, inference };
}
async function seed(name: string) {
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(name, name, `${name}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(name)
    .run();
  const ciphertext = await createCredentialCipher(keyring).seal(
    { userId: name, authority: "job" } as TenantContext,
    { entityId: `c-${name}`, purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3600000,
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,scopes,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'mailbox','gmail',?,?,'active',?,?,1,1)",
    )
    .bind(
      `c-${name}`,
      name,
      name,
      `${name}-mail@example.invalid`,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      ciphertext,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','qa-inference','qa-model','qa-v1',1,1)",
    )
    .bind(name)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,?,1,'qa-inference','local',1,0,1,?)",
    )
    .bind(`pc-${name}`, name, `c-${name}`, "f".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,'message',0,1)",
    )
    .bind(`s-${name}`, name, `c-${name}`)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
    )
    .bind(`j-${name}`, name, `c-${name}`, `pc-${name}`, `j-${name}`)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
    )
    .bind(name, `j-${name}`, `s-${name}`)
    .run();
  return name;
}
function text(ref: string) {
  return `QA Shop\n2026-10-01\nEUR 10.00\nPaid by card.\nOrder ORDER-${ref}\nPayment reference: PAY-${ref}\n`;
}
function extracted(ref: string) {
  return {
    merchant: "QA Shop",
    documentDate: "2026-10-01",
    eventDate: "2026-10-01",
    currency: "EUR",
    total: "10.00",
    tax: null,
    invoiceNumber: null,
    orderReference: `ORDER-${ref}`,
    paymentReference: `PAY-${ref}`,
    refundReference: null,
    category: "shopping",
    paymentEvidence: "explicitly-paid",
    refundEvidence: "none",
    paymentMethodHint: "card",
    recurringCadence: "unknown",
    paymentAmount: "10.00",
    refundAmount: null,
    storeCreditAmount: null,
    evidence: [
      ["merchant", "QA Shop"],
      ["eventDate", "2026-10-01"],
      ["documentDate", "2026-10-01"],
      ["currency", "EUR"],
      ["total", "10.00"],
      ["paymentAmount", "10.00"],
      ["payment", "Paid by card."],
      ["orderReference", `ORDER-${ref}`],
      ["paymentReference", `Payment reference: PAY-${ref}`],
    ].map(([field, quote]) => ({ field, inputPartId: "part-0", quote })),
  };
}
function network(
  multiple: boolean,
  afterModel?: () => Promise<void>,
  expectedKey = "synthetic-hosted-key",
  scenario: {
    firstFailure?: "refusal" | "timeout";
    unsupported?: "application/zip" | "image/gif";
    legacyTotal?: "100.00" | "120.00";
    settlement?: "credit-only" | "mixed";
    rawBodySentinel?: string;
    quoteSentinel?: string;
    transcriptSentinel?: string;
  } = {},
) {
  let modelCalls = 0,
    mailCalls = 0;
  const mailAuthorizations: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = String(request);
    expect(init?.redirect).toBe("manual");
    if (
      url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/")
    ) {
      mailCalls++;
      mailAuthorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      const bodies = scenario.firstFailure
        ? [text("A"), text("B")]
        : scenario.unsupported
          ? [text("A"), "synthetic unsupported bytes"]
          : multiple
            ? [text("A") + text("B"), text("C")]
            : [
                scenario.settlement
                  ? `QA Shop\n2026-10-01\nTotal EUR 100.00\nPaid ${scenario.settlement === "mixed" ? "by card EUR 70.00" : "EUR 0.00 by store credit"}\nRedeemed store credit EUR ${scenario.settlement === "mixed" ? "30.00" : "100.00"}\nOrder ORDER-A\nPayment reference: PAY-A\n`
                  : scenario.legacyTotal
                    ? text("A").replaceAll("10.00", scenario.legacyTotal) +
                      "Invoice I1\n"
                    : text("A"),
              ];
      const transientBodies = bodies.map((body) => {
        const withQuote = scenario.quoteSentinel
          ? body.replace(
              "Paid by card.",
              `Paid by card. ${scenario.quoteSentinel}`,
            )
          : body;
        return scenario.rawBodySentinel
          ? `${withQuote}\n${scenario.rawBodySentinel}\n`
          : withQuote;
      });
      return Response.json({
        id: "message",
        payload: {
          partId: "root",
          mimeType: "multipart/mixed",
          parts: transientBodies.map((body, index) => ({
            partId: `doc-${index}`,
            mimeType:
              index && scenario.unsupported
                ? scenario.unsupported
                : "text/plain",
            ...(index
              ? {
                  filename: "second.txt",
                  headers: [
                    { name: "Content-Disposition", value: "attachment" },
                  ],
                }
              : {}),
            body: {
              size: new TextEncoder().encode(body).length,
              data: encodeBase64url(new TextEncoder().encode(body)),
            },
          })),
        },
      });
    }
    expect(url).toBe(destination.endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${expectedKey}`,
    );
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("tools");
    const content = String(body.messages[1].content);
    if (scenario.rawBodySentinel)
      expect(content).toContain(scenario.rawBodySentinel);
    const refs = ["A", "B", "C"].filter((ref) =>
      content.includes(`PAY-${ref}`),
    );
    if (afterModel) await afterModel();
    if (scenario.firstFailure && refs.includes("A")) {
      if (scenario.firstFailure === "timeout")
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("synthetic timeout", "AbortError")),
            { once: true },
          );
        });
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "content_filter",
            message: {
              role: "assistant",
              content: null,
              refusal: "synthetic refusal",
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
      });
    }
    return Response.json({
      ...(scenario.transcriptSentinel
        ? { id: scenario.transcriptSentinel }
        : {}),
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              schemaVersion: 1,
              documentType: "receipt",
              records: refs.map((ref) => {
                const record = extracted(ref);
                if (scenario.quoteSentinel)
                  record.evidence = record.evidence.map((item) =>
                    item.field === "payment"
                      ? {
                          ...item,
                          quote: `Paid by card. ${scenario.quoteSentinel}`,
                        }
                      : item,
                  );
                if (scenario.settlement) {
                  const mixed = scenario.settlement === "mixed";
                  return {
                    ...record,
                    total: "100.00",
                    paymentAmount: mixed ? "70.00" : "0.00",
                    storeCreditAmount: mixed ? "30.00" : "100.00",
                    paymentMethodHint: mixed ? "card" : "store-credit",
                    evidence: [
                      ...record.evidence.filter(
                        (item) =>
                          !["total", "payment", "paymentAmount"].includes(
                            String(item.field),
                          ),
                      ),
                      {
                        field: "total",
                        inputPartId: "part-0",
                        quote: "Total EUR 100.00",
                      },
                      {
                        field: "payment",
                        inputPartId: "part-0",
                        quote: mixed
                          ? "Paid by card EUR 70.00"
                          : "Paid EUR 0.00 by store credit",
                      },
                      {
                        field: "paymentAmount",
                        inputPartId: "part-0",
                        quote: mixed ? "70.00" : "0.00",
                      },
                      {
                        field: "storeCreditAmount",
                        inputPartId: "part-0",
                        quote: mixed
                          ? "Redeemed store credit EUR 30.00"
                          : "Redeemed store credit EUR 100.00",
                      },
                    ],
                  };
                }
                return scenario.legacyTotal
                  ? {
                      ...record,
                      invoiceNumber: "I1",
                      total: scenario.legacyTotal,
                      paymentAmount: scenario.legacyTotal,
                      evidence: [
                        ...record.evidence.map((item) => ({
                          ...item,
                          quote:
                            item.quote === "10.00"
                              ? scenario.legacyTotal
                              : item.quote,
                        })),
                        {
                          field: "invoiceNumber",
                          inputPartId: "part-0",
                          quote: "Invoice I1",
                        },
                      ],
                    }
                  : record;
              }),
              warnings: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  });
  return {
    modelCalls: () => modelCalls,
    mailCalls: () => mailCalls,
    mailAuthorizations: () => [...mailAuthorizations],
  };
}
async function invocation(jobId: string, beforeCommit?: () => Promise<void>) {
  const meter = createInvocationDatabase(env.DB, 40),
    store = createJobStore(meter.db, { policy });
  const lease = await store.claim(jobId);
  expect(lease).not.toBeNull();
  if (!lease) throw new Error("Positive-control claim failed");
  const config = configuration(),
    provider = createAiProviderFactory(meter.db, config.inference);
  const nativeRepository = createPipelineRepository(meter.db, {
    processingDigest: async () => "f".repeat(64),
  });
  const errors: string[] = [];
  const repository = {
    ...nativeRepository,
    async commit(...args: Parameters<typeof nativeRepository.commit>) {
      if (beforeCommit) {
        expect(args[1].plan.expectedPurchases).toHaveLength(1);
        await beforeCommit();
      }
      return nativeRepository.commit(...args);
    },
    async stageDocuments(
      ...args: Parameters<typeof nativeRepository.stageDocuments>
    ) {
      try {
        return await nativeRepository.stageDocuments(...args);
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : "Unknown stage error",
        );
        throw error;
      }
    },
  };
  const service = createPipelineService(meter.db, {
    repository,
    content: createGmailContentFactory(meter.db, config.mail),
    documents: createDocumentTextExtractor(),
    inference: {
      open: (current, work, parts) =>
        provider.open(current.context, {
          consentId: current.consentId,
          settingsRevision: work.settingsRevision,
          parts,
          maxAttempts: 1,
        }),
    },
    budget,
    remainingStatements: meter.remainingStatements,
  });
  const outcome = await service.run(lease, {
    signal: new AbortController().signal,
    checkpoint: () => store.checkpoint(lease),
  });
  if (!(await store.isSettled(jobId))) await store.finish(lease, outcome);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return { outcome, count: meter.executedStatements(), lease, errors };
}
async function drive(name: string) {
  const counts: number[] = [];
  for (let steps = 0; steps < 10; steps++) {
    const id = await db
      .prepare(
        "SELECT id FROM jobs WHERE user_id=? AND status='ready' ORDER BY rowid LIMIT 1",
      )
      .bind(name)
      .first<string>("id");
    if (!id) return counts;
    const result = await invocation(id);
    counts.push(result.count);
    expect(result.outcome, JSON.stringify(result)).toEqual({
      kind: "completed",
    });
  }
  throw new Error("Pipeline exceeded bounded stage count");
}
async function count(
  name: string,
  table:
    | "documents"
    | "observations"
    | "purchases"
    | "ledger_entries"
    | "review_items",
) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`)
    .bind(name)
    .first<number>("n");
}

it("T12 native full pipeline counts multiple MIME documents and records under one shared40 counter per invocation", async () => {
  const name = await seed("qa-full"),
    calls = network(true),
    counts = await drive(name);
  console.info("T12 hosted multi-document invocation statements", counts);
  expect(counts).toHaveLength(5);
  expect(calls.modelCalls()).toBe(2);
  expect(await count(name, "documents")).toBe(2);
  expect(await count(name, "observations")).toBe(3);
  expect(await count(name, "purchases")).toBe(3);
  expect(await count(name, "ledger_entries")).toBe(3);
  expect(
    await db
      .prepare(
        "SELECT CAST(SUM(amount_minor) AS TEXT) AS total FROM ledger_entries WHERE user_id=? AND kind='payment'",
      )
      .bind(name)
      .first("total"),
  ).toBe("3000");
  const persisted = JSON.stringify(
    (
      await db
        .prepare(
          "SELECT normalized_fields,structured_fields FROM observations WHERE user_id=?",
        )
        .bind(name)
        .all()
    ).results,
  );
  expect(persisted).not.toContain('"quote"');
  expect(persisted).not.toContain("Paid by card.");
  expect(await createJobStore(db, { policy }).claim(`j-${name}`)).toBeNull();
  expect(calls.modelCalls()).toBe(2);
});
it("LEDGER-08 identical source content stays tenant-owned through the real pipeline", async () => {
  const first = await seed("qa-tenant-a"),
    second = await seed("qa-tenant-b"),
    calls = network(false);
  await drive(first);
  await drive(second);
  expect(calls.modelCalls()).toBe(2);
  for (const name of [first, second]) {
    expect(await count(name, "observations")).toBe(1);
    expect(await count(name, "ledger_entries")).toBe(1);
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
async function prepared(name: string) {
  await seed(name);
  network(false);
  await invocation(`j-${name}`);
  const inferJob = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
    .bind(name)
    .first<string>("id");
  if (!inferJob) throw new Error("Missing infer continuation");
  expect((await invocation(inferJob)).outcome).toEqual({ kind: "completed" });
  const commitJob = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
    .bind(name)
    .first<string>("id");
  if (!commitJob) throw new Error("Missing reconcile continuation");
  const meter = createInvocationDatabase(env.DB, 40),
    store = createJobStore(meter.db, { policy });
  const lease = await store.claim(commitJob);
  if (!lease) throw new Error("Missing reconcile lease");
  const repository = createPipelineRepository(meter.db, {
      processingDigest: async () => "f".repeat(64),
    }),
    work = await repository.load(lease);
  const document = work?.documents[0];
  if (!document || !work?.extractionFingerprint)
    throw new Error("Missing cached identity");
  const result = await repository.cachedResult(
    lease,
    document.id,
    work.extractionFingerprint,
  );
  if (!result) throw new Error("Missing cached validated result");
  const input = {
    identity: {
      documentId: document.id,
      contentHash: document.contentHash,
      extractionFingerprint: work.extractionFingerprint,
    },
    result,
  };
  const snapshot = await repository.loadSnapshot(lease, input);
  if (!snapshot) throw new Error("Missing positive-control snapshot");
  const commit = {
    input,
    plan: planLedgerIngestion(input, snapshot),
    nextDocumentIndex: null,
  };
  expect(commit.plan.events).toHaveLength(1);
  return { meter, store, lease, repository, commit };
}
it.each([
  ["expired", "UPDATE jobs SET lease_expires_at=0 WHERE user_id=?"],
  [
    "generation",
    "UPDATE connections SET generation=generation+1 WHERE user_id=?",
  ],
  ["consent", "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?"],
  ["settings", "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?"],
  ["deleting", "UPDATE profiles SET status='deleting' WHERE user_id=?"],
  [
    "source-unavailable",
    "UPDATE source_messages SET available=0 WHERE user_id=?",
  ],
] as const)(
  "T12 late %s fence prevents every financial write and job completion",
  async (reason, sql) => {
    const name = `qa-fence-${reason}`,
      test = await prepared(name);
    await db.prepare(sql).bind(name).run();
    expect(await test.repository.commit(test.lease, test.commit)).toBe("stale");
    expect(await count(name, "observations")).toBe(0);
    expect(await count(name, "purchases")).toBe(0);
    expect(await count(name, "ledger_entries")).toBe(0);
    expect(
      await db
        .prepare("SELECT status FROM jobs WHERE id=?")
        .bind(test.lease.jobId)
        .first("status"),
    ).toBe("leased");
  },
);
it("T12 old lease cannot commit after reassignment; the fresh owner can", async () => {
  const name = "qa-reassign",
    test = await prepared(name);
  await db
    .prepare("UPDATE jobs SET lease_expires_at=0 WHERE id=?")
    .bind(test.lease.jobId)
    .run();
  const replacement: JobLease | null = await createJobStore(db, {
    policy,
  }).claim(test.lease.jobId);
  if (!replacement) throw new Error("Missing replacement positive control");
  expect(replacement.fence).toBeGreaterThan(test.lease.fence);
  expect(await test.repository.commit(test.lease, test.commit)).toBe("stale");
  expect(await count(name, "ledger_entries")).toBe(0);
  expect(await test.repository.commit(replacement, test.commit)).toBe(
    "committed",
  );
  expect(await count(name, "ledger_entries")).toBe(1);
});
it("T12 native late constraint failure rolls back observations, purchases, ledger and completion; retry succeeds", async () => {
  const name = "qa-rollback",
    test = await prepared(name);
  await db
    .prepare(
      "CREATE TRIGGER qa_abort_ledger BEFORE INSERT ON ledger_entries WHEN NEW.user_id='qa-rollback' BEGIN SELECT RAISE(ABORT,'qa synthetic ledger constraint'); END",
    )
    .run();
  await expect(
    test.repository.commit(test.lease, test.commit),
  ).rejects.toThrow();
  for (const table of [
    "observations",
    "purchases",
    "ledger_entries",
    "review_items",
  ] as const)
    expect(await count(name, table)).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(test.lease.jobId)
      .first("status"),
  ).toBe("leased");
  await db.prepare("DROP TRIGGER qa_abort_ledger").run();
  expect(await test.repository.commit(test.lease, test.commit)).toBe(
    "committed",
  );
  expect(await count(name, "ledger_entries")).toBe(1);
  expect(await test.repository.commit(test.lease, test.commit)).toBe("stale");
  expect(await count(name, "ledger_entries")).toBe(1);
});
it("T12 trusted tenant mismatch cannot load or commit another workspace's prepared source", async () => {
  const test = await prepared("qa-forged-a");
  await seed("qa-forged-b");
  const forged: JobLease = {
    ...test.lease,
    context: { userId: "qa-forged-b", authority: "job" } as TenantContext,
  };
  expect(await test.repository.load(forged)).toBeNull();
  expect(
    await test.repository.loadSnapshot(forged, test.commit.input),
  ).toBeNull();
  expect(await test.repository.commit(forged, test.commit)).toBe("stale");
  expect(await count("qa-forged-a", "ledger_entries")).toBe(0);
  expect(await count("qa-forged-b", "ledger_entries")).toBe(0);
  expect(await test.repository.commit(test.lease, test.commit)).toBe(
    "committed",
  );
  expect(await count("qa-forged-a", "ledger_entries")).toBe(1);
  expect(await count("qa-forged-b", "ledger_entries")).toBe(0);
});
it("T12 BYOK positive control uses the selected private key through the real factory under shared40", async () => {
  const name = await seed("qa-byok");
  const encrypted = await createCredentialCipher(keyring).seal(
    { userId: name, authority: "job" } as TenantContext,
    { entityId: "primary", purpose: "byok-key" },
    { key: "synthetic-byok-key" },
  );
  await db
    .prepare(
      "UPDATE ai_settings SET mode='byok',encrypted_key=?,key_version=1,credential_version=1 WHERE user_id=?",
    )
    .bind(encrypted, name)
    .run();
  const calls = network(false, undefined, "synthetic-byok-key"),
    counts = await drive(name);
  console.info("T12 BYOK invocation statements", counts);
  expect(counts).toHaveLength(3);
  expect(calls.modelCalls()).toBe(1);
  expect(await count(name, "ledger_entries")).toBe(1);
});
it("T12 consent revoked while inference is in flight rejects the late result and records no financial data", async () => {
  const name = await seed("qa-model-late");
  const calls = network(false, async () => {
    await db
      .prepare("UPDATE processing_consents SET revoked_at=1 WHERE user_id=?")
      .bind(name)
      .run();
  });
  expect((await invocation(`j-${name}`)).outcome).toEqual({
    kind: "completed",
  });
  const inferJob = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
    .bind(name)
    .first<string>("id");
  if (!inferJob) throw new Error("Missing inference positive control");
  expect((await invocation(inferJob)).outcome).toEqual({
    kind: "paused",
    code: "auth",
  });
  expect(calls.modelCalls()).toBe(1);
  expect(await count(name, "observations")).toBe(0);
  expect(await count(name, "ledger_entries")).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM ai_extractions WHERE user_id=? AND completed_at IS NOT NULL",
      )
      .bind(name)
      .first("n"),
  ).toBe(0);
});
it.each(["refusal", "timeout"] as const)(
  "T12 document %s preserves operational review and continues the sibling payment",
  async (firstFailure) => {
    const name = await seed(`qa-document-${firstFailure}`);
    const calls = network(false, undefined, "synthetic-hosted-key", {
      firstFailure,
    });
    const counts = await drive(name);
    console.info(`T12 ${firstFailure} sibling invocation statements`, counts);
    expect(calls.modelCalls()).toBe(2);
    expect(await count(name, "documents")).toBe(2);
    expect(await count(name, "ledger_entries")).toBe(1);
    expect(
      await db
        .prepare("SELECT amount_minor FROM ledger_entries WHERE user_id=?")
        .bind(name)
        .first("amount_minor"),
    ).toBe(1000);
    expect(
      await db
        .prepare(
          "SELECT processing_status FROM source_messages WHERE user_id=?",
        )
        .bind(name)
        .first("processing_status"),
    ).toBe("review");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM review_items WHERE user_id=? AND blocking_scope='operational' AND status='open'",
        )
        .bind(name)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT parse_code FROM documents WHERE user_id=? AND part_key='doc-0'",
        )
        .bind(name)
        .first("parse_code"),
    ).toBe(firstFailure);
    if (firstFailure === "timeout") {
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND state='uncertain'",
          )
          .bind(name)
          .first("n"),
      ).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM usage_buckets WHERE user_id=? AND reserved_units>0",
          )
          .bind(name)
          .first("n"),
      ).toBeGreaterThan(0);
    }
  },
);
it.each(["application/zip", "image/gif"] as const)(
  "T12 unsupported %s sibling retains metadata and operational review without blocking the valid receipt",
  async (unsupported) => {
    const name = await seed(
      `qa-unsupported-${unsupported === "image/gif" ? "gif" : "zip"}`,
    );
    const calls = network(false, undefined, "synthetic-hosted-key", {
      unsupported,
    });
    await drive(name);
    expect(calls.modelCalls()).toBe(1);
    expect(await count(name, "documents")).toBe(2);
    expect(await count(name, "ledger_entries")).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT mime FROM documents WHERE user_id=? AND part_key='doc-1'",
        )
        .bind(name)
        .first("mime"),
    ).toBe(unsupported);
    expect(
      await db
        .prepare(
          "SELECT processing_status FROM source_messages WHERE user_id=?",
        )
        .bind(name)
        .first("processing_status"),
    ).toBe("review");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM review_items WHERE user_id=? AND blocking_scope='operational' AND status='open'",
        )
        .bind(name)
        .first("n"),
    ).toBe(1);
  },
);
// PIPE-1 pin (owner decision: keep the current flow). Through the real
// pipeline service, an unsupported ZIP sibling of a valid receipt is visited,
// rewritten to needs_review/unsupported_type and given one operational
// document-review item, so both import-progress surfaces report exactly as
// many review sources as there are open review items.
it("PIPE-1 receipt with an unsupported ZIP sibling reports a progress review count equal to its open review items", async () => {
  const name = await seed("qa-pipe1-zip");
  await db
    .prepare(
      "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,stage,started_at) VALUES(?,?,?,?,1,'2025-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','UTC',?,'discovering',0)",
    )
    .bind(`run-${name}`, name, `c-${name}`, `pc-${name}`, `fp-${name}`)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,?,?,'matched')",
    )
    .bind(name, `run-${name}`, `s-${name}`)
    .run();
  network(false, undefined, "synthetic-hosted-key", {
    unsupported: "application/zip",
  });
  await drive(name);

  expect(await count(name, "ledger_entries")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT mime,parse_state,parse_code FROM documents WHERE user_id=? AND part_key='doc-1'",
      )
      .bind(name)
      .first(),
  ).toEqual({
    mime: "application/zip",
    parse_state: "needs_review",
    parse_code: "unsupported_type",
  });
  const openReviews = (
    await db
      .prepare(
        "SELECT r.reason,r.blocking_scope,d.part_key FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=? AND r.status='open'",
      )
      .bind(name)
      .all()
  ).results;
  expect(openReviews).toEqual([
    {
      reason: "document-review",
      blocking_scope: "operational",
      part_key: "doc-1",
    },
  ]);
  expect(
    await db
      .prepare("SELECT processing_status FROM source_messages WHERE user_id=?")
      .bind(name)
      .first("processing_status"),
  ).toBe("review");

  const tenant = { userId: name, authority: "job" } as TenantContext;
  const discovery = createDiscoveryService(db, {
    providers: {
      async open() {
        throw new Error("synthetic progress read must not open a provider");
      },
    },
    readiness: {
      async allow() {
        return true;
      },
    },
    remainingStatements: () => 40,
  });
  const progress = await discovery.progress(tenant, `run-${name}`);
  expect(progress.counts.review).toBe(openReviews.length);
  const view = await readOnboardingView(
    db,
    createOnboardingReads(db, null, Date.now),
    {
      tenant: { userId: name, authority: "session" } as TenantContext,
      sessionId: `session-${name}`,
      loginEmail: `${name}@example.invalid`,
    },
    { ready: false, mailboxLimit: 1, connectionId: `c-${name}` },
  );
  expect(view.progress?.importRunId).toBe(`run-${name}`);
  expect(view.progress?.reviewSources).toBe(openReviews.length);
  expect(view.progress?.reviewItemCount).toBe(openReviews.length);
});
it("T12 live optimistic conflict retries from the cached extraction without another provider call", async () => {
  const name = await seed("qa-version-race"),
    calls = network(false);
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,order_ref,document_date,total_minor,currency,category,payment_state) VALUES(?,?,'QA Shop','qa shop','ORDER-A','2026-10-01',1000,'EUR','shopping','unpaid')",
    )
    .bind(`p-${name}`, name)
    .run();
  expect((await invocation(`j-${name}`)).outcome).toEqual({
    kind: "completed",
  });
  const nextJob = async () => {
    const id = await db
      .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
      .bind(name)
      .first<string>("id");
    if (!id) throw new Error("Missing optimistic-race continuation");
    return id;
  };
  expect((await invocation(await nextJob())).outcome).toEqual({
    kind: "completed",
  });
  const reconcileJob = await nextJob();
  const conflicted = await invocation(reconcileJob, async () => {
    await db
      .prepare("UPDATE purchases SET version=version+1 WHERE user_id=?")
      .bind(name)
      .run();
  });
  expect(conflicted.outcome).toEqual({ kind: "retry", code: "transient" });
  expect(await count(name, "ledger_entries")).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(reconcileJob)
      .first("status"),
  ).toBe("retry_wait");
  await db
    .prepare("UPDATE jobs SET dispatch_at=0 WHERE id=?")
    .bind(reconcileJob)
    .run();
  expect((await invocation(reconcileJob)).outcome).toEqual({
    kind: "completed",
  });
  expect(await count(name, "ledger_entries")).toBe(1);
  expect(calls.modelCalls()).toBe(1);
});
it.each([
  ["120.00", "invoice-conflict"],
  ["100.00", "ambiguous-event"],
] as const)(
  "T12 populated legacy invoice with incoming %s retains original payment and opens %s",
  async (legacyTotal, reason) => {
    const name = await seed(
      `qa-legacy-${legacyTotal === "120.00" ? "corrected" : "cash"}`,
    );
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,parse_state) VALUES(?,?,?,'legacy',?,'text/plain',0,'extracted')",
      )
      .bind(`old-d-${name}`, name, `s-${name}`, "a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,'legacy-v1',1,'explicitly-paid',?,'accepted')",
      )
      .bind(
        `old-o-${name}`,
        name,
        `old-d-${name}`,
        JSON.stringify({
          schemaVersion: 1,
          merchant: "QA Shop",
          date: "2026-10-01",
          totalMinor: "10000",
          currency: "EUR",
        }),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,category,payment_state) VALUES(?,?,'QA Shop','qa shop','I1','ORDER-A','2026-10-01',10000,'EUR','shopping','paid')",
      )
      .bind(`old-p-${name}`, name)
      .run();
    await db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
      )
      .bind(name, `old-p-${name}`, `old-o-${name}`)
      .run();
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,?,?,'legacy-unrecognized-key','payment',10000,'EUR','2026-10-01','document-date',1)",
      )
      .bind(`old-e-${name}`, name, `old-p-${name}`, `old-o-${name}`)
      .run();
    const calls = network(false, undefined, "synthetic-hosted-key", {
      legacyTotal,
    });
    await drive(name);
    expect(calls.modelCalls()).toBe(1);
    expect(await count(name, "ledger_entries")).toBe(1);
    expect(await count(name, "purchases")).toBe(1);
    expect(
      await db
        .prepare("SELECT total_minor FROM purchases WHERE user_id=?")
        .bind(name)
        .first("total_minor"),
    ).toBe(10000);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM review_items WHERE user_id=? AND reason=? AND blocking_scope='financial'",
        )
        .bind(name, reason)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT structured_fields FROM observations WHERE user_id=? AND id=?",
        )
        .bind(name, `old-o-${name}`)
        .first("structured_fields"),
    ).toBeNull();
  },
);
it.each(["credit-only", "mixed"] as const)(
  "LEDGER-09 %s settlement marks the existing unpaid purchase paid without gross-value mutation",
  async (settlement) => {
    const name = await seed(`qa-settlement-${settlement}`);
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,order_ref,document_date,total_minor,currency,category,payment_state) VALUES(?,?,'QA Shop','qa shop','ORDER-A','2026-10-01',10000,'EUR','shopping','unpaid')",
      )
      .bind(`p-${name}`, name)
      .run();
    const calls = network(false, undefined, "synthetic-hosted-key", {
      settlement,
    });
    await drive(name);
    const cached = await db
      .prepare(
        "SELECT result_json FROM ai_extractions WHERE user_id=? AND completed_at IS NOT NULL",
      )
      .bind(name)
      .first<string>("result_json");
    if (!cached)
      throw new Error("Missing settlement extraction positive control");
    expect(JSON.parse(cached).status, cached).toBe("accepted");
    expect(calls.modelCalls()).toBe(1);
    expect(await count(name, "purchases")).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT total_minor,payment_state,version FROM purchases WHERE user_id=?",
        )
        .bind(name)
        .first(),
    ).toEqual({ total_minor: 10000, payment_state: "paid", version: 2 });
    expect(await count(name, "ledger_entries")).toBe(
      settlement === "mixed" ? 1 : 0,
    );
    if (settlement === "mixed")
      expect(
        await db
          .prepare("SELECT amount_minor FROM ledger_entries WHERE user_id=?")
          .bind(name)
          .first("amount_minor"),
      ).toBe(7000);
  },
);

it("GMAIL-06/LEDGER-08/LIFECYCLE-06 two approved Gmail mailboxes share one owned payment while identical other-tenant content and replay remain private", async ({
  annotate,
  task,
}) => {
  const first = await seed("qa-compose-owner"),
    second = await seed("qa-compose-other");
  const secondaryConnection = `c-${first}-secondary`;
  const secondaryAccess = "T16_SECONDARY_ACCESS_SECRET",
    secondaryRefresh = "T16_SECONDARY_REFRESH_SECRET",
    otherAccess = "T16_OTHER_ACCESS_SECRET",
    otherRefresh = "T16_OTHER_REFRESH_SECRET";
  const cipher = createCredentialCipher(keyring);
  const secondaryCiphertext = await cipher.seal(
    { userId: first, authority: "job" } as TenantContext,
    { entityId: secondaryConnection, purpose: "mailbox-credentials" },
    {
      accessToken: secondaryAccess,
      refreshToken: secondaryRefresh,
      expiresAt: Date.now() + 3600000,
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,scopes,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'mailbox','gmail',?,?,'active',?,?,1,1)",
    )
    .bind(
      secondaryConnection,
      first,
      `${first}-secondary`,
      `${first}-secondary@example.invalid`,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      secondaryCiphertext,
    )
    .run();
  const secondaryConsent = `pc-${first}-secondary`,
    secondarySource = `s-${first}-secondary`,
    secondaryJob = `j-${first}-secondary`;
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,?,1,'qa-inference','local',1,0,1,?)",
    )
    .bind(secondaryConsent, first, secondaryConnection, "f".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,'message',0,1)",
    )
    .bind(secondarySource, first, secondaryConnection)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
    )
    .bind(
      secondaryJob,
      first,
      secondaryConnection,
      secondaryConsent,
      secondaryJob,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
    )
    .bind(first, secondaryJob, secondarySource)
    .run();
  const otherCiphertext = await cipher.seal(
    { userId: second, authority: "job" } as TenantContext,
    { entityId: `c-${second}`, purpose: "mailbox-credentials" },
    {
      accessToken: otherAccess,
      refreshToken: otherRefresh,
      expiresAt: Date.now() + 3600000,
    },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=? WHERE user_id=? AND id=?",
    )
    .bind(otherCiphertext, second, `c-${second}`)
    .run();

  // These approved sources are already discovered; the next unrelated mailbox sync is later.
  await db
    .prepare("UPDATE connections SET next_sync_at=? WHERE user_id IN(?,?)")
    .bind(Date.now() + 3600000, first, second)
    .run();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM connections WHERE user_id=? AND provider='gmail' AND state='connected' AND scheduling_state='active'",
      )
      .bind(first)
      .first("n"),
  ).toBe(2);

  const rawBody = "COMPOSITION_PRIVATE_BODY_ALPHA",
    rawQuote = "COMPOSITION_PRIVATE_QUOTED_ALPHA",
    rawTranscript = "COMPOSITION_PRIVATE_MODEL_WRAPPER_ALPHA";
  const calls = network(false, undefined, "synthetic-hosted-key", {
    rawBodySentinel: rawBody,
    quoteSentinel: rawQuote,
    transcriptSentinel: rawTranscript,
  });
  const logs: unknown[][] = [];
  const logObservers = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      }),
  );
  const queued: { schemaVersion: 1; jobId: string }[] = [];
  const statementCounts: {
    stage:
      | "dispatch"
      | "pipeline"
      | "redelivery"
      | "enqueue"
      | "retention-sweep";
    count: number;
  }[] = [];
  async function processQueuedSources() {
    const leases: JobLease[] = [];
    for (let step = 0; step < 20; step++) {
      const ready = await db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE user_id IN(?,?) AND status='ready'",
        )
        .bind(first, second)
        .first<number>("n");
      if (!ready) return leases;
      const meter = createInvocationDatabase(env.DB, 40),
        sent: { schemaVersion: 1; jobId: string }[] = [];
      const engine = createJobEngine({
        store: createJobStore(meter.db, { policy }),
        queue: {
          send: async (body) => {
            sent.push({ ...body });
            queued.push({ ...body });
          },
        },
      });
      const dispatched = await engine.dispatch();
      expect(dispatched.sent).toBeLessThanOrEqual(1);
      expect(sent).toHaveLength(dispatched.sent);
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
      statementCounts.push({
        stage: "dispatch",
        count: meter.executedStatements(),
      });
      const message = sent[0];
      // Fair cursor rollover may consume one bounded dispatch without sending.
      if (!message) continue;
      expect(Object.keys(message).sort()).toEqual(["jobId", "schemaVersion"]);
      expect(
        await db
          .prepare("SELECT user_id FROM jobs WHERE id=?")
          .bind(message.jobId)
          .first("user_id"),
      ).toMatch(/^(qa-compose-owner|qa-compose-other)$/);
      expect(
        await db
          .prepare("SELECT type FROM jobs WHERE id=?")
          .bind(message.jobId)
          .first("type"),
      ).toBe("source-extract");
      const result = await invocation(message.jobId);
      expect(result.lease.type).toBe("source-extract");
      expect(result.outcome).toEqual({ kind: "completed" });
      statementCounts.push({ stage: "pipeline", count: result.count });
      leases.push(result.lease);
    }
    throw new Error("Composition exceeded bounded processing invocations");
  }
  const leases = await processQueuedSources();
  expect(calls.mailAuthorizations()).toEqual(
    expect.arrayContaining([
      "Bearer synthetic-access",
      `Bearer ${secondaryAccess}`,
      `Bearer ${otherAccess}`,
    ]),
  );
  expect(calls.modelCalls()).toBeGreaterThanOrEqual(2);
  for (const owner of [first, second]) {
    const extractionCodes = (
      await db
        .prepare(
          "SELECT json_extract(result_json,'$.status') status,json_extract(result_json,'$.reason') reason FROM ai_extractions WHERE user_id=? ORDER BY document_id",
        )
        .bind(owner)
        .all()
    ).results;
    expect(
      await count(owner, "purchases"),
      JSON.stringify(extractionCodes),
    ).toBe(1);
    expect(await count(owner, "ledger_entries")).toBe(1);
    expect(await count(owner, "review_items")).toBe(0);
  }
  const ownedSources = await db
    .prepare(
      "SELECT s.connection_id,d.content_hash,pe.purchase_id FROM source_messages s JOIN documents d ON d.user_id=s.user_id AND d.source_message_id=s.id JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id JOIN purchase_evidence pe ON pe.user_id=o.user_id AND pe.observation_id=o.id WHERE s.user_id=? ORDER BY s.connection_id",
    )
    .bind(first)
    .all<{
      connection_id: string;
      content_hash: string;
      purchase_id: string;
    }>();
  expect(ownedSources.results).toHaveLength(2);
  expect(
    new Set(ownedSources.results.map((row) => row.connection_id)).size,
  ).toBe(2);
  expect(
    new Set(ownedSources.results.map((row) => row.content_hash)).size,
  ).toBe(1);
  expect(new Set(ownedSources.results.map((row) => row.purchase_id)).size).toBe(
    1,
  );
  const financial = await db
    .prepare(
      "SELECT user_id,business_event_key,CAST(amount_minor AS TEXT) amount_minor,currency,kind,eligible FROM ledger_entries WHERE user_id IN(?,?) ORDER BY user_id",
    )
    .bind(first, second)
    .all<{
      user_id: string;
      business_event_key: string;
      amount_minor: string;
      currency: string;
      kind: string;
      eligible: number;
    }>();
  const financialFacts = financial.results.map((row) => ({
    user_id: row.user_id,
    amount_minor: row.amount_minor,
    currency: row.currency,
    kind: row.kind,
    eligible: row.eligible,
  }));
  expect(financialFacts).toEqual([
    {
      user_id: second,
      amount_minor: "1000",
      currency: "EUR",
      kind: "payment",
      eligible: 1,
    },
    {
      user_id: first,
      amount_minor: "1000",
      currency: "EUR",
      kind: "payment",
      eligible: 1,
    },
  ]);
  expect(
    new Set(financial.results.map((row) => row.business_event_key)).size,
  ).toBe(1);

  const delivered = queued[0];
  if (!delivered) throw new Error("Actual dispatched message absent");
  const redeliveryMeter = createInvocationDatabase(env.DB, 40);
  expect(
    await createJobEngine({
      store: createJobStore(redeliveryMeter.db, { policy }),
      queue: {
        send: async () => {
          throw new Error("Redelivery must not dispatch");
        },
      },
    }).consume(delivered),
  ).toBe("ack");
  statementCounts.push({
    stage: "redelivery",
    count: redeliveryMeter.executedStatements(),
  });
  const initialLease = leases.find((lease) => lease.jobId === `j-${first}`);
  if (!initialLease) throw new Error("Initial trusted lease absent");
  const enqueueMeter = createInvocationDatabase(env.DB, 40),
    replayJob = `j-${first}-replay`;
  expect(
    await createJobStore(enqueueMeter.db, { policy }).enqueue(
      initialLease.context,
      {
        id: replayJob,
        connectionId: initialLease.connectionId,
        consentId: initialLease.consentId,
        generation: initialLease.generation,
        type: "source-extract",
        dedupeKey: replayJob,
      },
    ),
  ).toBe(true);
  statementCounts.push({
    stage: "enqueue",
    count: enqueueMeter.executedStatements(),
  });
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
    )
    .bind(initialLease.context.userId, replayJob, `s-${first}`)
    .run();
  const priorModelCalls = calls.modelCalls();
  await processQueuedSources();
  expect(calls.modelCalls()).toBe(priorModelCalls);
  expect(await count(first, "purchases")).toBe(1);
  expect(await count(first, "ledger_entries")).toBe(1);
  expect(
    (
      await db
        .prepare(
          "SELECT user_id,CAST(amount_minor AS TEXT) amount_minor,currency,kind,eligible FROM ledger_entries WHERE user_id IN(?,?) ORDER BY user_id",
        )
        .bind(first, second)
        .all()
    ).results,
  ).toEqual(financialFacts);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );

  const sentinels = [
    rawBody,
    rawQuote,
    rawTranscript,
    "synthetic-access",
    "synthetic-refresh",
    secondaryAccess,
    secondaryRefresh,
    otherAccess,
    otherRefresh,
    "synthetic-hosted-key",
  ];
  let sweep = createInvocationDatabase(env.DB, 40);
  const tables = (
    await sweep.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 101",
      )
      .all<{ name: string }>()
  ).results;
  expect(tables.length).toBeLessThan(101);
  const applicationTables = tables
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith("sqlite_") &&
        !name.startsWith("_cf_") &&
        name !== "d1_migrations",
    );
  const tableCounts: Record<string, number> = {};
  for (const table of applicationTables) {
    // The unified schema has more tables than one invocation's cap. Keep every
    // privacy oracle and start a fresh bounded invocation instead of widening it.
    if (sweep.remainingStatements() === 0) {
      statementCounts.push({
        stage: "retention-sweep",
        count: sweep.executedStatements(),
      });
      sweep = createInvocationDatabase(env.DB, 40);
    }
    const rows = (
      await sweep.db
        .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" LIMIT 501`)
        .all()
    ).results;
    expect(rows.length).toBeLessThan(501);
    tableCounts[table] = rows.length;
    const persisted = JSON.stringify(rows);
    for (const sentinel of sentinels)
      expect(
        persisted,
        `Persisted plaintext sentinel in ${table}`,
      ).not.toContain(sentinel);
  }
  statementCounts.push({
    stage: "retention-sweep",
    count: sweep.executedStatements(),
  });
  const retainedSurfaces = JSON.stringify({ queued, logs }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  for (const sentinel of sentinels)
    expect(retainedSurfaces).not.toContain(sentinel);
  expect(queued.length).toBeGreaterThan(0);
  expect(statementCounts.every((row) => row.count <= 40)).toBe(true);
  for (const observer of logObservers) observer.mockRestore();
  const facts = {
    statementCounts,
    tableCounts,
    queuedMessages: queued.length,
    capturedConsoleCalls: logs.length,
    mailCalls: calls.mailCalls(),
    modelCalls: calls.modelCalls(),
  };
  Object.assign(task.meta, { syntheticPipelineComposition: facts });
  await annotate(JSON.stringify(facts), "composition");
});
