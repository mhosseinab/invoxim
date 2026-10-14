import type { AiUsage, ApprovedAiConfig } from "@invoxim/core";
import { buildFingerprintTuple } from "./configuration";
import type { AiBudgetPolicy, AiPriceSnapshot } from "./budget-types";

export const MAX = 9000000000000n;
const MILLION = 1000000n;

export function integer(value: number, positive = false): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= Number(MAX)
  );
}
export function micros(value: string): bigint {
  if (!/^[0-9]{1,15}$/.test(value) || BigInt(value) > MAX)
    throw new Error("INVALID_AI_BUDGET");
  return BigInt(value);
}
export function bindingNumber(value: bigint): number {
  if (value < 0n || value > MAX || !Number.isSafeInteger(Number(value)))
    throw new Error("INVALID_AI_BUDGET");
  return Number(value);
}
export function ceil(value: bigint): bigint {
  return (value + MILLION - 1n) / MILLION;
}
export async function digest(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Run fingerprint recipe (A1). Must stay byte-identical to configuration.ts and classifier-factory.ts. */
export async function computeRunFingerprint(input: {
  mode: "hosted" | "byok";
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
  consentId: string;
  promptVersion: string;
  classificationAuthorization: boolean;
}): Promise<string> {
  return digest(buildFingerprintTuple(input));
}
export function validatePolicy(policy: AiBudgetPolicy): void {
  for (const value of [
    policy.dailyDocuments,
    policy.monthlyDocuments,
    policy.dailyUnits,
    policy.monthlyUnits,
  ])
    if (!integer(value, true)) throw new Error("INVALID_AI_BUDGET");
  micros(policy.globalDailyUsdMicros);
  micros(policy.globalMonthlyUsdMicros);
}
export function validPrice(
  price: AiPriceSnapshot | undefined,
  config: ApprovedAiConfig,
): price is AiPriceSnapshot {
  if (
    !price ||
    !/^[a-f0-9]{64}$/.test(price.configurationDigest) ||
    (price.acceptedConfigurationDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(price.acceptedConfigurationDigest)) ||
    price.approved !== true ||
    price.currency !== "USD" ||
    price.destinationId !== config.destinationId ||
    price.modelId !== config.modelId ||
    !Number.isSafeInteger(price.policyVersion) ||
    price.policyVersion < 1 ||
    !Number.isFinite(Date.parse(price.checkedAt))
  )
    return false;
  try {
    if (new URL(price.source).protocol !== "https:") return false;
    for (const value of [
      price.inputUsdMicrosPerMillion,
      price.outputUsdMicrosPerMillion,
      price.otherUsdMicrosPerMillion,
    ])
      micros(value);
    return JSON.stringify(price).length <= 4096;
  } catch {
    return false;
  }
}
export function upperCost(price: AiPriceSnapshot, units: number): number {
  const rate = [
    price.inputUsdMicrosPerMillion,
    price.outputUsdMicrosPerMillion,
    price.otherUsdMicrosPerMillion,
  ]
    .map(micros)
    .reduce((a, b) => (a > b ? a : b));
  return bindingNumber(ceil(BigInt(units) * rate));
}
export function measured(
  usage: AiUsage | null,
  price: AiPriceSnapshot,
): { units: bigint; cost: bigint } | null {
  if (
    usage?.source !== "reported" ||
    ![usage.input, usage.output, usage.other].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    return null;
  const units =
    BigInt(usage.input) + BigInt(usage.output) + BigInt(usage.other);
  const cost = ceil(
    BigInt(usage.input) * micros(price.inputUsdMicrosPerMillion) +
      BigInt(usage.output) * micros(price.outputUsdMicrosPerMillion) +
      BigInt(usage.other) * micros(price.otherUsdMicrosPerMillion),
  );
  return { units, cost };
}

/** Run identity of one attempt: `runKey:attemptNumber` (AI-7, one rule). */
export function attemptId(runKey: string, attemptNumber: number): string {
  return `${runKey}:${attemptNumber}`;
}

export async function budgetOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("AI_BUDGET_UNAVAILABLE");
  }
}
