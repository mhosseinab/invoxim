import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { faultingDatabase, statementCounter } from "./faults";

const db = env.DB;

beforeAll(async () => {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS qa_faults(id TEXT PRIMARY KEY)")
    .run();
  await db.prepare("DELETE FROM qa_faults").run();
  await db.prepare("INSERT INTO qa_faults(id) VALUES('a'),('b')").run();
});

describe("faultingDatabase", () => {
  it("passes when the injected fault fires", async () => {
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        match: "SELECT id FROM qa_faults",
        on: "all",
        fire: async () => {
          throw new Error("INJECTED_FAULT");
        },
      },
    ]);
    await expect(
      faulted.prepare("SELECT id FROM qa_faults").all(),
    ).rejects.toThrow("INJECTED_FAULT");
    expect(() => assertFaultsFired()).not.toThrow();
  });

  it("fails the test when a deliberately unfired injector never sees its SQL (X7 disarm)", async () => {
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        match: "SELECT id FROM table_that_was_renamed",
        on: "all",
        fire: async () => {
          throw new Error("NEVER_REACHED");
        },
      },
    ]);
    // Run a different query: the injector is silently disarmed.
    await faulted.prepare("SELECT id FROM qa_faults").all();
    expect(() => assertFaultsFired()).toThrow(/FAULT_INJECTOR_NEVER_FIRED/);
  });

  it("fires on the Nth matching call when skip is set", async () => {
    const calls: string[] = [];
    const {
      db: faulted,
      assertFaultsFired,
      fireCounts,
    } = faultingDatabase(db, [
      {
        match: "SELECT id FROM qa_faults",
        on: "all",
        skip: 1,
        fire: async ({ proceed }) => {
          calls.push("fired");
          return proceed();
        },
      },
    ]);
    await faulted.prepare("SELECT id FROM qa_faults").all();
    expect(calls).toEqual([]);
    await faulted.prepare("SELECT id FROM qa_faults").all();
    expect(calls).toEqual(["fired"]);
    expect(fireCounts[0]).toBe(1);
    expect(() => assertFaultsFired()).not.toThrow();
  });

  it("fires once even when the matching statement runs repeatedly", async () => {
    let fires = 0;
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        match: "SELECT id FROM qa_faults",
        on: "all",
        fire: async ({ proceed }) => {
          fires++;
          return proceed();
        },
      },
    ]);
    await faulted.prepare("SELECT id FROM qa_faults").all();
    await faulted.prepare("SELECT id FROM qa_faults").all();
    expect(fires).toBe(1);
    expect(() => assertFaultsFired()).not.toThrow();
  });

  it("supports a predicate match and run interception", async () => {
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        match: (sql) => sql.includes("qa_faults"),
        on: "run",
        fire: async ({ proceed }) => {
          await proceed();
          throw new Error("AFTER_RUN_FAULT");
        },
      },
    ]);
    await expect(
      faulted.prepare("DELETE FROM qa_faults WHERE id='missing'").run(),
    ).rejects.toThrow("AFTER_RUN_FAULT");
    expect(() => assertFaultsFired()).not.toThrow();
    await db
      .prepare("INSERT OR IGNORE INTO qa_faults(id) VALUES('a'),('b')")
      .run();
  });

  it("supports prepare-time faults that throw synchronously", () => {
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        on: "prepare",
        fire: () => {
          throw new Error("PREPARE_FAULT");
        },
      },
    ]);
    expect(() => faulted.prepare("SELECT 1")).toThrow("PREPARE_FAULT");
    expect(() => assertFaultsFired()).not.toThrow();
  });

  it("matches a string batch rule against the batched statements' SQL text", async () => {
    let seen = "";
    const { db: faulted, assertFaultsFired } = faultingDatabase(db, [
      {
        match: "SELECT id FROM qa_faults WHERE id=?",
        on: "batch",
        fire: async ({ sql }) => {
          seen = sql;
          throw new Error("BATCH_FAULT");
        },
      },
    ]);
    await expect(
      faulted.batch([
        faulted.prepare("SELECT id FROM qa_faults WHERE id=?").bind("a"),
        faulted.prepare("SELECT id FROM qa_faults WHERE id='b'"),
      ]),
    ).rejects.toThrow("BATCH_FAULT");
    expect(seen).toBe(
      "SELECT id FROM qa_faults WHERE id=?;SELECT id FROM qa_faults WHERE id='b'",
    );
    expect(seen).not.toContain("[object Object]");
    expect(() => assertFaultsFired()).not.toThrow();
  });
});

describe("statementCounter", () => {
  it("counts every statement execution", async () => {
    const { db: counted, count } = statementCounter(db);
    await counted.prepare("SELECT id FROM qa_faults").all();
    await counted
      .prepare("SELECT id FROM qa_faults WHERE id=?")
      .bind("a")
      .first();
    expect(count()).toBe(2);
    await counted.batch([counted.prepare("SELECT id FROM qa_faults")]);
    expect(count()).toBe(3);
  });
});
