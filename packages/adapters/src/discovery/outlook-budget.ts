import type { JobOutcome } from "@invoxim/core";

/**
 * O5: D1 statement reservations for the Outlook runners under the shared
 * 40-statement invocation budget (G-40). Each value is how many statements a
 * step must still be able to execute; below it the step stops before any
 * provider read or write. Values are unchanged from the tuned T17 runners.
 */
export const OUTLOOK_STATEMENTS = {
  /** Job start: inventory reads plus one bounded inventory step. */
  jobStart: 20,
  /** After opening Graph when exclusions still need resolving and saving. */
  afterOpen: 16,
  /** After opening Graph when exclusions are already saved. */
  afterOpenWithExclusions: 20,
  /** Below this, a cold first inventory page only stages its exclusions. */
  stageExclusionsOnlyBelow: 14,
  /** Before requesting one Graph inventory page. */
  inventoryPage: 12,
  /** Before committing one inventory page. */
  inventoryCommit: 9,
  /** One rate deferral or pause batch (G4). */
  rateDeferral: 3,
  /** Before requesting one Graph folder page. */
  folderPage: 16,
  /** Folder page commit: fixed statements plus per-reference statements. */
  folderCommitFixed: 5,
  folderCommitPerReference: 4,
  /** Parent advance batch plus its settlement read. */
  advanceParent: 6,
  /** Expired-delta reset batch plus its settlement read. */
  resetExpired: 5,
  /** Folder rate deferral batch plus its settlement read. */
  folderRate: 5,
} as const;

/**
 * OD-11 (owner default): an Outlook statement shortfall stays a transient
 * retry. Gmail's discovery keeps its own outcomes (pinned in tests); they are
 * deliberately not unified here.
 */
export function outlookBudgetShortfall(): JobOutcome {
  return { kind: "retry", code: "transient" };
}
