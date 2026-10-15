import { onTestFinished } from "vitest";

/**
 * Fault injectors keyed on SQL text prefixes silently disarm when a statement
 * is rewritten (X7). `faultingDatabase` fails the test when a registered fault
 * never fired, so a rewrite cannot quietly turn a fault test into a no-op.
 */

export type FaultMethod = "prepare" | "first" | "all" | "run" | "raw" | "batch";

export interface FaultContext {
  sql: string;
  args: readonly unknown[];
  /** Runs the original D1 call. Omit to replace the result entirely. */
  proceed: () => Promise<unknown>;
  /** The underlying native D1 database, for faults that need to run extra statements. */
  native: D1Database;
  /** The prepared statement being intercepted (not set for `prepare` faults). */
  statement?: D1PreparedStatement | undefined;
}

export interface FaultRule {
  /** Leading SQL prefix or predicate. Omit to match any statement. */
  match?: string | ((sql: string) => boolean);
  /** Which call to intercept. */
  on: FaultMethod;
  /** Let this many matching calls pass before firing. Default 0. */
  skip?: number;
  /** Fire only once after skip. Default true. */
  once?: boolean;
  /**
   * Inject the fault. May throw synchronously (typical for `prepare` faults)
   * or return a promise. `proceed` runs the original D1 call.
   */
  fire: (context: FaultContext) => unknown;
}

export interface FaultingDatabase {
  readonly db: D1Database;
  /** Throws if any rule never fired. Also runs automatically at test end. */
  assertFaultsFired(): void;
  /** Per-rule fire counts, index-aligned with the rules passed in. */
  readonly fireCounts: readonly number[];
}

function matches(rule: FaultRule, sql: string): boolean {
  if (rule.match === undefined) return true;
  if (typeof rule.match === "string") return sql.startsWith(rule.match);
  return rule.match(sql);
}

function unwrapStatements(
  statements: D1PreparedStatement[],
  originals: WeakMap<D1PreparedStatement, D1PreparedStatement>,
): D1PreparedStatement[] {
  return statements.map((s) => originals.get(s) ?? s);
}

