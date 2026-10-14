import { hasControlCharacters } from "@invoxim/contracts";
import type { InvoiceExtractor } from "@invoxim/core";
import { Client } from "langsmith";
import { z } from "zod";

export interface AiTracingBindings {
  AI_TRACING_ENABLED?: string;
  AI_TRACING_INCLUDE_CONTENT?: string;
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  LANGSMITH_HOST?: string;
}
const configurationSchema = z.strictObject({
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !hasControlCharacters(value)),
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  host: z
    .string()
    .max(2048)
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        !hasControlCharacters(value) &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    })
    .transform((value) => new URL(value).origin),
  includeContent: z.boolean(),
});
type TracingConfiguration = z.infer<typeof configurationSchema>;

/** Invalid optional telemetry never disables receipt processing. No ambient SDK env reads. */
export function langsmithConfiguration(
  bindings: AiTracingBindings,
): TracingConfiguration | undefined {
  if (bindings.AI_TRACING_ENABLED !== "true") return undefined;
  if (
    bindings.AI_TRACING_INCLUDE_CONTENT !== undefined &&
    !["true", "false"].includes(bindings.AI_TRACING_INCLUDE_CONTENT)
  )
    return undefined;
  const parsed = configurationSchema.safeParse({
    apiKey: bindings.LANGSMITH_API_KEY,
    project: bindings.LANGSMITH_PROJECT ?? "invoxim-ai",
    host: bindings.LANGSMITH_HOST ?? "https://api.smith.langchain.com",
    includeContent: bindings.AI_TRACING_INCLUDE_CONTENT === "true",
  });
  if (!parsed.success) {
    console.warn("ai_tracing_configuration_invalid");
    return undefined;
  }
  return parsed.data;
}

const TRACE_TIMEOUT_MS = 1000;

/** One completed run, no SDK background queue/retries, no request/credential serialization. */
export function traceChatExtractor(
  extractor: InvoiceExtractor,
  configuration: TracingConfiguration | undefined,
  options: { syntheticProbe: boolean; providerKey?: string },
): InvoiceExtractor {
  if (!configuration) return extractor;
  const traceUrl = `${configuration.host}/runs`;
  const includeContent = configuration.includeContent && options.syntheticProbe;
  const scrub = (text: string) => {
    let safe = text;
    for (const secret of [configuration.apiKey, options.providerKey]) {
      if (secret) safe = safe.replaceAll(secret, "[redacted]");
    }
    return safe.slice(0, 16000);
  };
  return {
    async extract(parts, config, attempt, signal) {
      const start = Date.now();
      // Invoke exactly once. Preserve both the original result and thrown failures.
      let result: Awaited<ReturnType<InvoiceExtractor["extract"]>> | undefined;
      try {
        result = await extractor.extract(parts, config, attempt, signal);
        return result;
      } finally {
        const end = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          const client = new Client({
            apiUrl: configuration.host,
            apiKey: configuration.apiKey,
            autoBatchTracing: false,
            omitTracedRuntimeInfo: true,
            disablePromptCache: true,
            hideInputs: !includeContent,
            hideOutputs: !includeContent,
            timeout_ms: TRACE_TIMEOUT_MS,
            callerOptions: { maxRetries: 0 },
            debug: false,
            tracingMode: "langsmith",
            fetchImplementation: async (url, init) => {
              if (String(url) !== traceUrl)
                throw new Error("Trace destination unavailable");
              const response = await fetch(traceUrl, {
                ...init,
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": configuration.apiKey,
                },
                redirect: "error",
                signal: controller.signal,
              });
              // Never pass third-party response bodies into SDK diagnostics.
              await response.body?.cancel();
              return new Response("{}", { status: response.ok ? 200 : 503 });
            },
          });
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Trace deadline"));
            }, TRACE_TIMEOUT_MS);
          });
          await Promise.race([
            client.createRun({
              id: crypto.randomUUID(),
              name: "ai.chat-completions",
              run_type: "llm",
              project_name: configuration.project,
              start_time: start,
              end_time: end,
              inputs: includeContent
                ? { parts: parts.map((part) => ({ text: scrub(part.text) })) }
                : {},
              outputs:
                includeContent && result?.status === "ok"
                  ? { content: scrub(result.output) }
                  : {},
              extra: {
                metadata: {
                  provider: config.destinationId,
                  model: config.modelId,
                  promptVersion: config.promptVersion,
                  schemaVersion: config.schemaVersion,
                  mode: config.mode,
                  syntheticProbe: options.syntheticProbe,
                  contentIncluded: includeContent,
                  status: result?.status ?? "exception",
                  reason: result?.status === "failed" ? result.reason : null,
                  finish: result?.status === "ok" ? result.finish : null,
                  latencyMs: end - start,
                  usageAvailable: result?.usage != null,
                  ...(result?.usage ? { usage: result.usage } : {}),
                },
              },
            }),
            timeout,
          ]);
        } catch {
          console.warn("ai_tracing_export_failed");
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
        }
      }
    },
  };
}
