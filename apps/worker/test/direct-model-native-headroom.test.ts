import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import initial from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import type { ReceiptClassificationConfiguration } from "../../../packages/adapters/src/ai/clef";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
const policy = {
  dailyDocuments: 50,
  monthlyDocuments: 500,
  dailyUnits: 1000000,
  monthlyUnits: 10000000,
  globalDailyUsdMicros: "1000000",
  globalMonthlyUsdMicros: "10000000",
};
const classification: ReceiptClassificationConfiguration = {
  enabled: true,
  model: "@cf/cloudflare/clef",
  version: "clef-v1",
  maxInputBytes: 24000,
  timeoutMs: 1000,
  negativeThreshold: 0.1,
  categoryThreshold: 0.5,
  pricing: {
    version: "clef-tariff-v1",
    approved: true,
    currency: "USD",
    source: "https://developers.cloudflare.com/workers-ai/models/clef/",
    checkedAt: "2026-10-13T00:00:00Z",
    inputUsdMicrosPerMillion: "240000",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  },
};
const tenant = { userId: "headroom-owner", authority: "job" } as TenantContext;
const input = {
  connectionId: "c",
  providerMessageId: "m",
  root: {
    partId: "body",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode(
      "North Market\nReceipt 2026-10-01\nTotal EUR 24.90\nPaid by card. Card payment EUR 24.90",
    ),
  },
};
beforeAll(async () => {
  for (const sql of initial.split(";").filter((sql) => sql.trim()))
    await db.prepare(sql).run();
});
beforeEach(async () => {
  await db.prepare('DELETE FROM "user" WHERE id=?').bind(tenant.userId).run();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','headroom@example.invalid',1,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version,credential_version) VALUES('c',?,'mailbox','gmail','subject','headroom@example.invalid','active','synthetic',1,1)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','abacus','financial','v1',1,1)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES('consent',?,'c',1,'abacus','local',1,?,1,?)",
    )
    .bind(tenant.userId, now, "f".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s',?,'c','m',?,1)",
    )
    .bind(tenant.userId, now)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('job',?,'c','consent',1,'source-extract','headroom-fixture','ready',?)",
    )
    .bind(tenant.userId, now)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage) VALUES(?,'job','s','parse')",
    )
    .bind(tenant.userId)
    .run();
});

