import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import {
  CorrectionError,
  evaluateCorrectionSettlement,
  settlementEvents,
  validateRefundAllocation,
} from "@invoxim/core";
import {
  allocationsCheck,
  creditProofs,
  planAllocations,
  writeAllocations,
} from "./allocation";
import type { PurchaseRow } from "./data";
import { events, purchase, purchaseVersion, reviewFact, reviews } from "./data";
import { correctionTransaction } from "./transaction";

interface Membership {
  evidence: string[];
  manual: string[];
  entries: string[];
  reviews: string[];
}
interface Decision {
  content_hash: string;
  segment_index: number;
  purchase_id: string;
  decision: "same-purchase" | "different-purchase";
}
interface MoveMap {
  target: Membership;
  source: Membership;
  targetStatus: "active" | "excluded";
  sourceStatus: "active" | "excluded";
  decisions: Decision[];
  targetPaymentState?: string;
  sourcePaymentState?: string;
  targetOpenAllocationIds?: string[];
  sourceOpenAllocationIds?: string[];
}
const empty: CorrectionResult = {
  purchaseId: null,
  version: null,
  entryId: null,
  entryVersion: null,
  reviewId: null,
  reviewVersion: null,
  reviewStatus: null,
  mergeId: null,
};
async function membership(
  db: D1Database,
  user: string,
  id: string,
): Promise<Membership> {
  const row = await db
    .prepare(
      "SELECT (SELECT json_group_array(observation_id) FROM (SELECT observation_id FROM purchase_evidence WHERE user_id=? AND purchase_id=? ORDER BY observation_id LIMIT 201)) evidence,(SELECT json_group_array(document_id) FROM (SELECT document_id FROM manual_purchase_evidence WHERE user_id=? AND purchase_id=? ORDER BY document_id LIMIT 201)) manual,(SELECT json_group_array(id) FROM (SELECT id FROM ledger_entries WHERE user_id=? AND purchase_id=? ORDER BY id LIMIT 201)) entries,(SELECT json_group_array(id) FROM (SELECT id FROM review_items WHERE user_id=? AND purchase_id=? ORDER BY id LIMIT 201)) reviews",
    )
    .bind(user, id, user, id, user, id, user, id)
    .first<{
      evidence: string;
      manual: string;
      entries: string;
      reviews: string;
    }>();
  if (!row) throw new CorrectionError("CONFLICT");
  const result = {
    evidence: JSON.parse(row.evidence) as string[],
    manual: JSON.parse(row.manual) as string[],
    entries: JSON.parse(row.entries) as string[],
    reviews: JSON.parse(row.reviews) as string[],
  };
  if (
    Object.values(result).some((values) => values.length > 200) ||
    result.evidence.length + result.manual.length > 200
  )
    throw new CorrectionError("TOO_LARGE");
  return result;
}
function membershipChecks(user: string, id: string, expected: Membership) {
  const fields = [
    ["purchase_evidence", "observation_id", expected.evidence],
    ["manual_purchase_evidence", "document_id", expected.manual],
    ["ledger_entries", "id", expected.entries],
    ["review_items", "id", expected.reviews],
  ] as const;
  return fields.map(([table, column, values]) => ({
    sql: `(SELECT json_group_array(value) FROM (SELECT ${column} AS value FROM ${table} WHERE user_id=? AND purchase_id=? ORDER BY ${column}))=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(?) ORDER BY value))`,
    values: [user, id, JSON.stringify(values)],
  }));
}