export function faultingDatabase(
  native: D1Database,
  rules: readonly FaultRule[],
): FaultingDatabase {
  const fired = rules.map(() => 0);
  const seen = rules.map(() => 0);
  let asserted = false;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  /** SQL text of every statement prepared through this database (incl. bound). */
  const sqlText = new WeakMap<D1PreparedStatement, string>();
  function statementSql(statement: D1PreparedStatement): string {
    return (
      sqlText.get(statement) ??
      // A native statement prepared elsewhere still carries its SQL text.
      (statement as { statement?: unknown }).statement?.toString() ??
      ""
    );
  }

  function tryFire(
    ruleIndex: number,
    sql: string,
    args: readonly unknown[],
    proceed: () => Promise<unknown>,
    statement?: D1PreparedStatement,
  ): { fired: boolean; result?: unknown } {
    const rule = rules[ruleIndex];
    if (!rule) return { fired: false };
    const n = (seen[ruleIndex] ?? 0) + 1;
    seen[ruleIndex] = n;
    if (n <= (rule.skip ?? 0)) return { fired: false };
    if (rule.once !== false && (fired[ruleIndex] ?? 0) > 0)
      return { fired: false };
    fired[ruleIndex] = (fired[ruleIndex] ?? 0) + 1;
    return {
      fired: true,
      result: rule.fire({ sql, args, proceed, native, statement }),
    };
  }

  function wrapStatement(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    function wrap(inner: D1PreparedStatement): D1PreparedStatement {
      const wrapped: D1PreparedStatement = {
        bind: (...values: unknown[]) => wrap(inner.bind(...values)),
        first: (async (column?: string) => {
          const idx = rules.findIndex(
            (r) => r.on === "first" && matches(r, sql),
          );
          const proceed = () =>
            column === undefined ? inner.first() : inner.first(column);
          if (idx === -1) return proceed();
          const outcome = tryFire(idx, sql, [column], proceed, inner);
          return outcome.fired ? await outcome.result : proceed();
        }) as D1PreparedStatement["first"],
        all: (async () => {
          const idx = rules.findIndex((r) => r.on === "all" && matches(r, sql));
          const proceed = () => inner.all();
          if (idx === -1) return proceed();
          const outcome = tryFire(idx, sql, [], proceed, inner);
          return outcome.fired ? await outcome.result : proceed();
        }) as D1PreparedStatement["all"],
        run: (async () => {
          const idx = rules.findIndex((r) => r.on === "run" && matches(r, sql));
          const proceed = () => inner.run();
          if (idx === -1) return proceed();
          const outcome = tryFire(idx, sql, [], proceed, inner);
          return outcome.fired ? await outcome.result : proceed();
        }) as D1PreparedStatement["run"],
        raw: (async (options?: { columnNames?: boolean }) => {
          const idx = rules.findIndex((r) => r.on === "raw" && matches(r, sql));
          const proceed = () =>
            options?.columnNames
              ? inner.raw({ columnNames: true })
              : inner.raw();
          if (idx === -1) return proceed();
          const outcome = tryFire(idx, sql, [], proceed, inner);
          return outcome.fired ? await outcome.result : proceed();
        }) as D1PreparedStatement["raw"],
      };
      originals.set(wrapped, inner);
      sqlText.set(wrapped, sql);
      return wrapped;
    }
    return wrap(statement);
  }

  const db: D1Database = {
    prepare(query: string) {
      const idx = rules.findIndex(
        (r) => r.on === "prepare" && matches(r, query),
      );
      if (idx !== -1) {
        const rule = rules[idx];
        const n = (seen[idx] ?? 0) + 1;
        seen[idx] = n;
        if (
          rule &&
          n > (rule.skip ?? 0) &&
          (rule.once === false || (fired[idx] ?? 0) === 0)
        ) {
          fired[idx] = (fired[idx] ?? 0) + 1;
          // Synchronous throws from fire propagate out of prepare().
          return rule.fire({
            sql: query,
            args: [],
            proceed: () => Promise.resolve(native.prepare(query)),
            native,
          }) as unknown as D1PreparedStatement;
        }
      }
      return wrapStatement(native.prepare(query), query);
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      const sql = statements.map(statementSql).join(";");
      const idx = rules.findIndex((r) => r.on === "batch" && matches(r, sql));
      const unwrapped = unwrapStatements(statements, originals);
      const proceed = () =>
        native.batch<T>(unwrapped as Parameters<D1Database["batch"]>[0]);
      if (idx === -1) return proceed();
      const outcome = tryFire(idx, sql, unwrapped, proceed);
      return (outcome.fired ? outcome.result : proceed()) as Promise<
        D1Result<T>[]
      >;
    },
    withSession(constraintOrBookmark?: string | D1SessionConstraint) {
      return native.withSession(constraintOrBookmark);
    },
    exec: (query: string) => native.exec(query),
    dump: () => native.dump(),
  };

  function assertFaultsFired(): void {
    asserted = true;
    const unfired = rules
      .map((rule, i) => ({ rule, i, count: fired[i] }))
      .filter((entry) => entry.count === 0);
    if (unfired.length > 0) {
      const detail = unfired
        .map(
          ({ rule, i }) =>
            `rule[${i}] on=${rule.on} match=${
              typeof rule.match === "string"
                ? JSON.stringify(rule.match)
                : "<predicate>"
            }`,
        )
        .join(", ");
      throw new Error(
        `FAULT_INJECTOR_NEVER_FIRED: ${detail} — the SQL may have been rewritten so the injector is disarmed (X7)`,
      );
    }
  }

  // Fail the test automatically when the injector is disarmed (G3).
  try {
    onTestFinished(() => {
      if (!asserted) assertFaultsFired();
    });
  } catch {
    // Called outside a test (e.g. beforeAll); the caller must assert manually.
  }

  return { db, assertFaultsFired, fireCounts: fired };
}

/**
 * Counts every D1 statement execution. Used where a suite asserts an exact or
 * bounded statement count (X5/X8). Distinct from the invocation budget meter.
 */
export function statementCounter(native: D1Database): {
  db: D1Database;
  count: () => number;
} {
  let executed = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(inner: D1PreparedStatement): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values: unknown[]) => wrap(inner.bind(...values)),
      first: (async (column?: string) => {
        executed++;
        return column === undefined ? inner.first() : inner.first(column);
      }) as D1PreparedStatement["first"],
      all: (async () => {
        executed++;
        return inner.all();
      }) as D1PreparedStatement["all"],
      run: (async () => {
        executed++;
        return inner.run();
      }) as D1PreparedStatement["run"],
      raw: (async (options?: { columnNames?: boolean }) => {
        executed++;
        return options?.columnNames
          ? inner.raw({ columnNames: true })
          : inner.raw();
      }) as D1PreparedStatement["raw"],
    };
    originals.set(wrapped, inner);
    return wrapped;
  }
  const db: D1Database = {
    prepare: (query) => wrap(native.prepare(query)),
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      executed += statements.length;
      return native.batch<T>(
        unwrapStatements(statements, originals) as Parameters<
          D1Database["batch"]
        >[0],
      );
    },
    withSession: (c) => native.withSession(c),
    exec: (query: string) => native.exec(query),
    dump: () => native.dump(),
  };
  return { db, count: () => executed };
}
