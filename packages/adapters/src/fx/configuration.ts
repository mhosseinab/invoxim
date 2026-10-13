import { fxConversionPolicySchema } from "@invoxim/contracts";
import { z } from "zod";

export class FxReferenceError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "invalid_request"
      | "invalid_response"
      | "timeout"
      | "unavailable",
  ) {
    super(`FX_REFERENCE_${code.toUpperCase()}`);
    this.name = "FxReferenceError";
  }
}

export interface FxReferenceBindings {
  FX_REFERENCE_ENABLED?: string;
  FX_REFERENCE_ADAPTER?: string;
  FX_REFERENCE_SOURCE?: string;
  FX_MAX_PRIOR_AGE_DAYS?: string;
  FX_REFERENCE_TIMEOUT_MS?: string;
}

export const fxReferenceConfigurationSchema = fxConversionPolicySchema
  .extend({
    adapter: z.literal("frankfurter-v2"),
    source: z.literal("ecb"),
    timeoutMs: z.number().int().min(100).max(10000),
  })
  .strict();
export type FxReferenceConfiguration = z.infer<
  typeof fxReferenceConfigurationSchema
>;

/** Enabled configuration requires every choice explicitly; no operator source policy is presumed. */
export function fxReferenceConfiguration(
  bindings: FxReferenceBindings,
): FxReferenceConfiguration | null {
  if (
    bindings.FX_REFERENCE_ENABLED === undefined ||
    bindings.FX_REFERENCE_ENABLED === "false"
  )
    return null;
  if (bindings.FX_REFERENCE_ENABLED !== "true")
    throw new FxReferenceError("invalid_configuration");
  const integer = (value: string | undefined) =>
    value && /^(?:0|[1-9][0-9]{0,5})$/.test(value) ? Number(value) : null;
  const parsed = fxReferenceConfigurationSchema.safeParse({
    adapter: bindings.FX_REFERENCE_ADAPTER,
    source: bindings.FX_REFERENCE_SOURCE,
    maxPriorAgeDays: integer(bindings.FX_MAX_PRIOR_AGE_DAYS),
    timeoutMs: integer(bindings.FX_REFERENCE_TIMEOUT_MS),
  });
  if (!parsed.success) throw new FxReferenceError("invalid_configuration");
  return parsed.data;
}
