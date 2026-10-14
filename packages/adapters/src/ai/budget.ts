/**
 * Facade for the split budget modules (AI-7). The public surface of this
 * path is unchanged; implementation lives in budget-types / budget-helpers /
 * budget-meter / budget-store / budget-allowance. SW-3 may collapse this.
 */

export type { AiAllowance } from "./budget-allowance";
export { readAiAllowance } from "./budget-allowance";
export { computeRunFingerprint } from "./budget-helpers";
export {
  createAiProbeUsageStore,
  createAiUsageStore,
  createClassificationUsageStore,
} from "./budget-store";
export type {
  AiBudgetOptions,
  AiBudgetPolicy,
  AiPriceSnapshot,
  AiProbeBudgetOptions,
  AiProbeResult,
  AiProbeUsageStore,
  ClassificationBudgetOptions,
} from "./budget-types";
