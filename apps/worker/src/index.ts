import type {
  AiBindings,
  DriveBindings,
  FxReferenceBindings,
  GmailBindings,
  LifecycleBindings,
  OutlookBindings,
} from "@invoxim/adapters";
import {
  aiConfiguration,
  createFxReportingService,
  createGmailContentFactory,
  createGmailDiscoveryProviderFactory,
  createJobStore,
  createLifecycleCleanup,
  createProcessingDiscoveryReadiness,
  createProcessingReviewResolver,
  createPublicReferenceRateReader,
  createRecurringService,
  fxReferenceConfiguration,
  gmailConfiguration,
  lifecycleDependencies,
  loginConfiguration,
} from "@invoxim/adapters";
import { publicConfigSchema } from "@invoxim/contracts";
import type { JobHandler } from "@invoxim/core";
import { Hono } from "hono";
import { createFxPeriodService } from "../../../packages/adapters/src/fx/period";
import { createFxPeriodSigning } from "../../../packages/adapters/src/fx/period-signing";
import { runtimeAiBindings } from "./ai-bindings";
import { createAiRoutes } from "./ai-routes";
import { createAuthRoutes } from "./auth-routes";
import { createCorrectionRoutes } from "./correction-routes";
import { createDiscoveryRuntime } from "./discovery-runtime";
import { createFxRoutes } from "./fx-routes";
import { createInvocationDatabase } from "./invocation-database";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";
import { createJobRoutes } from "./job-routes";
import { createJobRuntime } from "./job-runtime";
import { createLifecycleRoutes } from "./lifecycle-routes";
import { createMailboxRoutes } from "./mailbox-routes";
import { createOnboardingRoutes } from "./onboarding-routes";
import {
  configuredOperationalObserver,
  type OperationalBindings,
} from "./operational-configuration";
import { createPipelineRuntime } from "./pipeline-runtime";
import { createPurchaseRoutes } from "./purchase-routes";
import { createRecurringRoutes } from "./recurring-routes";
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
app.route(
  "/",
  createFxRoutes({
    service(db, bindings, remainingStatements) {
      const configuration = fxReferenceConfiguration(bindings);
      if (!configuration) return null;
      const login = loginConfiguration(bindings);
      if (!login) return null;
      const policy = {
        source: configuration.source,
        maxPriorAgeDays: configuration.maxPriorAgeDays,
      };
      const period = createFxPeriodService(db, {
        policy,
        signing: createFxPeriodSigning(login.secret),
        remainingStatements,
      });
      return {
        ...createFxReportingService(db, {
          policy,
          reader: createPublicReferenceRateReader(configuration),
        }),
        readPeriod: period.read,
      };
    },
  }),
);
app.route(
  "/",
  createRecurringRoutes({
    service(db, bindings) {
      return "RECURRING_ENABLED" in bindings &&
        bindings.RECURRING_ENABLED === "true"
        ? createRecurringService(db)
        : null;
    },
  }),
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
    RECURRING_ENABLED?: string;
  } & LifecycleBindings &
  OperationalBindings &
  FxReferenceBindings;

function configuredJobs(
  suppliedBindings: WorkerBindings,
  sharedDatabase?: ReturnType<typeof createInvocationDatabase>,
) {
  const bindings = runtimeAiBindings(suppliedBindings);
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
          content: createGmailContentFactory(database.db, gmail),
          ai,
          classificationBinding: bindings.AI,
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
      ...(ai?.classification ? { classification: ai.classification } : {}),
    }),
    ...(handler ? { handler } : {}),
    queue: {
      async send(body) {
        await queue.send(body);
      },
      async wakeDispatch() {
        await queue.send({ schemaVersion: 1, dispatch: true });
      },
    },
  });
}

// Preserve the established Hono API while adding the platform event entry points.
const handleRequest = app.fetch;
const worker = Object.assign(app, {
  fetch(
    request: Request,
    bindings?: WorkerBindings,
    context?: ExecutionContext,
  ) {
    return handleRequest(request, runtimeAiBindings(bindings ?? {}), context);
  },
  async scheduled(
    _controller: ScheduledController,
    bindings: WorkerBindings,
  ): Promise<void> {
    const started = Date.now();
    const observer = configuredOperationalObserver(bindings);
    const database = bindings.DB
      ? createInvocationDatabase(bindings.DB, 40)
      : undefined;
    const measurements = () => ({
      consumedQueryCount: database?.executedStatements() ?? 0,
      wallDurationMs: Math.max(0, Date.now() - started),
    });
    try {
      if (bindings.LIFECYCLE_ENABLED === "true" && database) {
        const { journal } = lifecycleDependencies(database.db, bindings);
        const cleanup = createLifecycleCleanup(database.db, journal);
        let unitCount = 0;
        let outcome: "idle" | "pending" | "completed" | "awaiting_journal" =
          "idle";
        for (
          let unit = 0;
          unit < 3 && database.remainingStatements() >= 5;
          unit++
        ) {
          const result = await cleanup.runOne();
          unitCount++;
          outcome = result.status;
          if (result.status === "idle" || result.status === "awaiting_journal")
            break;
        }
        await observer.observe({
          kind: "cleanup",
          outcome,
          unitCount,
          ...measurements(),
        });
      }
      // Cleanup and dispatch share the same physical execution budget.
      const runtime = configuredJobs(bindings, database);
      const result = await runtime?.scheduled();
      await observer.observe({
        kind: "schedule",
        outcome: runtime ? "completed" : "unavailable",
        scheduledCount: result?.scheduled ?? 0,
        sentCount: result?.sent ?? 0,
        ...measurements(),
      });
    } catch {
      await observer.observe({
        kind: "schedule",
        outcome: "failed",
        scheduledCount: null,
        sentCount: null,
        ...measurements(),
      });
      throw new Error("JOB_RUNTIME_UNAVAILABLE");
    }
  },
  async queue(
    batch: MessageBatch<unknown>,
    bindings: WorkerBindings,
  ): Promise<void> {
    const started = Date.now();
    const observer = configuredOperationalObserver(bindings);
    const database = bindings.DB
      ? createInvocationDatabase(bindings.DB, 40)
      : undefined;
    const measurements = () => ({
      consumedQueryCount: database?.executedStatements() ?? 0,
      wallDurationMs: Math.max(0, Date.now() - started),
    });
    try {
      const runtime = configuredJobs(bindings, database);
      if (!runtime) {
        batch.ackAll();
        await observer.observe({
          kind: "queue",
          outcome: "disabled",
          acknowledgedCount: batch.messages.length,
          retriedCount: 0,
          ...measurements(),
        });
        return;
      }
      const result = await runtime.queue(batch);
      await observer.observe({
        kind: "queue",
        outcome: result.retriedCount ? "retry" : "ack",
        ...result,
        ...measurements(),
      });
    } catch {
      batch.retryAll({ delaySeconds: 60 });
      await observer.observe({
        kind: "queue",
        outcome: "failed",
        acknowledgedCount: null,
        retriedCount: null,
        ...measurements(),
      });
    }
  },
});
export default worker;
