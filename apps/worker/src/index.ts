import type {
  AiBindings,
  DriveBindings,
  GmailBindings,
  LifecycleBindings,
  OutlookBindings,
} from "@invoxim/adapters";
import {
  aiConfiguration,
  createGmailDiscoveryProviderFactory,
  createJobStore,
  createLifecycleCleanup,
  createProcessingDiscoveryReadiness,
  createProcessingReviewResolver,
  gmailConfiguration,
  lifecycleDependencies,
  loginConfiguration,
} from "@invoxim/adapters";
import { publicConfigSchema } from "@invoxim/contracts";
import type { JobHandler } from "@invoxim/core";
import { Hono } from "hono";
import { createAiRoutes } from "./ai-routes";
import { createAuthRoutes } from "./auth-routes";
import { createCorrectionRoutes } from "./correction-routes";
import { createDiscoveryRuntime } from "./discovery-runtime";
import { createInvocationDatabase } from "./invocation-database";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";
import { createJobRoutes } from "./job-routes";
import { createJobRuntime } from "./job-runtime";
import { createLifecycleRoutes } from "./lifecycle-routes";
import { createMailboxRoutes } from "./mailbox-routes";
import { createOnboardingRoutes } from "./onboarding-routes";
import { createPipelineRuntime } from "./pipeline-runtime";
import { createPurchaseRoutes } from "./purchase-routes";
import { createStorageRoutes } from "./storage-routes";

const app = new Hono<{ Bindings: WorkerBindings }>();
app.use("/api/*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Referrer-Policy", "no-referrer");
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
});
app.get("/api/health", (context) => context.json({ status: "scaffold" }));
// Public capabilities derive from validated server configuration; never expose settings or keys.
const publicConfig = publicConfigSchema.parse({
  displayName: "Invoxim",
  signupMode: "allowlist",
  demoEnabled: true,
  loginEnabled: false,
  mailProviders: [],
  features: {
    outlook: false,
    driveArchive: false,
    recurring: false,
    useTags: false,
  },
  policyRoutes: { privacy: null, terms: null },
});
app.get("/api/public-config", (context) =>
  context.json(
    publicConfigSchema.parse({
      ...publicConfig,
      loginEnabled: !!loginConfiguration(context.env ?? {}),
      mailProviders: gmailConfiguration(context.env ?? {}) ? ["gmail"] : [],
    }),
  ),
);
app.route("/", createJobRoutes());
app.route("/", createLifecycleRoutes());
app.route("/", createStorageRoutes());
app.route("/", createMailboxRoutes());
app.route("/", createAiRoutes());
app.route("/", createPurchaseRoutes());
app.route("/", createCorrectionRoutes());
app.route("/", createOnboardingRoutes());
// Auth's fallback must follow every implemented API collection.
app.route("/", createAuthRoutes());

type WorkerBindings = DriveBindings &
  OutlookBindings &
  JobBindings &
  GmailBindings &
  AiBindings & {
    GMAIL_DISCOVERY_ENABLED?: string;
    EXTRACTION_ENABLED?: string;
  } & LifecycleBindings;

function configuredJobs(
  bindings: WorkerBindings,
  sharedDatabase?: ReturnType<typeof createInvocationDatabase>,
) {
  const configuredPolicy = jobConfiguration(bindings);
  const policy =
    configuredPolicy && sharedDatabase
      ? {
          ...configuredPolicy,
          queryLimit: Math.min(
            configuredPolicy.queryLimit ?? 40,
            sharedDatabase.remainingStatements(),
          ),
        }
      : configuredPolicy;
  if (!policy || !bindings.DB || !bindings.JOBS) return null;
  const queue = bindings.JOBS;
  const database =
    sharedDatabase ??
    createInvocationDatabase(bindings.DB, policy.queryLimit ?? 40);
  const gmail =
    bindings.GMAIL_DISCOVERY_ENABLED === "true" ||
    bindings.EXTRACTION_ENABLED === "true"
      ? gmailConfiguration(bindings)
      : null;
  const ai =
    bindings.EXTRACTION_ENABLED === "true" ? aiConfiguration(bindings) : null;
  const discovery =
    gmail && ai && bindings.GMAIL_DISCOVERY_ENABLED === "true"
      ? createDiscoveryRuntime({
          db: database.db,
          providers: createGmailDiscoveryProviderFactory(database.db, gmail),
          readiness: createProcessingDiscoveryReadiness(ai),
          remainingStatements: database.remainingStatements,
        })
      : undefined;
  const pipeline =
    gmail && ai && (policy.queryLimit ?? 40) === 40
      ? createPipelineRuntime({
          db: database.db,
          gmail,
          ai,
          remainingStatements: database.remainingStatements,
        })
      : null;
  const handler: JobHandler | null =
    discovery || pipeline
      ? {
          run(lease, control) {
            const selected = ["source-extract", "reprocess"].includes(
              lease.type,
            )
              ? pipeline
              : discovery;
            return selected
              ? selected.run(lease, control)
              : Promise.resolve({
                  kind: "paused" as const,
                  code: "handler-unavailable" as const,
                });
          },
        }
      : null;
  return createJobRuntime({
    store: createJobStore(database.db, {
      policy,
      ...(ai ? { processingReview: createProcessingReviewResolver(ai) } : {}),
    }),
    ...(handler ? { handler } : {}),
    queue: {
      async send(body) {
        await queue.send(body);
      },
    },
  });
}

// Preserve the established Hono API while adding the platform event entry points.
const worker = Object.assign(app, {
  async scheduled(
    _controller: ScheduledController,
    bindings: WorkerBindings,
  ): Promise<void> {
    try {
      if (bindings.LIFECYCLE_ENABLED === "true" && bindings.DB) {
        const database = createInvocationDatabase(bindings.DB, 40);
        const { journal } = lifecycleDependencies(database.db, bindings);
        const cleanup = createLifecycleCleanup(database.db, journal);
        for (
          let unit = 0;
          unit < 3 && database.remainingStatements() >= 5;
          unit++
        ) {
          const result = await cleanup.runOne();
          if (result.status === "idle" || result.status === "awaiting_journal")
            break;
        }
        // Cleanup cannot starve active tenants; dispatch shares the remaining meter.
        await configuredJobs(bindings, database)?.scheduled();
        return;
      }
      await configuredJobs(bindings)?.scheduled();
    } catch {
      throw new Error("JOB_RUNTIME_UNAVAILABLE");
    }
  },
  async queue(
    batch: MessageBatch<unknown>,
    bindings: WorkerBindings,
  ): Promise<void> {
    try {
      const runtime = configuredJobs(bindings);
      if (!runtime) {
        batch.ackAll();
        return;
      }
      await runtime.queue(batch);
    } catch {
      batch.retryAll({ delaySeconds: 60 });
    }
  },
});
export default worker;
