import { env } from "cloudflare:workers";
import type { JobPolicy } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createProcessingReviewResolver } from "../../../packages/adapters/src/onboarding/processing-readiness";
import { createInvocationDatabase } from "../src/invocation-database";
import {
  configuredAi,
  installOnboardingQaHooks,
  now,
  owner,
  query,
  runtime,
  startBody,
} from "./onboarding-qa-fixture";

installOnboardingQaHooks();

const policy: JobPolicy = {
  dispatchLimit: 20,
  scheduleLimit: 20,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 60000,
};
async function leased(
  id: string,
  review = createProcessingReviewResolver(configuredAi()),
) {
  const session = await owner(id);
  const onboarding = runtime();
  const disclosure = await onboarding.usecases.disclosure(session, query);
  await onboarding.usecases.start(
    session,
    startBody(disclosure),
    `start-${id}`,
  );
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE user_id=?")
    .bind(id)
    .first<{ id: string }>();
  if (!job) throw new Error("Synthetic Start did not create job");
  const meter = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(meter.db, {
    policy,
    clock: () => now,
    processingReview: review,
  });
  const lease = await store.claim(job.id);
  if (!lease) throw new Error("Synthetic job did not acquire lease");
  return { store, lease, meter };
}

it("T17 checkpoint accepts the current owned processing review using one physical statement", async () => {
  const review = vi.fn(createProcessingReviewResolver(configuredAi()));
  const { store, lease, meter } = await leased("job-review-valid", review);
  const before = meter.executedStatements();
  expect(await store.checkpoint(lease)).toBe(true);
  expect(meter.executedStatements() - before).toBeLessThanOrEqual(1);
  expect(review).toHaveBeenCalledOnce();
  expect(review.mock.calls[0]?.[0]).toMatchObject({
    mode: "hosted",
    settingsRevision: 1,
    providerId: "qa-onboard-provider",
  });
});

it("T17 changed processor endpoint invalidates review without changing the stored AI revision", async () => {
  const { store, lease, meter } = await leased(
    "job-review-env-change",
    createProcessingReviewResolver(
      configuredAi("https://changed.example.invalid/v1/chat/completions"),
    ),
  );
  expect(
    await env.DB.prepare("SELECT revision FROM ai_settings WHERE user_id=?")
      .bind(lease.context.userId)
      .first("revision"),
  ).toBe(1);
  const before = meter.executedStatements();
  const providerWork = vi.fn();
  if (await store.checkpoint(lease)) providerWork();
  expect(providerWork).not.toHaveBeenCalled();
  expect(meter.executedStatements() - before).toBeLessThanOrEqual(1);
});

it.each([
  [
    "missing-digest",
    "UPDATE processing_consents SET accepted_configuration_digest=NULL WHERE user_id=?",
  ],
  [
    "invalid-digest",
    "UPDATE processing_consents SET accepted_configuration_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE user_id=?",
  ],
  [
    "invalid-selection",
    "UPDATE ai_settings SET mode=NULL,provider_id=NULL,model_id=NULL,config_version=NULL WHERE user_id=?",
  ],
  ["missing-settings", "DELETE FROM ai_settings WHERE user_id=?"],
  [
    "inactive-settings",
    "UPDATE ai_settings SET status='deleted' WHERE user_id=?",
  ],
  [
    "revision-mismatch",
    "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
  ],
])(
  "T17 checkpoint denies %s in owned processing selection",
  async (name, sql) => {
    const { store, lease } = await leased(`job-review-${name}`);
    await env.DB.prepare(sql).bind(lease.context.userId).run();
    expect(await store.checkpoint(lease)).toBe(false);
  },
);

it.each(["null", "throws", "different-digest"])(
  "T17 checkpoint fails closed when configured resolver %s",
  async (result) => {
    const review = vi.fn(async () => {
      if (result === "throws")
        throw new Error("Synthetic private provider diagnostic");
      return result === "different-digest" ? "a".repeat(64) : null;
    });
    const { store, lease } = await leased(`job-review-${result}`, review);
    expect(await store.checkpoint(lease)).toBe(false);
  },
);

it("T17 checkpoint preserves exact tenant, job owner and lease fence before review", async () => {
  const review = vi.fn(createProcessingReviewResolver(configuredAi()));
  const { store, lease } = await leased("job-review-fence", review);
  expect(
    await store.checkpoint({
      ...lease,
      context: { ...lease.context, userId: "another-tenant" },
    }),
  ).toBe(false);
  expect(await store.checkpoint({ ...lease, jobId: "another-job" })).toBe(
    false,
  );
  expect(await store.checkpoint({ ...lease, fence: lease.fence + 1 })).toBe(
    false,
  );
  expect(await store.checkpoint({ ...lease, leaseId: "another-owner" })).toBe(
    false,
  );
  expect(review).not.toHaveBeenCalled();
});

it("T17 internal store without processing resolver retains existing checkpoint compatibility", async () => {
  const { lease } = await leased("job-review-internal");
  const store = createJobStore(env.DB, { policy, clock: () => now });
  await env.DB.prepare("DELETE FROM ai_settings WHERE user_id=?")
    .bind(lease.context.userId)
    .run();
  expect(await store.checkpoint(lease)).toBe(true);
});