it.each([0, 2, 8])(
  "direct-model real job engine with %i attachments reaches one paid purchase within forty shared statements",
  async (attachmentCount) => {
    const { aiConfiguration } =
      await import("../../../packages/adapters/src/ai/configuration");
    const { gmailConfiguration } =
      await import("../../../packages/adapters/src/mailbox/configuration");
    const { createCredentialCipher, encodeBase64url } =
      await import("../../../packages/adapters/src/security/cipher");
    const { selectedOnboardingConfigurationDigest } =
      await import("../../../packages/adapters/src/onboarding/configuration");
    const { createPipelineRuntime } = await import("../src/pipeline-runtime");
    const { createGmailContentFactory } =
      await import("../../../packages/adapters/src/pipeline/gmail-factory");
    const keyring = {
      activeVersion: 1,
      keys: { 1: encodeBase64url(new Uint8Array(32).fill(11)) },
    };
    const binding = {
      run: vi.fn(async () => ({
        model: "clef",
        answers: {
          receipt: { type: "noul", noul: 0.9 },
          category: {
            type: "choice",
            choice: "software",
            probabilities: { software: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 50, output_tokens: 0 },
      })),
    };
    const bindings = {
      DB: db,
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
      AI_HOSTED_DESTINATION: "abacus",
      AI_HOSTED_MODEL: "financial",
      AI_HOSTED_KEY: "synthetic-key",
      AI_BUDGET_JSON: JSON.stringify(policy),
      AI_CLASSIFICATION_JSON: JSON.stringify(classification),
      AI: binding,
      AI_REGISTRY_JSON: JSON.stringify([
        {
          id: "abacus",
          endpoint: "https://model.example.invalid/v1/chat/completions",
          configVersion: "v1",
          policyVersion: 1,
          noticeRefs: ["synthetic"],
          notices: [
            {
              id: "synthetic",
              displayName: "Synthetic financial processor",
              dataUseSummary: "Synthetic only",
              retentionSummary: "Synthetic only",
              privacyUrl: "https://policy.example.invalid",
            },
          ],
          timeoutMs: 1000,
          maxInputBytes: 24000,
          maxOutputBytes: 4096,
          maxOutputTokens: 100,
          models: [
            {
              id: "financial",
              capabilities: {
                jsonSchema: false,
                jsonObject: true,
                outputLimit: "max_tokens",
                usage: true,
                idempotency: false,
              },
              pricing: classification.pricing,
            },
          ],
        },
      ]),
    };
    const ai = aiConfiguration(bindings),
      gmail = gmailConfiguration(bindings);
    if (!ai || !gmail) throw new Error("runtime config missing");
    const destination = ai.destinations[0],
      model = destination?.models[0];
    if (!destination || !model) throw new Error("fixture model missing");
    const digest = await selectedOnboardingConfigurationDigest({
      mode: "hosted",
      settingsRevision: 1,
      destination,
      model,
      ...(ai.classification ? { classification: ai.classification } : {}),
    });
    await db
      .prepare(
        "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=?",
      )
      .bind(digest, tenant.userId)
      .run();
    const encrypted = await createCredentialCipher(keyring).seal(
      tenant,
      { entityId: "c", purpose: "mailbox-credentials" },
      {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3600000,
      },
    );
    await db
      .prepare(
        "UPDATE connections SET credential_ciphertext=?,scopes=? WHERE user_id=?",
      )
      .bind(
        encrypted,
        JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
        tenant.userId,
      )
      .run();

    const { createJobEngine } =
      await import("../../../packages/core/src/jobs/engine");
    const { createJobStore } =
      await import("../../../packages/adapters/src/jobs/store");
    const { createProcessingReviewResolver } =
      await import("../../../packages/adapters/src/onboarding/processing-readiness");
    const receipt = (
      await import("../../../test-design/fixtures/receipts.json")
    ).default.fixtures[0]?.expectedExtraction;
    if (!receipt) throw new Error("Synthetic receipt fixture absent");
    const output = structuredClone(receipt);
    for (const record of output.records) {
      for (const evidence of record.evidence) evidence.inputPartId = "part-0";
      record.evidence.push({
        field: "documentDate",
        inputPartId: "part-0",
        quote: "2026-10-01",
      });
    }
    const attachmentBytes = new TextEncoder().encode(
      "%PDF-1.4\nSynthetic unsupported PDF only",
    );
    const htmlBytes = new TextEncoder().encode(
      "<p>North Market</p><p>Receipt 2026-10-01</p><p>Total EUR 24.90</p><p>Paid by card. Card payment EUR 24.90</p>",
    );
    const payload =
      attachmentCount === 0
        ? {
            partId: "body",
            mimeType: "text/plain",
            body: {
              size: input.root.bytes.length,
              data: encodeBase64url(input.root.bytes),
            },
          }
        : {
            partId: "",
            mimeType: "multipart/mixed",
            parts: [
              {
                partId: "body",
                mimeType: "multipart/alternative",
                parts: [
                  {
                    partId: "plain",
                    mimeType: "text/plain",
                    body: {
                      size: input.root.bytes.length,
                      data: encodeBase64url(input.root.bytes),
                    },
                  },
                  {
                    partId: "html",
                    mimeType: "text/html",
                    body: {
                      size: htmlBytes.length,
                      data: encodeBase64url(htmlBytes),
                    },
                  },
                ],
              },
              ...Array.from({ length: attachmentCount }, (_, index) => ({
                partId: `pdf-${index}`,
                mimeType: "application/pdf",
                filename: `synthetic-${index}.pdf`,
                body: {
                  size: attachmentBytes.length,
                  attachmentId: `attachment-${index}`,
                },
              })),
            ],
          };
    let financialCalls = 0;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (request) => {
        if (String(request) === "https://gmail.googleapis.com/batch")
          return new Response(
            `${Array.from(
              { length: attachmentCount },
              (_, index) =>
                `--native_batch\r\nContent-Type: application/http\r\nContent-ID: <response-attachment-${index}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ size: attachmentBytes.length, data: encodeBase64url(attachmentBytes) })}\r\n`,
            ).join("")}--native_batch--\r\n`,
            {
              headers: {
                "Content-Type": "multipart/mixed; boundary=native_batch",
              },
            },
          );
        if (String(request).startsWith("https://gmail.googleapis.com/"))
          return Response.json(
            String(request).includes("/attachments/")
              ? {
                  size: attachmentBytes.length,
                  data: encodeBase64url(attachmentBytes),
                }
              : { id: "m", payload },
          );
        if (String(request).startsWith("https://model.example.invalid/")) {
          financialCalls++;
          return Response.json({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(output) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 80,
              total_tokens: 130,
            },
          });
        }
        throw new Error("Unexpected synthetic provider endpoint");
      });
    const trace: {
      stage: string;
      statements: number;
      remainingAtHandler: number;
      outcome: string;
      jobStatus: unknown;
      code: unknown;
    }[] = [];
    try {
      for (let remaining = 16; remaining > 0; remaining--) {
        const job = await db
          .prepare(
            "SELECT j.id,ds.pipeline_stage AS stage FROM jobs j JOIN discovery_source_jobs ds ON ds.user_id=j.user_id AND ds.job_id=j.id WHERE j.user_id=? AND j.status='ready' ORDER BY j.id LIMIT 1",
          )
          .bind(tenant.userId)
          .first<{ id: string; stage: string }>();
        if (!job) break;
        const meter = createInvocationDatabase(db, 40);
        const store = createJobStore(meter.db, {
          policy: {
            dispatchLimit: 5,
            scheduleLimit: 1,
            tenantConcurrency: 1,
            globalConcurrency: 1,
            maxAttempts: 3,
            leaseMs: 300000,
            redeliveryMs: 300000,
            queryLimit: 40,
          },
          processingReview: createProcessingReviewResolver(ai),
          ...(ai.classification ? { classification: ai.classification } : {}),
        });
        const pipeline = createPipelineRuntime({
          db: meter.db,
          content: createGmailContentFactory(meter.db, gmail),
          ai,
          classificationBinding: binding,
          remainingStatements: meter.remainingStatements,
        });
        let remainingAtHandler = 0;
        const result = await createJobEngine({
          store,
          queue: { async send() {} },
          handler: {
            async run(current, control) {
              remainingAtHandler = meter.remainingStatements();
              return pipeline.run(current, control);
            },
          },
        }).consume({ schemaVersion: 1, jobId: job.id });
        const row = await db
          .prepare(
            "SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?",
          )
          .bind(tenant.userId, job.id)
          .first<{ status: string; outcome_code: string | null }>();
        trace.push({
          stage: job.stage,
          statements: meter.executedStatements(),
          remainingAtHandler,
          outcome: result,
          jobStatus: row?.status,
          code: row?.outcome_code,
        });
        expect(meter.executedStatements()).toBeLessThanOrEqual(40);
        expect(result, JSON.stringify(trace)).toBe("ack");
        expect(row?.status, JSON.stringify(trace)).toBe("completed");
      }
      expect(financialCalls, JSON.stringify(trace)).toBe(1);
      expect(binding.run).toHaveBeenCalledTimes(1);
      expect(
        (
          await db
            .prepare(
              "SELECT total_minor,currency,payment_state FROM purchases WHERE user_id=?",
            )
            .bind(tenant.userId)
            .all()
        ).results,
      ).toEqual([
        { total_minor: 2490, currency: "EUR", payment_state: "paid" },
      ]);
      expect(
        await db
          .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
          .bind(tenant.userId)
          .first("n"),
      ).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND status IN ('ready','leased','retry_wait','terminal')",
          )
          .bind(tenant.userId)
          .first("n"),
      ).toBe(0);
    } finally {
      fetcher.mockRestore();
    }
  },
  20000,
);
