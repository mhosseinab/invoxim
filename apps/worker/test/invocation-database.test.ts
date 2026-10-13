import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

beforeAll(async () => {
  await db.prepare("CREATE TABLE budget_probe(id TEXT PRIMARY KEY)").run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM budget_probe").run();
});
it("enforces one budget across bindings and executing statement methods", async () => {
  const budget = createInvocationDatabase(env.DB, 2);
  const statement = budget.db.prepare("INSERT INTO budget_probe(id) VALUES(?)");
  await statement.bind("one").run();
  await statement.bind("two").run();
  await expect(statement.bind("three").run()).rejects.toThrow(
    "DATABASE_QUERY_BUDGET",
  );
  expect(budget.executedStatements()).toBe(2);
  expect(budget.remainingStatements()).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM budget_probe")
      .first("count"),
  ).toBe(2);
});
it("rejects an over-budget batch before any statement commits", async () => {
  const budget = createInvocationDatabase(env.DB, 1);
  await expect(
    budget.db.batch([
      budget.db.prepare("INSERT INTO budget_probe(id) VALUES('one')"),
      budget.db.prepare("INSERT INTO budget_probe(id) VALUES('two')"),
    ]),
  ).rejects.toThrow("DATABASE_QUERY_BUDGET");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM budget_probe")
      .first("count"),
  ).toBe(0);
});

it("charges first/all/raw exactly once while preparation and binding cost nothing", async () => {
  const budget = createInvocationDatabase(env.DB, 4);
  const prepared = budget.db.prepare("SELECT ? AS value");
  const one = prepared.bind("synthetic");
  expect(budget.executedStatements()).toBe(0);
  expect(await one.first<string>("value")).toBe("synthetic");
  expect(await one.first<{ value: string }>()).toEqual({ value: "synthetic" });
  expect((await one.all<{ value: string }>()).results).toEqual([
    { value: "synthetic" },
  ]);
  expect(await one.raw({ columnNames: true })).toEqual([
    ["value"],
    ["synthetic"],
  ]);
  expect(budget.executedStatements()).toBe(4);
  await expect(one.raw()).rejects.toThrow("DATABASE_QUERY_BUDGET");
});
it("native sessions and batches share the invocation counter and preserve bookmark access", async () => {
  const budget = createInvocationDatabase(env.DB, 3);
  const session = budget.db.withSession("first-primary");
  const initial = session.getBookmark();
  expect(initial === null || typeof initial === "string").toBe(true);
  await session
    .prepare("INSERT INTO budget_probe(id) VALUES('session-one')")
    .run();
  await session.batch([
    session.prepare("INSERT INTO budget_probe(id) VALUES('session-two')"),
    budget.db.prepare("INSERT INTO budget_probe(id) VALUES('database-three')"),
  ]);
  const bookmark = session.getBookmark();
  expect(bookmark === null || typeof bookmark === "string").toBe(true);
  expect(budget.executedStatements()).toBe(3);
  await expect(
    budget.db
      .prepare("INSERT INTO budget_probe(id) VALUES('denied-four')")
      .run(),
  ).rejects.toThrow("DATABASE_QUERY_BUDGET");
  await expect(
    budget.db
      .withSession(bookmark ?? "first-unconstrained")
      .prepare("INSERT INTO budget_probe(id) VALUES('denied-session')")
      .run(),
  ).rejects.toThrow("DATABASE_QUERY_BUDGET");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM budget_probe")
      .first("count"),
  ).toBe(3);
});
it("parallel operations cannot exceed the shared synchronous charge", async () => {
  const budget = createInvocationDatabase(env.DB, 1);
  const results = await Promise.allSettled([
    budget.db
      .prepare("INSERT INTO budget_probe(id) VALUES('parallel-one')")
      .run(),
    budget.db
      .prepare("INSERT INTO budget_probe(id) VALUES('parallel-two')")
      .run(),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(budget.executedStatements()).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM budget_probe")
      .first("count"),
  ).toBe(1);
});
it("unsupported bulk methods fail closed and validation exposes no SQL or bound values", async () => {
  for (const limit of [0, -1, 1.5, 41, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => createInvocationDatabase(env.DB, limit)).toThrow(
      "INVALID_DATABASE_QUERY_LIMIT",
    );
  const budget = createInvocationDatabase(env.DB, 1);
  await expect(
    budget.db.exec("INSERT INTO budget_probe(id) VALUES('unsupported-exec')"),
  ).rejects.toThrow("DATABASE_METHOD_UNSUPPORTED");
  await expect(budget.db.dump()).rejects.toThrow("DATABASE_METHOD_UNSUPPORTED");
  expect(budget.executedStatements()).toBe(0);
  await budget.db.prepare("SELECT 1").run();
  const failure = await budget.db
    .prepare("INSERT INTO budget_probe(id) VALUES(?)")
    .bind("synthetic-secret-marker")
    .run()
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error))
    throw new Error("Expected safe budget error");
  expect(failure.message).toBe("DATABASE_QUERY_BUDGET");
  expect(String(failure.stack)).not.toMatch(
    /synthetic-secret-marker|INSERT INTO|budget_probe/,
  );
});
