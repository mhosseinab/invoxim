/** One concrete D1 execution budget shared by all repositories in a Worker invocation. */
export function createInvocationDatabase(
  nativeDatabase: D1Database,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40)
    throw new Error("INVALID_DATABASE_QUERY_LIMIT");
  let executed = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function charge(count = 1): void {
    if (count > limit - executed) throw new Error("DATABASE_QUERY_BUDGET");
    executed += count;
  }
  function statement(native: D1PreparedStatement): D1PreparedStatement {
    async function first<T = Record<string, unknown>>(
      column?: string,
    ): Promise<T | null> {
      charge();
      return column === undefined ? native.first<T>() : native.first<T>(column);
    }
    async function raw<T = unknown[]>(options: {
      columnNames: true;
    }): Promise<[string[], ...T[]]>;
    async function raw<T = unknown[]>(options?: {
      columnNames?: false;
    }): Promise<T[]>;
    async function raw<T = unknown[]>(options?: {
      columnNames?: boolean;
    }): Promise<T[] | [string[], ...T[]]> {
      charge();
      return options?.columnNames
        ? native.raw<T>({ columnNames: true })
        : native.raw<T>();
    }
    const wrapped: D1PreparedStatement = {
      bind: (...values: unknown[]) => statement(native.bind(...values)),
      first,
      async all<T = Record<string, unknown>>() {
        charge();
        return native.all<T>();
      },
      async run<T = Record<string, unknown>>() {
        charge();
        return native.run<T>();
      },
      raw,
    };
    originals.set(wrapped, native);
    return wrapped;
  }
  async function batch<T>(
    native: D1Database | D1DatabaseSession,
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    // Charge the entire batch synchronously before native execution; never submit a prefix.
    charge(statements.length);
    return native.batch<T>(
      statements.map((value) => originals.get(value) ?? value),
    );
  }
  function session(native: D1DatabaseSession): D1DatabaseSession {
    return {
      prepare: (query) => statement(native.prepare(query)),
      batch: <T>(statements: D1PreparedStatement[]) =>
        batch<T>(native, statements),
      getBookmark: () => native.getBookmark(),
    };
  }
  const db: D1Database = {
    prepare: (query) => statement(nativeDatabase.prepare(query)),
    batch: <T>(statements: D1PreparedStatement[]) =>
      batch<T>(nativeDatabase, statements),
    withSession: (constraintOrBookmark) =>
      session(nativeDatabase.withSession(constraintOrBookmark)),
    async exec() {
      throw new Error("DATABASE_METHOD_UNSUPPORTED");
    },
    async dump() {
      throw new Error("DATABASE_METHOD_UNSUPPORTED");
    },
  };
  return {
    db,
    remainingStatements: () => limit - executed,
    executedStatements: () => executed,
  };
}
