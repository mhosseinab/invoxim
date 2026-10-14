import type { TenantContext } from "@invoxim/core";
import type { AiBudgetPolicy } from "./budget-types";
import { budgetOperation, micros, validatePolicy } from "./budget-helpers";

export interface AiAllowance {
  readonly dailyDocumentsRemaining: number;
  readonly monthlyDocumentsRemaining: number;
  readonly dailyUnitsRemaining: number;
  readonly monthlyUnitsRemaining: number;
  readonly hostedFundingAvailable: boolean;
  readonly cooldownActive: boolean;
}
async function aiAllowance(
  db: D1Database,
  tenant: TenantContext,
  policy: AiBudgetPolicy,
  options: {
    destinationId?: string;
    modelId?: string;
    clock?: () => number;
  } = {},
): Promise<AiAllowance> {
  validatePolicy(policy);
  const now = (options.clock ?? Date.now)(),
    day = new Date(now).toISOString().slice(0, 10),
    month = day.slice(0, 7);
  const rows = (
    await db
      .prepare(
        `SELECT b.scope,b.period_kind,b.documents,b.reserved_units,b.spent_units,b.reserved_usd_micros,b.spent_usd_micros,b.blocked FROM usage_buckets b WHERE ((b.scope='tenant' AND b.owner_key=?) OR (b.scope='global' AND b.owner_key='operator')) AND ((b.period_kind='day' AND b.period_start=?) OR (b.period_kind='month' AND b.period_start=?)) AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=? AND p.status='active')`,
      )
      .bind(tenant.userId, day, month, tenant.userId)
      .all<{
        scope: string;
        period_kind: string;
        documents: number;
        reserved_units: number;
        spent_units: number;
        reserved_usd_micros: number;
        spent_usd_micros: number;
        blocked: number;
      }>()
  ).results;
  const status = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') AS active,EXISTS(SELECT 1 FROM usage_buckets WHERE scope='global' AND blocked=1) AS global_blocked,EXISTS(SELECT 1 FROM usage_events WHERE user_id=? AND state='overrun') AS overrun,EXISTS(SELECT 1 FROM usage_events WHERE user_id=? AND destination_id=? AND model_id=? AND cooldown_until>?) OR EXISTS(SELECT 1 FROM hosted_ai_cooldowns hc JOIN ai_settings s ON s.user_id=? AND s.mode='hosted' AND s.provider_id=hc.destination_id AND s.model_id=hc.model_id WHERE hc.destination_id=? AND hc.model_id=? AND hc.cooldown_until>?) AS cooldown`,
    )
    .bind(
      tenant.userId,
      tenant.userId,
      tenant.userId,
      options.destinationId ?? "",
      options.modelId ?? "",
      now,
      tenant.userId,
      options.destinationId ?? "",
      options.modelId ?? "",
      now,
    )
    .first<{
      active: number;
      cooldown: number;
      overrun: number;
      global_blocked: number;
    }>();
  const daily = rows.find(
      (r) => r.scope === "tenant" && r.period_kind === "day",
    ),
    monthly = rows.find(
      (r) => r.scope === "tenant" && r.period_kind === "month",
    );
  function remainder(
    limit: number,
    row: typeof daily,
    field: "documents" | "units",
  ): number {
    return !status?.active || status.overrun || row?.blocked
      ? 0
      : Math.max(
          0,
          limit -
            (field === "documents"
              ? (row?.documents ?? 0)
              : (row?.reserved_units ?? 0) + (row?.spent_units ?? 0)),
        );
  }
  const funding = ["day", "month"].every((kind) => {
    const row = rows.find(
      (r) => r.scope === "global" && r.period_kind === kind,
    );
    const limit = micros(
      kind === "day"
        ? policy.globalDailyUsdMicros
        : policy.globalMonthlyUsdMicros,
    );
    return (
      !row?.blocked &&
      limit >
        BigInt(row?.reserved_usd_micros ?? 0) +
          BigInt(row?.spent_usd_micros ?? 0)
    );
  });
  return {
    dailyDocumentsRemaining: remainder(
      policy.dailyDocuments,
      daily,
      "documents",
    ),
    monthlyDocumentsRemaining: remainder(
      policy.monthlyDocuments,
      monthly,
      "documents",
    ),
    dailyUnitsRemaining: remainder(policy.dailyUnits, daily, "units"),
    monthlyUnitsRemaining: remainder(policy.monthlyUnits, monthly, "units"),
    hostedFundingAvailable:
      status?.active === 1 &&
      !status.overrun &&
      !status.global_blocked &&
      funding,
    cooldownActive: status?.cooldown === 1,
  };
}

export function readAiAllowance(
  db: D1Database,
  tenant: TenantContext,
  policy: AiBudgetPolicy,
  options: {
    destinationId?: string;
    modelId?: string;
    clock?: () => number;
  } = {},
): Promise<AiAllowance> {
  return budgetOperation(() => aiAllowance(db, tenant, policy, options));
}
