import { env } from "cloudflare:workers";
import { createDocumentTextExtractor, type JobPolicy } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createAiProviderFactory } from "../../../packages/adapters/src/ai/provider-factory";
import { createDiscoveryService } from "../../../packages/adapters/src/discovery/service";
import { normalizeGmailDocumentInput } from "../../../packages/adapters/src/documents/gmail";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import {
  createProcessingDiscoveryReadiness,
  createProcessingReviewResolver,
} from "../../../packages/adapters/src/onboarding/processing-readiness";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import { encodeBase64url } from "../../../packages/adapters/src/security/cipher";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import {
  configuredAi,
  now,
  owner,
  query,
  runtime,
  startBody,
} from "./onboarding-qa-fixture";

const db = env.DB;

const policy: JobPolicy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 1,
  globalConcurrency: 2,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 1000,
};
const samples = [
  { name: "plain-receipt", amount: "10.00", minor: "1000", note: "" },
  {
    name: "longer-receipt",
    amount: "0.99",
    minor: "99",
    note: "Synthetic line item and receipt footer.\n".repeat(12),
  },
] as const;
afterEach(async () => {
  vi.restoreAllMocks();
  // A deliberately failing service assertion may leave its synthetic lease
  // active. Keep the global concurrency oracle independent across cases.
  await db
    .prepare('DELETE FROM "user" WHERE id LIKE ?')
    .bind("qa-measure-%")
    .run();
});