function settlementPurchase(row: PurchaseRow) {
  return {
    currency: row.currency,
    totalMinor: row.total_minor === null ? null : String(row.total_minor),
    paymentState: row.payment_state,
  };
}
export async function executeMerge(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "merge" | "unmerge" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
) {
  const user = session.tenant.userId;
  if (command.kind === "merge") {
    const target = await purchase(db, user, command.request.target.id),
      source = await purchase(db, user, command.request.source.id);
    if (target.record_status !== source.record_status)
      throw new CorrectionError("CONFLICT");
    if (target.id === source.id) throw new CorrectionError("INVALID_REQUEST");
    const checks = [
      purchaseVersion(user, target, command.request.target.version),
      purchaseVersion(user, source, command.request.source.version),
    ];
    const targetMembers = await membership(db, user, target.id),
      sourceMembers = await membership(db, user, source.id);
    if (
      targetMembers.entries.length + sourceMembers.entries.length > 200 ||
      targetMembers.evidence.length +
        targetMembers.manual.length +
        sourceMembers.evidence.length +
        sourceMembers.manual.length >
        200 ||
      targetMembers.reviews.length + sourceMembers.reviews.length > 200
    )
      throw new CorrectionError("TOO_LARGE");
    const targetEvents = await events(db, user, target.id),
      sourceEvents = await events(db, user, source.id);
    const targetReviews = await reviews(db, user, target.id),
      sourceReviews = await reviews(db, user, source.id);
    const combinedEvents = [...targetEvents, ...sourceEvents],
      combinedReviews = [...targetReviews, ...sourceReviews];
    if (combinedReviews.some((review) => review.version >= 2147483646))
      throw new CorrectionError("CONFLICT");
    validateRefundAllocation(combinedEvents);
    const credits = [
      ...(await creditProofs(db, user, target.id)),
      ...(await creditProofs(db, user, source.id)),
    ];
    const settlement = evaluateCorrectionSettlement(
      settlementPurchase(target),
      settlementEvents(combinedEvents, combinedReviews.map(reviewFact)),
      credits,
    );
    const allocations = planAllocations(target, settlement, combinedReviews);
    if (
      combinedReviews.length +
        allocations.filter((plan) => !plan.existing).length >
      200
    )
      throw new CorrectionError("TOO_LARGE");
    checks.push(...allocationsCheck(user, allocations));
    const old = await db
      .prepare(
        "SELECT content_hash,segment_index,purchase_id,decision FROM ledger_match_decisions WHERE user_id=? AND (purchase_id=? OR purchase_id=?) ORDER BY content_hash,segment_index,purchase_id LIMIT 401",
      )
      .bind(user, target.id, source.id)
      .all<Decision>();
    if (old.results.length > 400) throw new CorrectionError("TOO_LARGE");
    const map: MoveMap = {
      target: { ...targetMembers, reviews: [...targetMembers.reviews] },
      source: sourceMembers,
      targetStatus: target.record_status as "active" | "excluded",
      sourceStatus: source.record_status as "active" | "excluded",
      decisions: old.results,
      targetPaymentState: target.payment_state,
      sourcePaymentState: source.payment_state,
      targetOpenAllocationIds: targetReviews
        .filter(
          (row) =>
            row.reason === "payment-allocation-review" && row.status === "open",
        )
        .map((row) => row.id),
      sourceOpenAllocationIds: sourceReviews
        .filter(
          (row) =>
            row.reason === "payment-allocation-review" && row.status === "open",
        )
        .map((row) => row.id),
    };
    map.target.reviews.push(
      ...allocations.filter((plan) => !plan.existing).map((plan) => plan.id),
    );
    const moved = JSON.stringify(map);
    if (new TextEncoder().encode(moved).length > 2097152)
      throw new CorrectionError("TOO_LARGE");
    checks.push(
      ...membershipChecks(user, target.id, targetMembers),
      ...membershipChecks(user, source.id, sourceMembers),
    );
    const mergeId = crypto.randomUUID(),
      result = {
        ...empty,
        purchaseId: target.id,
        version: target.version + 1,
        mergeId,
      };
    const tx = correctionTransaction(
      db,
      session,
      key,
      identity,
      result,
      checks,
      clock,
    );
    writeAllocations(tx, user, target.id, allocations, clock);
    tx.add(
      `INSERT INTO purchase_merges(id,user_id,target_id,source_id,target_version,source_version,moved_json,active) SELECT ?,?,?,?,?,?,?,1 WHERE ${tx.guard}`,
      [
        mergeId,
        user,
        target.id,
        source.id,
        target.version + 1,
        source.version + 1,
        moved,
        ...tx.guardValues,
      ],
    );
    tx.add(
      `DELETE FROM ledger_match_decisions WHERE user_id=? AND purchase_id IN(?,?) AND ${tx.guard}`,
      [user, target.id, source.id, ...tx.guardValues],
    );
    tx.add(
      `INSERT INTO ledger_match_decisions(user_id,content_hash,segment_index,purchase_id,decision) SELECT DISTINCT o.user_id,d.content_hash,o.segment_index,?,'same-purchase' FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id WHERE pe.user_id=? AND pe.purchase_id IN(?,?) AND ${tx.guard} ON CONFLICT(user_id,content_hash,segment_index,purchase_id) DO UPDATE SET decision='same-purchase'`,
      [target.id, user, target.id, source.id, ...tx.guardValues],
    );
    tx.add(
      `UPDATE purchase_evidence SET purchase_id=? WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [target.id, user, source.id, ...tx.guardValues],
    );
    tx.add(
      `INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) SELECT user_id,?,document_id FROM manual_purchase_evidence WHERE user_id=? AND purchase_id=? AND ${tx.guard} ON CONFLICT DO NOTHING`,
      [target.id, user, source.id, ...tx.guardValues],
    );
    tx.add(
      `DELETE FROM manual_purchase_evidence WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [user, source.id, ...tx.guardValues],
    );
    tx.add(
      `UPDATE ledger_entries SET purchase_id=? WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [target.id, user, source.id, ...tx.guardValues],
    );
    tx.add(
      `UPDATE review_items SET purchase_id=?,version=version+1 WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [target.id, user, source.id, ...tx.guardValues],
    );
    tx.add(
      `UPDATE purchases SET payment_state=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [settlement.paymentState, user, target.id, ...tx.guardValues],
    );
    tx.add(
      `UPDATE purchases SET record_status='merged',version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [user, source.id, ...tx.guardValues],
    );
    tx.audit(
      "purchase",
      target.id,
      "merged",
      { version: target.version },
      { version: target.version + 1 },
    );
    tx.audit(
      "purchase",
      source.id,
      "merged-into-target",
      { recordStatus: source.record_status },
      { recordStatus: "merged" },
    );
    return tx.commit();
  }
  const saved = await db
    .prepare(
      "SELECT target_id,source_id,target_version,source_version,moved_json,active FROM purchase_merges WHERE user_id=? AND id=?",
    )
    .bind(user, command.request.mergeId)
    .first<{
      target_id: string;
      source_id: string;
      target_version: number;
      source_version: number;
      moved_json: string;
      active: number;
    }>();
  if (!saved || saved.target_id !== command.purchaseId)
    throw new CorrectionError("NOT_FOUND");
  const target = await purchase(db, user, saved.target_id),
    source = await purchase(db, user, saved.source_id);
  if (
    !saved.active ||
    target.version !== saved.target_version ||
    source.version !== saved.source_version ||
    source.version !== command.request.sourceVersion ||
    source.record_status !== "merged" ||
    source.version >= 2147483646
  )
    throw new CorrectionError("CONFLICT");
  const map = JSON.parse(saved.moved_json) as MoveMap;
  const union: Membership = {
    evidence: [...new Set([...map.target.evidence, ...map.source.evidence])],
    manual: [...new Set([...map.target.manual, ...map.source.manual])],
    entries: [...map.target.entries, ...map.source.entries],
    reviews: [...map.target.reviews, ...map.source.reviews],
  };
  const checks = [
    purchaseVersion(user, target, command.request.version),
    {
      sql: "EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND id=? AND version=? AND record_status='merged')",
      values: [user, source.id, source.version],
    },
    ...membershipChecks(user, target.id, union),
    ...membershipChecks(user, source.id, {
      evidence: [],
      manual: [],
      entries: [],
      reviews: [],
    }),
  ];
  const currentEvents = await events(db, user, target.id),
    currentReviews = await reviews(db, user, target.id);
  const targetEvents = currentEvents.filter((entry) =>
    map.target.entries.includes(entry.id),
  );
  const sourceEvents = currentEvents.filter((entry) =>
    map.source.entries.includes(entry.id),
  );
  const targetReviews = currentReviews.filter((review) =>
    map.target.reviews.includes(review.id),
  );
  const sourceReviews = currentReviews.filter((review) =>
    map.source.reviews.includes(review.id),
  );
  if (sourceReviews.some((review) => review.version >= 2147483646))
    throw new CorrectionError("CONFLICT");
  validateRefundAllocation(targetEvents);
  validateRefundAllocation(sourceEvents);
  const targetSettlement = evaluateCorrectionSettlement(
    settlementPurchase(target),
    settlementEvents(targetEvents, targetReviews.map(reviewFact)),
    await creditProofs(db, user, target.id, map.target.evidence),
  );
  const sourceSettlement = evaluateCorrectionSettlement(
    settlementPurchase(source),
    settlementEvents(sourceEvents, sourceReviews.map(reviewFact)),
    await creditProofs(db, user, target.id, map.source.evidence),
  );
  const targetAllocations = planAllocations(
    { ...target, payment_state: map.targetPaymentState ?? "unknown" },
    targetSettlement,
    targetReviews,
    map.targetOpenAllocationIds ?? [],
  );
  const sourceAllocations = planAllocations(
    { ...source, payment_state: map.sourcePaymentState ?? "unknown" },
    sourceSettlement,
    sourceReviews,
    map.sourceOpenAllocationIds ?? [],
  );
  if (
    targetReviews.length +
      targetAllocations.filter((plan) => !plan.existing).length >
      200 ||
    sourceReviews.length +
      sourceAllocations.filter((plan) => !plan.existing).length >
      200
  )
    throw new CorrectionError("TOO_LARGE");
  checks.push(
    ...allocationsCheck(user, [...targetAllocations, ...sourceAllocations]),
  );
  const result = {
    ...empty,
    purchaseId: target.id,
    version: target.version + 1,
    mergeId: command.request.mergeId,
  };
  const tx = correctionTransaction(
    db,
    session,
    key,
    identity,
    result,
    checks,
    clock,
  );
  writeAllocations(tx, user, target.id, targetAllocations, clock);
  writeAllocations(tx, user, target.id, sourceAllocations, clock);
  for (const [table, column, ids] of [
    ["purchase_evidence", "observation_id", map.source.evidence],
    ["ledger_entries", "id", map.source.entries],
    [
      "review_items",
      "id",
      [
        ...map.source.reviews,
        ...sourceAllocations
          .filter((plan) => !plan.existing)
          .map((plan) => plan.id),
      ],
    ],
  ] as const)
    tx.add(
      `UPDATE ${table} SET purchase_id=? ${table === "review_items" ? ",version=version+1" : ""} WHERE user_id=? AND purchase_id=? AND ${column} IN(SELECT value FROM json_each(?)) AND ${tx.guard}`,
      [source.id, user, target.id, JSON.stringify(ids), ...tx.guardValues],
    );
  tx.add(
    `INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) SELECT ?,?,value FROM json_each(?) WHERE ${tx.guard} ON CONFLICT DO NOTHING`,
    [user, source.id, JSON.stringify(map.source.manual), ...tx.guardValues],
  );
  const sourceOnly = map.source.manual.filter(
    (id) => !map.target.manual.includes(id),
  );
  tx.add(
    `DELETE FROM manual_purchase_evidence WHERE user_id=? AND purchase_id=? AND document_id IN(SELECT value FROM json_each(?)) AND ${tx.guard}`,
    [user, target.id, JSON.stringify(sourceOnly), ...tx.guardValues],
  );
  tx.add(
    `DELETE FROM ledger_match_decisions WHERE user_id=? AND purchase_id IN(?,?) AND ${tx.guard}`,
    [user, target.id, source.id, ...tx.guardValues],
  );
  tx.add(
    `INSERT INTO ledger_match_decisions(user_id,content_hash,segment_index,purchase_id,decision) SELECT ?,json_extract(value,'$.content_hash'),json_extract(value,'$.segment_index'),json_extract(value,'$.purchase_id'),json_extract(value,'$.decision') FROM json_each(?) WHERE ${tx.guard}`,
    [user, JSON.stringify(map.decisions), ...tx.guardValues],
  );
  tx.add(
    `UPDATE purchases SET record_status=?,payment_state=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [
      map.sourceStatus,
      sourceSettlement.paymentState,
      user,
      source.id,
      ...tx.guardValues,
    ],
  );
  tx.add(
    `UPDATE purchases SET payment_state=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [targetSettlement.paymentState, user, target.id, ...tx.guardValues],
  );
  tx.add(
    `UPDATE purchase_merges SET active=0 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [user, command.request.mergeId, ...tx.guardValues],
  );
  tx.audit(
    "purchase",
    target.id,
    "unmerged",
    { version: target.version },
    { version: target.version + 1 },
  );
  return tx.commit();
}
