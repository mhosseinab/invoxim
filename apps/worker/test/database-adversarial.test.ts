import { env } from "cloudflare:workers";
import type { SourceCommit } from "@invoxim/adapters";
import {
  createPurchaseRepository,
  createSourceRepository,
} from "@invoxim/adapters";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";

import { requireFixture } from "./fixture-value";

const db = env.DB;

const now = 1000;
// Synthetic authority only: the cast does not authenticate a real caller.
const context = (userId: string) =>
  ({ userId, authority: "job" }) as TenantContext;
const sources = createSourceRepository(db, () => now);
const purchases = createPurchaseRepository(db);
beforeAll(async () => {
  for (const sql of [baseline]) {
    for (const statement of sql.split(";").filter((part) => part.trim())) {
      await db.prepare(statement).run();
    }
  }
  for (const user of ["qa-a", "qa-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'active')",
      )
      .bind(`connection-${user}`, user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-model','synthetic-parser',1,0,1)",
      )
      .bind(`consent-${user}`, user, `connection-${user}`)
      .run();
  }
});
async function job(user: string, id: string, expires = now + 100) {
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,?,?,1,'extract',?,'leased',0,?,?,1)",
    )
    .bind(
      id,
      user,
      `connection-${user}`,
      `consent-${user}`,
      id,
      `lease-${id}`,
      expires,
    )
    .run();
}
function input(user: string, id: string): SourceCommit {
  return {
    jobId: id,
    leaseId: `lease-${id}`,
    fence: 1,
    connectionId: `connection-${user}`,
    generation: 1,
    source: {
      id: `source-${id}`,
      providerMessageId: `message-${id}`,
      receivedAt: 0,
    },
    document: {
      id: `document-${id}`,
      partKey: "attachment-1",
      contentHash: "a".repeat(64),
      mime: "application/pdf",
      byteLength: 20,
    },
    observation: {
      id: `observation-${id}`,
      fingerprint: "extract-v1",
      evidenceCode: "explicitly-paid",
    },
    purchase: {
      id: `purchase-${id}`,
      merchant: "Synthetic merchant",
      date: "2026-10-01",
      totalMinor: "1200",
      currency: "EUR",
      paymentState: "paid",
    },
    entries: [
      {
        id: `entry-${id}`,
        eventKey: `event-${id}`,
        kind: "payment",
        minor: "1200",
        currency: "EUR",
        date: "2026-10-01",
        eligible: true,
      },
    ],
  };
}
async function count(table: string, user: string, id: string) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=? AND id=?`)
    .bind(user, id)
    .first<number>("count");
}
it("DB-01 rejects cross-tenant document, ledger and evidence parent substitutions", async () => {
  for (const user of ["qa-a", "qa-b"]) {
    await job(user, `fk-${user}`);
    await sources.commit(context(user), input(user, `fk-${user}`));
  }
  await expect(
    db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('hostile-document','qa-a','source-fk-qa-b','part','hash','text/plain',1)",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE ledger_entries SET observation_id='observation-fk-qa-b' WHERE user_id='qa-a' AND id='entry-fk-qa-a'",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE purchase_evidence SET observation_id='observation-fk-qa-b' WHERE user_id='qa-a' AND purchase_id='purchase-fk-qa-a'",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("documents", "qa-a", "hostile-document")).toBe(0);
  expect(
    (await purchases.detail(context("qa-a"), "purchase-fk-qa-a"))?.evidence[0]
      ?.id,
  ).toBe("observation-fk-qa-a");
});
it("DB-04 scopes list, joined detail, update and delete to synthetic trusted context", async () => {
  for (const user of ["qa-a", "qa-b"]) {
    await job(user, `scope-${user}`);
    await sources.commit(context(user), input(user, `scope-${user}`));
  }
  const victim = "purchase-scope-qa-b";
  const before = await purchases.detail(context("qa-b"), victim);
  expect(
    (await purchases.list(context("qa-a"))).some((row) => row.id === victim),
  ).toBe(false);
  expect(await purchases.detail(context("qa-a"), victim)).toBeNull();
  expect(
    await purchases.updateMerchant(context("qa-a"), victim, 1, "Hostile edit"),
  ).toBe(false);
  expect(await purchases.delete(context("qa-a"), victim, 1)).toBe(false);
  expect(await purchases.detail(context("qa-b"), victim)).toEqual(before);
  const forged = input("qa-b", "scope-qa-b");
  expect(await sources.commit(context("qa-a"), forged)).toBe("stale");
});
it("DB-02 concurrent repeated source/part commits retain one identity and payment", async () => {
  await job("qa-a", "duplicate-first");
  await job("qa-a", "duplicate-second");
  const first = input("qa-a", "duplicate-first");
  const second = input("qa-a", "duplicate-second");
  second.source.providerMessageId = first.source.providerMessageId;
  second.purchase.id = first.purchase.id;
  second.entries = [
    { ...requireFixture(first.entries[0]), id: "duplicate-other-entry" },
  ];
  expect(
    await Promise.all([
      sources.commit(context("qa-a"), first),
      sources.commit(context("qa-a"), second),
    ]),
  ).toEqual(["committed", "committed"]);
  const identity = await db
    .prepare(
      "SELECT COUNT(DISTINCT s.id) AS sources,COUNT(DISTINCT d.id) AS documents,COUNT(DISTINCT o.id) AS observations FROM source_messages s JOIN documents d ON d.user_id=s.user_id AND d.source_message_id=s.id JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id WHERE s.user_id=? AND s.provider_message_id=?",
    )
    .bind("qa-a", first.source.providerMessageId)
    .first();
  expect(identity).toEqual({ sources: 1, documents: 1, observations: 1 });
  expect(
    await db
      .prepare(
        "SELECT s.processing_status,d.parse_state FROM source_messages s JOIN documents d ON d.user_id=s.user_id AND d.source_message_id=s.id WHERE s.user_id=? AND s.provider_message_id=?",
      )
      .bind("qa-a", first.source.providerMessageId)
      .first(),
  ).toEqual({ processing_status: "processed", parse_state: "extracted" });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count,CAST(SUM(amount_minor) AS TEXT) AS minor FROM ledger_entries WHERE user_id=? AND business_event_key=?",
      )
      .bind("qa-a", requireFixture(first.entries[0]).eventKey)
      .first(),
  ).toEqual({ count: 1, minor: "1200" });
  expect(await sources.commit(context("qa-a"), first)).toBe("stale");
  await job("qa-b", "duplicate-other-tenant");
  const other = input("qa-b", "duplicate-other-tenant");
  other.source.providerMessageId = first.source.providerMessageId;
  other.entries = [
    {
      ...requireFixture(other.entries[0]),
      eventKey: requireFixture(first.entries[0]).eventKey,
    },
  ];
  expect(await sources.commit(context("qa-b"), other)).toBe("committed");
  expect(await count("documents", "qa-b", other.document.id)).toBe(1);
});
it("DB-02 distinct concurrent sources cannot duplicate a ledger business event", async () => {
  const inputs = [input("qa-a", "event-first"), input("qa-a", "event-second")];
  requireFixture(inputs[1]).entries = [
    {
      ...requireFixture(requireFixture(inputs[1]).entries[0]),
      eventKey: requireFixture(requireFixture(inputs[0]).entries[0]).eventKey,
    },
  ];
  requireFixture(inputs[1]).purchase.id = requireFixture(inputs[0]).purchase.id;
  for (const item of inputs) await job("qa-a", item.jobId);
  await Promise.all(
    inputs.map((item) => sources.commit(context("qa-a"), item)),
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE user_id=? AND business_event_key=?",
      )
      .bind(
        "qa-a",
        requireFixture(requireFixture(inputs[0]).entries[0]).eventKey,
      )
      .first<number>("count"),
  ).toBe(1);
});
it("T04 reused event identity rejects changed amount without accepting new evidence", async () => {
  await job("qa-a", "conflict-original");
  const original = input("qa-a", "conflict-original");
  await sources.commit(context("qa-a"), original);
  await job("qa-a", "conflict-changed");
  const changed = input("qa-a", "conflict-changed");
  changed.purchase.id = original.purchase.id;
  changed.entries = [
    {
      ...requireFixture(changed.entries[0]),
      eventKey: requireFixture(original.entries[0]).eventKey,
      minor: "1300",
    },
  ];
  await expect(sources.commit(context("qa-a"), changed)).rejects.toThrow(
    "COMMIT_CONFLICT",
  );
  expect(await count("source_messages", "qa-a", changed.source.id)).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS minor FROM ledger_entries WHERE user_id=? AND business_event_key=?",
      )
      .bind("qa-a", requireFixture(original.entries[0]).eventKey)
      .first<string>("minor"),
  ).toBe("1200");
});
it("T04 fresh evidence cannot silently change canonical purchase financial facts", async () => {
  await job("qa-a", "purchase-original");
  const original = input("qa-a", "purchase-original");
  await sources.commit(context("qa-a"), original);
  const before = await purchases.detail(context("qa-a"), original.purchase.id);
  for (const field of ["total", "currency", "date", "state"]) {
    const changed = input("qa-a", `purchase-changed-${field}`);
    await job("qa-a", changed.jobId);
    changed.purchase.id = original.purchase.id;
    if (field === "total") changed.purchase.totalMinor = "1300";
    if (field === "currency") changed.purchase.currency = "USD";
    if (field === "date") changed.purchase.date = "2026-10-02";
    if (field === "state") changed.purchase.paymentState = "unpaid";
    await expect(sources.commit(context("qa-a"), changed)).rejects.toThrow(
      "COMMIT_CONFLICT",
    );
    expect(
      await purchases.detail(context("qa-a"), original.purchase.id),
    ).toEqual(before);
    expect(await count("source_messages", "qa-a", changed.source.id)).toBe(0);
    expect(
      await count(
        "ledger_entries",
        "qa-a",
        requireFixture(changed.entries[0]).id,
      ),
    ).toBe(0);
  }
});
it("T04 exact financial replay preserves a manual merchant edit and version", async () => {
  await job("qa-a", "manual-original");
  const original = input("qa-a", "manual-original");
  await sources.commit(context("qa-a"), original);
  expect(
    await purchases.updateMerchant(
      context("qa-a"),
      original.purchase.id,
      1,
      "Manual synthetic merchant",
    ),
  ).toBe(true);
  await job("qa-a", "manual-replay");
  const replay = {
    ...original,
    jobId: "manual-replay",
    leaseId: "lease-manual-replay",
  };
  expect(await sources.commit(context("qa-a"), replay)).toBe("committed");
  const saved = await purchases.detail(context("qa-a"), original.purchase.id);
  expect(saved?.purchase.merchant_raw).toBe("Manual synthetic merchant");
  expect(saved?.purchase.version).toBe(2);
  expect(saved?.purchase.total_minor).toBe("1200");
  expect(saved?.evidence).toHaveLength(1);
});
it("T04 same source part with changed content hash rejects conflicting replay", async () => {
  await job("qa-a", "hash-original");
  const original = input("qa-a", "hash-original");
  await sources.commit(context("qa-a"), original);
  await job("qa-a", "hash-changed");
  const changed = input("qa-a", "hash-changed");
  changed.source.providerMessageId = original.source.providerMessageId;
  changed.purchase.id = original.purchase.id;
  changed.document.contentHash = "b".repeat(64);
  changed.entries = [
    {
      ...requireFixture(original.entries[0]),
      id: requireFixture(changed.entries[0]).id,
    },
  ];
  await expect(sources.commit(context("qa-a"), changed)).rejects.toThrow(
    "COMMIT_CONFLICT",
  );
  expect(await count("documents", "qa-a", changed.document.id)).toBe(0);
  expect(
    await db
      .prepare("SELECT content_hash FROM documents WHERE user_id=? AND id=?")
      .bind("qa-a", original.document.id)
      .first<string>("content_hash"),
  ).toBe("a".repeat(64));
});
it("T04 same observation fingerprint rejects changed normalized merchant", async () => {
  await job("qa-a", "observation-original");
  const original = input("qa-a", "observation-original");
  await sources.commit(context("qa-a"), original);
  await job("qa-a", "observation-changed");
  const changed = input("qa-a", "observation-changed");
  changed.source.providerMessageId = original.source.providerMessageId;
  changed.purchase.id = original.purchase.id;
  changed.purchase.merchant = "Changed synthetic merchant";
  changed.entries = [
    {
      ...requireFixture(original.entries[0]),
      id: requireFixture(changed.entries[0]).id,
    },
  ];
  await expect(sources.commit(context("qa-a"), changed)).rejects.toThrow(
    "COMMIT_CONFLICT",
  );
  expect(
    (await purchases.detail(context("qa-a"), original.purchase.id))?.purchase
      .merchant_raw,
  ).toBe("Synthetic merchant");
  expect(await count("observations", "qa-a", changed.observation.id)).toBe(0);
});
it("T04 a needs-review observation cannot accept another financial commit", async () => {
  await job("qa-a", "review-original");
  const original = input("qa-a", "review-original");
  await sources.commit(context("qa-a"), original);
  await db
    .prepare(
      "UPDATE observations SET review_state='needs_review' WHERE user_id=? AND id=?",
    )
    .bind("qa-a", original.observation.id)
    .run();
  await job("qa-a", "review-replay");
  const replay = {
    ...original,
    jobId: "review-replay",
    leaseId: "lease-review-replay",
    entries: [
      {
        ...requireFixture(original.entries[0]),
        id: "review-new-entry",
        eventKey: "review-new-event",
      },
    ],
  };
  await expect(sources.commit(context("qa-a"), replay)).rejects.toThrow(
    "COMMIT_CONFLICT",
  );
  expect(await count("ledger_entries", "qa-a", "review-new-entry")).toBe(0);
  expect(
    await db
      .prepare("SELECT review_state FROM observations WHERE user_id=? AND id=?")
      .bind("qa-a", original.observation.id)
      .first<string>("review_state"),
  ).toBe("needs_review");
  expect(
    await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id='qa-a' AND id='review-replay'",
      )
      .first<string>("status"),
  ).toBe("leased");
  expect(
    await count(
      "ledger_entries",
      "qa-a",
      requireFixture(original.entries[0]).id,
    ),
  ).toBe(1);
});
it("T04 revoked, future or non-background consent prevents durable results", async () => {
  for (const condition of ["revoked", "future", "background"]) {
    const item = input("qa-a", `consent-${condition}`);
    await job("qa-a", item.jobId);
    await db
      .prepare(
        "UPDATE processing_consents SET revoked_at=?,accepted_at=?,background_authorized=? WHERE user_id='qa-a'",
      )
      .bind(
        condition === "revoked" ? now : null,
        condition === "future" ? now + 1 : 0,
        condition === "background" ? 0 : 1,
      )
      .run();
    expect(await sources.commit(context("qa-a"), item)).toBe("stale");
    expect(await count("source_messages", "qa-a", item.source.id)).toBe(0);
    expect(
      await count("ledger_entries", "qa-a", requireFixture(item.entries[0]).id),
    ).toBe(0);
    await db
      .prepare(
        "UPDATE processing_consents SET revoked_at=NULL,accepted_at=0,background_authorized=1 WHERE user_id='qa-a'",
      )
      .run();
  }
});
it("T04 concurrent event replay with a different purchase rejects phantom records", async () => {
  const inputs = [
    input("qa-a", "phantom-first"),
    input("qa-a", "phantom-second"),
  ];
  requireFixture(inputs[1]).entries = [
    {
      ...requireFixture(requireFixture(inputs[1]).entries[0]),
      eventKey: requireFixture(requireFixture(inputs[0]).entries[0]).eventKey,
    },
  ];
  for (const item of inputs) await job("qa-a", item.jobId);
  const results = await Promise.allSettled(
    inputs.map((item) => sources.commit(context("qa-a"), item)),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failures = results.filter((result) => result.status === "rejected");
  expect(failures).toHaveLength(1);
  expect(String(requireFixture(failures[0]).reason)).toContain(
    "COMMIT_CONFLICT",
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM purchases WHERE user_id=? AND id IN (?,?)",
      )
      .bind(
        "qa-a",
        requireFixture(inputs[0]).purchase.id,
        requireFixture(inputs[1]).purchase.id,
      )
      .first<number>("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_messages WHERE user_id=? AND id IN (?,?)",
      )
      .bind(
        "qa-a",
        requireFixture(inputs[0]).source.id,
        requireFixture(inputs[1]).source.id,
      )
      .first<number>("count"),
  ).toBe(1);
});
it("T04 late ledger conflict rolls back all prior financial and source writes", async () => {
  await job("qa-a", "rollback-existing");
  const existing = input("qa-a", "rollback-existing");
  await sources.commit(context("qa-a"), existing);
  await job("qa-a", "rollback-attempt");
  const attempt = input("qa-a", "rollback-attempt");
  attempt.entries = [
    requireFixture(attempt.entries[0]),
    {
      ...requireFixture(attempt.entries[0]),
      id: requireFixture(existing.entries[0]).id,
      eventKey: "rollback-conflict-event",
    },
  ];
  await expect(sources.commit(context("qa-a"), attempt)).rejects.toThrow();
  for (const [table, id] of [
    ["source_messages", attempt.source.id],
    ["documents", attempt.document.id],
    ["observations", attempt.observation.id],
    ["purchases", attempt.purchase.id],
    ["ledger_entries", requireFixture(attempt.entries[0]).id],
  ]) {
    expect(await count(requireFixture(table), "qa-a", requireFixture(id))).toBe(
      0,
    );
  }
  expect(
    await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id='qa-a' AND id='rollback-attempt'",
      )
      .first<string>("status"),
  ).toBe("leased");
  expect(
    await count(
      "ledger_entries",
      "qa-a",
      requireFixture(existing.entries[0]).id,
    ),
  ).toBe(1);
});
it("T04 stale lease, fence, expiry and connection generation never commit", async () => {
  for (const condition of ["lease", "fence", "expired", "generation"]) {
    const id = `stale-${condition}`;
    await job("qa-a", id, condition === "expired" ? now : now + 100);
    const item = input("qa-a", id);
    if (condition === "lease") item.leaseId = "old-lease";
    if (condition === "fence") item.fence = 0;
    if (condition === "generation") {
      await db
        .prepare("UPDATE connections SET generation=2 WHERE user_id='qa-a'")
        .run();
    }
    expect(await sources.commit(context("qa-a"), item)).toBe("stale");
    expect(await count("source_messages", "qa-a", item.source.id)).toBe(0);
    expect(await count("purchases", "qa-a", item.purchase.id)).toBe(0);
    expect(
      await count("ledger_entries", "qa-a", requireFixture(item.entries[0]).id),
    ).toBe(0);
    if (condition === "generation")
      await db
        .prepare("UPDATE connections SET generation=1 WHERE user_id='qa-a'")
        .run();
  }
});