async function runSample(
  sample: (typeof samples)[number],
  mode:
    | "normal"
    | "resume-cache"
    | "changed-prompt"
    | "changed-price"
    | "infer-crash"
    | "infer-uncertain"
    | "infer-changed-price" = "normal",
) {
  const inferCrash = mode.startsWith("infer-");
  const session = await owner(
      `qa-measure-${sample.name}-${mode}`,
      `qa-inbox-${sample.name}-${mode}`,
    ),
    configuration = configuredAi(),
    disclosure = await runtime().usecases.disclosure(session, {
      ...query,
      connectionId: `qa-inbox-${sample.name}-${mode}`,
      endDate: "2026-03-30",
    }),
    text = `QA Measurement Shop\n2026-03-30\nEUR ${sample.amount}\nPaid by card.\nOrder ORDER-${sample.name}\nPayment reference: PAY-${sample.name}\n${sample.note}`;
  const record = {
    merchant: "QA Measurement Shop",
    documentDate: "2026-03-30",
    eventDate: "2026-03-30",
    currency: "EUR",
    total: sample.amount,
    tax: null,
    invoiceNumber: null,
    orderReference: `ORDER-${sample.name}`,
    paymentReference: `PAY-${sample.name}`,
    refundReference: null,
    category: "shopping",
    paymentEvidence: "explicitly-paid",
    refundEvidence: "none",
    paymentMethodHint: "card",
    recurringCadence: "unknown",
    paymentAmount: sample.amount,
    refundAmount: null,
    storeCreditAmount: null,
    evidence: [
      ["merchant", "QA Measurement Shop"],
      ["documentDate", "2026-03-30"],
      ["eventDate", "2026-03-30"],
      ["currency", "EUR"],
      ["total", sample.amount],
      ["paymentAmount", sample.amount],
      ["payment", "Paid by card."],
      ["orderReference", `Order ORDER-${sample.name}`],
      ["paymentReference", `Payment reference: PAY-${sample.name}`],
    ].map(([field, quote]) => ({ field, quote, inputPartId: "part-0" })),
  };
  let modelCalls = 0;
  const modelTransport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) => {
      expect(String(url)).toBe(configuration.destinations[0]?.endpoint);
      modelCalls++;
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                schemaVersion: 1,
                documentType: "receipt",
                records: [record],
                warnings: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      });
    });
  const startedAt = performance.now();
  try {
    const start = runtime(),
      accepted = await start.usecases.start(
        session,
        startBody(disclosure),
        `qa-measure-key-${sample.name}`,
      );
    expect(start.meter.executedStatements()).toBeLessThanOrEqual(40);
    const sourceId = `message-${sample.name}`;
    const discoveryMeter = createInvocationDatabase(env.DB, 40),
      discoveryStore = createJobStore(discoveryMeter.db, {
        policy,
        clock: () => now,
      });
    if (mode === "normal") {
      const discoveryJob = await db
        .prepare(
          "SELECT id FROM jobs WHERE user_id=? AND type='discover' AND status='ready' ORDER BY rowid LIMIT 1",
        )
        .bind(session.tenant.userId)
        .first<string>("id");
      if (!discoveryJob)
        throw new Error("Accepted Start did not create discovery work");
      const discoveryLease = await discoveryStore.claim(discoveryJob);
      if (!discoveryLease) throw new Error("Accepted discovery claim failed");
      const discovery = createDiscoveryService(discoveryMeter.db, {
        providers: {
          open: async () => ({
            anchor: async () => "12345",
            list: async () => ({ ids: [sourceId] }),
            metadata: async () => ({
              id: sourceId,
              receivedAtMs: now - 3600000,
              available: true,
              excluded: false,
              candidate: "matched",
            }),
            history: async () => ({ ids: [], historyId: "12345" }),
          }),
        },
        readiness: createProcessingDiscoveryReadiness(configuration),
        remainingStatements: discoveryMeter.remainingStatements,
        clock: () => now,
      });
      const discovered = await discovery.runPage(discoveryLease, {
        signal: new AbortController().signal,
        checkpoint: () => discoveryStore.checkpoint(discoveryLease),
      });
      expect(discovered).toEqual({ kind: "completed" });
      if (!(await discoveryStore.isSettled(discoveryJob)))
        await discoveryStore.finish(discoveryLease, discovered);
      expect(discoveryMeter.executedStatements()).toBeLessThanOrEqual(40);
    } else {
      // Native service-boundary fixture: discovery behavior is independently
      // covered by the normal benchmark and discovery acceptance suites.
      const source = `qa-cache-source-${mode}`,
        job = `qa-cache-job-${mode}`;
      await db
        .prepare(
          "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,?,1)",
        )
        .bind(
          source,
          session.tenant.userId,
          disclosure.connectionId,
          sourceId,
          now - 3600000,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) SELECT ?,user_id,connection_id,consent_id,connection_generation,'source-extract',?,'ready',? FROM import_runs WHERE user_id=? AND id=?",
        )
        .bind(job, job, now, session.tenant.userId, accepted.importRunId)
        .run();
      await db
        .prepare(
          "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
        )
        .bind(session.tenant.userId, job, source)
        .run();
      await db
        .prepare(
          "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,?,?,'matched')",
        )
        .bind(session.tenant.userId, accepted.importRunId, source)
        .run();
    }
    const statementCounts = [
      start.meter.executedStatements(),
      discoveryMeter.executedStatements(),
    ];
    for (let stage = 0; stage < 3; stage++) {
      if (stage === 2 && mode !== "normal") {
        const oldFingerprint = await db
          .prepare(
            "SELECT extraction_fingerprint FROM discovery_source_jobs WHERE user_id=? AND pipeline_stage IN ('infer','reconcile') ORDER BY rowid DESC LIMIT 1",
          )
          .bind(session.tenant.userId)
          .first<string>("extraction_fingerprint");
        if (inferCrash) expect(oldFingerprint).toBeNull();
        else expect(oldFingerprint).toMatch(/^[a-f0-9]{64}$/);
        if (mode === "infer-uncertain") {
          await db
            .prepare(
              "UPDATE ai_extractions SET result_json=NULL,completed_at=NULL WHERE user_id=?",
            )
            .bind(session.tenant.userId)
            .run();
          await db
            .prepare(
              "UPDATE usage_events SET state='uncertain' WHERE user_id=?",
            )
            .bind(session.tenant.userId)
            .run();
        }
        if (mode === "changed-price" || mode === "infer-changed-price") {
          const model = configuration.destinations[0]?.models[0];
          if (!model) throw new Error("Missing approved synthetic model");
          model.pricing.version = "qa-fresh-price-v2";
        }
        const paidUsage = inferCrash
          ? (
              await db
                .prepare(
                  "SELECT * FROM usage_events WHERE user_id=? ORDER BY attempt_number",
                )
                .bind(session.tenant.userId)
                .all()
            ).results
          : null;
        await db
          .prepare(
            "UPDATE jobs SET status='paused_auth' WHERE user_id=? AND type='source-extract' AND status IN ('ready','retry_wait')",
          )
          .bind(session.tenant.userId)
          .run();
        await db
          .prepare(
            "UPDATE import_runs SET pause_reason='auth' WHERE user_id=? AND id=?",
          )
          .bind(session.tenant.userId, accepted.importRunId)
          .run();
        const reviewed = runtime(undefined, configuration),
          fresh = await reviewed.usecases.disclosure(session, {
            connectionId: disclosure.connectionId,
          });
        const resumed = runtime(undefined, configuration),
          result = await resumed.usecases.start(
            session,
            startBody(fresh),
            `qa-cached-resume-${mode}`,
          );
        expect(result).toEqual({
          importRunId: accepted.importRunId,
          reused: true,
        });
        expect(resumed.opens()).toBe(0);
        expect(resumed.meter.executedStatements()).toBeLessThanOrEqual(40);
        if (inferCrash) {
          for (let step = 0; step < 8; step++) {
            const recovery = createInvocationDatabase(env.DB, 40);
            await createJobStore(recovery.db, {
              policy,
              clock: () => now,
              processingReview: createProcessingReviewResolver(configuration),
              ...(configuration.classification
                ? { classification: configuration.classification }
                : {}),
            }).recover();
            expect(recovery.executedStatements()).toBeLessThanOrEqual(40);
          }
          const current = await db
            .prepare(
              "SELECT j.status,j.outcome_code,d.pipeline_stage,d.document_index,d.extraction_fingerprint FROM jobs j JOIN discovery_source_jobs d ON d.user_id=j.user_id AND d.job_id=j.id WHERE j.user_id=? AND d.pipeline_stage IN ('infer','reconcile') ORDER BY d.rowid DESC LIMIT 1",
            )
            .bind(session.tenant.userId)
            .first();
          expect(
            (
              await db
                .prepare(
                  "SELECT * FROM usage_events WHERE user_id=? ORDER BY attempt_number",
                )
                .bind(session.tenant.userId)
                .all()
            ).results,
          ).toEqual(paidUsage);
          if (mode !== "infer-crash") {
            expect(current).toMatchObject({
              status: "paused_auth",
              outcome_code: "cache-review-required",
              pipeline_stage: "infer",
              document_index: 0,
              extraction_fingerprint: null,
            });
            expect(modelCalls).toBe(1);
            const pausedView = await runtime(
              undefined,
              configuration,
            ).usecases.view(session, { connectionId: disclosure.connectionId });
            expect(pausedView.view.state).toBe("processing_unavailable");
            expect(pausedView.view.headlineKey).toBe("import.paused.service");
            expect(
              await db
                .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
                .bind(session.tenant.userId)
                .first("n"),
            ).toBe(0);
            return { modelCalls, refused: true };
          }
          expect(current).toMatchObject({
            status: "ready",
            pipeline_stage: "reconcile",
            document_index: 0,
          });
          const cachedKey = await db
            .prepare("SELECT run_key FROM ai_extractions WHERE user_id=?")
            .bind(session.tenant.userId)
            .first("run_key");
          expect(current?.extraction_fingerprint).toBe(cachedKey);
        } else {
          // Stage the already accepted, same-generation job at the service
          // boundary. Bounded recovery is verified separately; cache identity
          // must remain the completed inference identity from the old consent.
          await db
            .prepare(
              "UPDATE jobs SET consent_id=(SELECT consent_id FROM import_runs WHERE user_id=? AND id=?),status='ready',dispatch_at=?,outcome_code=NULL WHERE user_id=? AND type='source-extract' AND status='paused_auth'",
            )
            .bind(
              session.tenant.userId,
              accepted.importRunId,
              now,
              session.tenant.userId,
            )
            .run();
        }

        if (!inferCrash) {
          expect(
            await db
              .prepare(
                "SELECT extraction_fingerprint FROM discovery_source_jobs WHERE user_id=? AND pipeline_stage='reconcile'",
              )
              .bind(session.tenant.userId)
              .first("extraction_fingerprint"),
          ).toBe(oldFingerprint);
        }
      }
      const jobId = await db
        .prepare(
          "SELECT id FROM jobs WHERE user_id=? AND type='source-extract' AND status='ready' ORDER BY rowid LIMIT 1",
        )
        .bind(session.tenant.userId)
        .first<string>("id");
      if (!jobId) throw new Error(`Native pipeline stage ${stage} missing`);
      const meter = createInvocationDatabase(env.DB, 40),
        store = createJobStore(meter.db, { policy, clock: () => now }),
        lease = await store.claim(jobId);
      if (!lease) throw new Error("Native pipeline claim failed");
      const provider = createAiProviderFactory(meter.db, configuration, {
        requireReviewedConfiguration: true,
      });
      const nativeRepository = createPipelineRepository(meter.db, {
        clock: () => now,
        remainingStatements: meter.remainingStatements,
        processingDigest: createProcessingReviewResolver(configuration),
      });
      const pipeline = createPipelineService(meter.db, {
        repository:
          inferCrash && stage === 1
            ? {
                ...nativeRepository,
                advance: async () => {
                  throw new Error(
                    "synthetic crash after durable paid extraction",
                  );
                },
              }
            : nativeRepository,
        content: {
          open: async () => ({
            load: async () =>
              normalizeGmailDocumentInput({
                connectionId: lease.connectionId,
                providerMessageId: sourceId,
                payload: {
                  partId: "0",
                  mimeType: "text/plain",
                  body: {
                    size: new TextEncoder().encode(text).length,
                    data: encodeBase64url(new TextEncoder().encode(text)),
                  },
                },
              }),
          }),
        },
        documents: createDocumentTextExtractor(),
        inference: {
          open: async (current, work, parts) => {
            const selected = await provider.open(current.context, {
              consentId: current.consentId,
              settingsRevision: work.settingsRevision,
              parts,
              maxAttempts: 1,
            });
            return mode === "changed-prompt" && stage === 2
              ? {
                  ...selected,
                  config: { ...selected.config, promptVersion: "qa-prompt-v2" },
                }
              : selected;
          },
        },
        budget: configuration.budget,
        remainingStatements: meter.remainingStatements,
      });
      const outcome = await pipeline.run(lease, {
        signal: new AbortController().signal,
        checkpoint: () => store.checkpoint(lease),
      });
      if (inferCrash && stage === 1) {
        expect(outcome).toEqual({ kind: "retry", code: "transient" });
        expect(modelCalls).toBe(1);
        expect(
          await db
            .prepare(
              "SELECT COUNT(*) n FROM ai_extractions WHERE user_id=? AND result_json IS NOT NULL AND completed_at IS NOT NULL",
            )
            .bind(session.tenant.userId)
            .first("n"),
        ).toBe(1);
        await store.finish(lease, outcome);
        expect(meter.executedStatements()).toBeLessThanOrEqual(40);
        continue;
      }
      if (
        stage === 2 &&
        (mode === "changed-prompt" || mode === "changed-price")
      ) {
        expect(outcome).toEqual({ kind: "paused", code: "auth" });
        expect(modelCalls).toBe(1);
        expect(
          await db
            .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
            .bind(session.tenant.userId)
            .first("n"),
        ).toBe(0);
        expect(
          await db
            .prepare("SELECT COUNT(*) n FROM ai_extractions WHERE user_id=?")
            .bind(session.tenant.userId)
            .first("n"),
        ).toBe(1);
        expect(meter.executedStatements()).toBeLessThanOrEqual(40);
        return { modelCalls, refused: true };
      }
      expect(outcome).toEqual({ kind: "completed" });
      if (!(await store.isSettled(jobId))) await store.finish(lease, outcome);
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
      statementCounts.push(meter.executedStatements());
    }
    expect(
      await db
        .prepare(
          "SELECT processing_status FROM source_messages WHERE user_id=?",
        )
        .bind(session.tenant.userId)
        .first("processing_status"),
      JSON.stringify({
        jobs: (
          await db
            .prepare(
              "SELECT outcome_code FROM jobs WHERE user_id=? ORDER BY rowid",
            )
            .bind(session.tenant.userId)
            .all()
        ).results,
        reviews: (
          await db
            .prepare("SELECT reason FROM review_items WHERE user_id=?")
            .bind(session.tenant.userId)
            .all()
        ).results,
        extraction: (
          await db
            .prepare(
              "SELECT json_extract(result_json,'$.status') status,json_extract(result_json,'$.reason') reason,json_extract(result_json,'$.warnings') warnings FROM ai_extractions WHERE user_id=?",
            )
            .bind(session.tenant.userId)
            .all()
        ).results,
      }),
    ).toBe("processed");
    const origin = "https://qa-measure.example.invalid",
      secret = "synthetic-qa-measure-secret-never-live-12345",
      token = `synthetic-${session.tenant.userId}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(token),
      );
    const response = await worker.fetch(
      new Request(`${origin}/api/purchases`, {
        headers: {
          Cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
        },
      }),
      {
        DB: env.DB,
        AUTH_ENABLED: "true",
        AUTH_ORIGIN: origin,
        AUTH_SECRET: secret,
        AUTH_GOOGLE_CLIENT_ID: "synthetic",
        AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
        AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rows: [
        {
          lifecycle: [
            {
              currency: "EUR",
              paidMinor: sample.minor,
              refundedMinor: "0",
              netMinor: sample.minor,
            },
          ],
        },
      ],
    });
    const firstRecordMs = performance.now() - startedAt;
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM sync_states WHERE user_id=? AND import_run_id=? AND slice_key='older' AND stage<>'discovery_complete'",
        )
        .bind(session.tenant.userId, accepted.importRunId)
        .first("n"),
    ).toBe(1);
    expect(modelCalls).toBe(1);
    const measurement = {
      sample: sample.name,
      firstRecordMs,
      bytes: new TextEncoder().encode(text).length,
      statementCounts,
      modelCalls,
      olderHistoryPending: true,
      failures: 0,
      pauses: 0,
      transport:
        "synthetic immediate metadata/content/model responses; no live latency",
      runtime: "native workerd/D1",
    };
    return measurement;
  } finally {
    modelTransport.mockRestore();
  }
}

it("RECENT-10 measures two declared synthetic Start to first readable record samples while older history remains pending", async ({
  annotate,
  task,
}) => {
  // Authorization clocks are synthetic; performance.now remains real.
  vi.spyOn(Date, "now").mockReturnValue(now);
  const measurements: unknown[] = [];
  Object.assign(task.meta, { syntheticBenchmark: measurements });
  for (const sample of samples) {
    const result = await runSample(sample);
    measurements.push(result);
    await annotate(JSON.stringify(result), "measurement");
  }
});

it("ONBOARD-09 same-configuration fresh consent reconciles completed cached inference without another model call", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const result = await runSample(samples[0], "resume-cache");
  expect(result.modelCalls).toBe(1);
});

it.each(["changed-prompt", "changed-price"] as const)(
  "ONBOARD-09 cached inference refuses %s after fresh review without automatic model rebilling",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const result = await runSample(samples[0], mode);
    expect(result.modelCalls).toBe(1);
  },
);

it.each(["infer-crash", "infer-uncertain", "infer-changed-price"] as const)(
  "ONBOARD-09 strict recovery handles %s without a second model charge",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const result = await runSample(samples[0], mode);
    expect(result.modelCalls).toBe(1);
  },
);
