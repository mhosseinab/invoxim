import { calendarDate, minorDigits } from "@invoxim/contracts";

import { parseMinor } from "./money";

export {
  calendarDate,
  currencyMinorDigits,
  minorDigits,
} from "@invoxim/contracts";
export {
  ENTRY_MINOR_BOUND,
  formatMinor,
  parseMinor,
  parseMoney,
} from "./money";
export interface AcceptedLedgerEntry {
  kind: "payment" | "refund";
  minor: string;
  currency: string;
  date: string;
  eligible: boolean;
}
export function ledgerTotals(
  entries: readonly AcceptedLedgerEntry[],
  currency: string,
  period?: { startDate: string; endExclusive: string },
) {
  minorDigits(currency);
  if (period) {
    calendarDate(period.startDate);
    calendarDate(period.endExclusive);
    if (period.startDate >= period.endExclusive)
      throw new Error("INVALID_RANGE");
  }
  let paid = 0n,
    refunded = 0n;
  for (const entry of entries) {
    if (!entry.eligible) continue;
    if (entry.currency !== currency) throw new Error("CURRENCY_MISMATCH");
    calendarDate(entry.date);
    const amount = parseMinor(entry.minor);
    if (
      period &&
      (entry.date < period.startDate || entry.date >= period.endExclusive)
    )
      continue;
    if (entry.kind === "payment") paid += amount;
    else if (entry.kind === "refund") refunded += amount;
    else throw new Error("INVALID_ENTRY_KIND");
  }
  return {
    paidMinor: paid.toString(),
    refundedMinor: refunded.toString(),
    netMinor: (paid - refunded).toString(),
  };
}

export * from "./ai/classification";
export {
  aiRunIdentityKey,
  createInferenceEngine,
  verifyFinancialDocumentResult,
} from "./ai/engine";
export * from "./ai/types";
export {
  validateExtraction,
  validatePersistableAiResult,
} from "./ai/validation";
export * from "./archive/authorization-types";
export type {
  ArchiveFolderAuthorization,
  ArchiveFolderLease,
  ArchiveFolderPlan,
  ArchiveFolderStore,
  ArchiveFolderWork,
} from "./archive/folders";
export * from "./archive/objects";
export * from "./archive/service-types";
export { monthlyAnchor } from "./calendar-anchor";
export { createCorrectionService } from "./corrections/service";
export * from "./corrections/settlement";
export * from "./corrections/types";
export * from "./corrections/validation";
export * from "./discovery/calendar";
export * from "./discovery/types";
export * from "./documents/extractor";
export * from "./documents/original";
export * from "./documents/types";
export {
  convertFxEntry,
  fxRateAgeDays,
  sumFxConversions,
} from "./fx/conversion";
export * from "./fx/types";
export { createJobEngine } from "./jobs/engine";
export type {
  DispatchCandidate,
  JobAdmission,
  JobHandler,
  JobLease,
  JobOutcome,
  JobPolicy,
  JobQueue,
  JobStore,
  NewJob,
} from "./jobs/types";
export {
  ledgerEventKey,
  normalizeLedgerMerchant,
  planLedgerIngestion,
} from "./ledger/plan";
export * from "./ledger/types";
export {
  encodeLifecycleExport,
  LifecycleError,
  spreadsheetText,
} from "./lifecycle/export";
export { createLifecycleService } from "./lifecycle/service";
export * from "./lifecycle/types";
export * from "./mailbox/authorization";
export * from "./mailbox/types";
export { convertMinor } from "./money-conversion";
export { createOnboardingUsecases } from "./onboarding/service";
export * from "./onboarding/types";
export { deriveRecurringSuggestion } from "./recurring/derive";
export * from "./recurring/types";
export type { TenantContext } from "./tenant-context";
