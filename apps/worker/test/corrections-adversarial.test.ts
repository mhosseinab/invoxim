import { env } from "cloudflare:workers";
import { createPurchaseViewReader } from "@invoxim/adapters";
import { correctionStateSchema } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createCorrectionStore } from "../../../packages/adapters/src/corrections/store";
import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import { createLifecycleRepository } from "../../../packages/adapters/src/lifecycle/repository";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
async function owner(id: string) {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    )
    .bind(id, "QA corrections", `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,0,0,?)",
    )
    .bind(`session-${id}`, `synthetic-token-${id}`, id)
    .run();
  return {
    tenant: { userId: id, authority: "session" } as TenantContext,
    sessionId: `session-${id}`,
  };
}
async function purchase(
  user: string,
  id: string,
  total = 10000,
  state = "unpaid",
) {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,category) VALUES(?,?,'QA merchant','qa merchant','2026-01-10',?,'EUR',?,'other')",
    )
    .bind(id, user, total, state)
    .run();
}
async function cash(
  user: string,
  purchaseId: string,
  id: string,
  amount: number,
  kind = "payment",
) {
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,NULL,?,?,?,'EUR','2026-01-10','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(id, user, purchaseId, id, kind, amount)
    .run();
}

async function source(user: string, purchaseId: string, id: string) {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,'mailbox','gmail',?,'mailbox@example.invalid')",
    )
    .bind(id, user, id)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,0,1)",
    )
    .bind(id, user, id, id)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(id, user, id, "a".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,?,1,'unknown','{\"schemaVersion\":1}','accepted')",
    )
    .bind(id, user, id, id)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
    )
    .bind(user, purchaseId, id)
    .run();
}
it("EDIT-01 gross and event corrections preserve cash identity and immutable original audit", async () => {
  const session = await owner("qa-edit-fields");
  await purchase(session.tenant.userId, "installment", 10000, "partially_paid");
  await cash(session.tenant.userId, "installment", "cash-one", 5000);
  const meter = createInvocationDatabase(env.DB, 40),
    store = createCorrectionStore(meter.db);
  await store.execute(
    session,
    {
      kind: "purchase-edit",
      purchaseId: "installment",
      request: { version: 1, changes: { totalMinor: "12000" } },
    },
    "qa-gross-command-1234",
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE user_id=? AND id='cash-one'",
      )
      .bind(session.tenant.userId)
      .first("amount_minor"),
  ).toBe(5000);
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "event-edit",
      entryId: "cash-one",
      request: { version: 1, changes: { amountMinor: "4500" } },
    },
    "qa-event-command-1234",
  );
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "purchase-edit",
      purchaseId: "installment",
      request: { version: 3, changes: { totalMinor: "13000" } },
    },
    "qa-second-gross-command",
  );
  expect(
    await db
      .prepare(
        "SELECT id,kind,amount_minor,version FROM ledger_entries WHERE user_id=?",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({
    id: "cash-one",
    kind: "payment",
    amount_minor: 4500,
    version: 2,
  });
  expect(
    await db
      .prepare(
        "SELECT original_value_json,value_json FROM field_overrides WHERE user_id=? AND field='totalMinor'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({ original_value_json: '"10000"', value_json: '"13000"' });
  expect(
    await db
      .prepare(
        "SELECT before_json,after_json FROM correction_audit WHERE user_id=? AND entity_kind='entry'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({ before_json: '"5000"', after_json: '"4500"' });
});
it("EDIT-02 native batch failure rolls back command, override, audit and projection together", async () => {
  const session = await owner("qa-edit-rollback");
  await purchase(session.tenant.userId, "rollback");
  await db
    .prepare(
      "CREATE TRIGGER qa_abort_correction BEFORE INSERT ON correction_audit WHEN NEW.user_id='qa-edit-rollback' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
    )
    .run();
  await expect(
    createCorrectionStore(db).execute(
      session,
      {
        kind: "purchase-edit",
        purchaseId: "rollback",
        request: { version: 1, changes: { totalMinor: "12000" } },
      },
      "qa-rollback-command-123",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    await db
      .prepare("SELECT total_minor,version FROM purchases WHERE user_id=?")
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({ total_minor: 10000, version: 1 });
  for (const table of [
    "correction_commands",
    "correction_audit",
    "field_overrides",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
});
it("EDIT-02 tenant and stale-version failures preserve the first accepted edit", async () => {
  const a = await owner("qa-edit-a"),
    b = await owner("qa-edit-b");
  await purchase(a.tenant.userId, "owned-a");
  await purchase(b.tenant.userId, "owned-b");
  const store = createCorrectionStore(db);
  await store.execute(
    a,
    {
      kind: "purchase-edit",
      purchaseId: "owned-a",
      request: { version: 1, changes: { category: "software" } },
    },
    "qa-first-edit-command",
  );
  await expect(
    store.execute(
      a,
      {
        kind: "purchase-edit",
        purchaseId: "owned-a",
        request: { version: 1, changes: { category: "other" } },
      },
      "qa-stale-edit-command",
    ),
  ).rejects.toThrow("CONFLICT");
  await expect(
    store.execute(
      b,
      {
        kind: "purchase-edit",
        purchaseId: "owned-a",
        request: { version: 2, changes: { category: "other" } },
      },
      "qa-foreign-edit-command",
    ),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    await db
      .prepare(
        "SELECT category,version FROM purchases WHERE user_id=? AND id='owned-a'",
      )
      .bind(a.tenant.userId)
      .first(),
  ).toEqual({ category: "software", version: 2 });
});
it("EDIT-03 explicit payment replay creates exactly one standalone user-confirmed cash fact", async () => {
  const session = await owner("qa-edit-confirm");
  await purchase(session.tenant.userId, "unpaid", 8000);
  const command = {
    kind: "cash-confirm" as const,
    purchaseId: "unpaid",
    entryKind: "payment" as const,
    request: {
      version: 1,
      confirmed: true as const,
      amountMinor: "8000",
      currency: "EUR",
      eventDate: "2026-10-12",
    },
  };
  const store = createCorrectionStore(db),
    first = await store.execute(session, command, "qa-payment-confirm-key");
  expect(
    await store.execute(session, command, "qa-payment-confirm-key"),
  ).toEqual(first);
  await expect(
    store.execute(
      session,
      { ...command, request: { ...command.request, amountMinor: "8100" } },
      "qa-payment-confirm-key",
    ),
  ).rejects.toThrow("CONFLICT");
  await expect(
    store.execute(session, command, "qa-second-tab-confirm-key"),
  ).rejects.toThrow("CONFLICT");
  expect(
    await db
      .prepare(
        "SELECT amount_minor,origin,observation_id,event_date FROM ledger_entries WHERE user_id=?",
      )
      .bind(session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      {
        amount_minor: 8000,
        origin: "user-confirmed",
        observation_id: null,
        event_date: "2026-10-12",
      },
    ],
  });
});
it("EDIT-04 merge and unmerge retain each exact cash identity and9000 net", async () => {
  const session = await owner("qa-edit-merge");
  await purchase(session.tenant.userId, "merge-target", 12000, "paid");
  await purchase(session.tenant.userId, "merge-source", 12000, "paid");
  await cash(session.tenant.userId, "merge-target", "unique-payment", 12000);
  await cash(
    session.tenant.userId,
    "merge-source",
    "unique-refund",
    3000,
    "refund",
  );
  await source(session.tenant.userId, "merge-target", "shared-observation");
  await source(
    session.tenant.userId,
    "merge-source",
    "same-content-observation",
  );
  const store = createCorrectionStore(db),
    result = await store.execute(
      session,
      {
        kind: "merge",
        request: {
          target: { id: "merge-target", version: 1 },
          source: { id: "merge-source", version: 1 },
        },
      },
      "qa-merge-command-key",
    );
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(2);
  if (!result.mergeId || !result.version)
    throw new Error("Missing successful merge identity");
  const sourceVersion = await db
    .prepare(
      "SELECT version FROM purchases WHERE user_id=? AND id='merge-source'",
    )
    .bind(session.tenant.userId)
    .first<number>("version");
  if (!sourceVersion) throw new Error("Missing source version");
  await store.execute(
    session,
    {
      kind: "unmerge",
      purchaseId: "merge-target",
      request: {
        mergeId: result.mergeId,
        version: result.version,
        sourceVersion,
      },
    },
    "qa-unmerge-command-key",
  );
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,amount_minor,kind FROM ledger_entries WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    {
      id: "unique-payment",
      purchase_id: "merge-target",
      amount_minor: 12000,
      kind: "payment",
    },
    {
      id: "unique-refund",
      purchase_id: "merge-source",
      amount_minor: 3000,
      kind: "refund",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT SUM(CASE kind WHEN 'payment' THEN amount_minor ELSE -amount_minor END) n FROM ledger_entries WHERE user_id=? AND eligible=1",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(9000);
});

it("EDIT-05 dismissing nonfinancial warning leaves missing currency blocked and valid other spending visible", async () => {
  const session = await owner("qa-edit-review");
  await purchase(session.tenant.userId, "blocked");
  await purchase(session.tenant.userId, "valid");
  await source(session.tenant.userId, "blocked", "review-source");
  await cash(session.tenant.userId, "blocked", "blocked-cash", 8000);
  await cash(session.tenant.userId, "valid", "valid-cash", 6000);
  await db
    .prepare(
      "UPDATE ledger_entries SET eligible=0 WHERE user_id=? AND id='blocked-cash'",
    )
    .bind(session.tenant.userId)
    .run();
  for (const [id, scope, reason, fields] of [
    ["category-warning", "operational", "extraction-review", null],
    [
      "missing-currency",
      "financial",
      "incomplete-financial-facts",
      '["currency"]',
    ],
  ] as const)
    await db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,missing_fields_json,created_at) VALUES(?,?,'review-source','review-source','blocked',?,?,?,0)",
      )
      .bind(id, session.tenant.userId, reason, scope, fields)
      .run();
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "review-resolve",
      reviewId: "category-warning",
      request: { version: 1, action: "dismiss-operational" },
    },
    "qa-category-dismiss-key",
  );
  expect(
    await db
      .prepare(
        "SELECT status FROM review_items WHERE user_id=? AND id='missing-currency'",
      )
      .bind(session.tenant.userId)
      .first("status"),
  ).toBe("open");
  expect(
    await db
      .prepare(
        "SELECT eligible FROM ledger_entries WHERE user_id=? AND id='blocked-cash'",
      )
      .bind(session.tenant.userId)
      .first("eligible"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT SUM(amount_minor) n FROM ledger_entries WHERE user_id=? AND eligible=1",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(6000);
});

it("EDIT-03 manually confirmed cash retains record and exact event after sole mailbox source deletion", async () => {
  const session = await owner("qa-edit-source-delete");
  await purchase(session.tenant.userId, "manually-supported", 8000);
  await source(session.tenant.userId, "manually-supported", "source-to-erase");
  const confirmed = await createCorrectionStore(db).execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "manually-supported",
      entryKind: "payment",
      request: {
        version: 1,
        confirmed: true,
        amountMinor: "8000",
        currency: "EUR",
        eventDate: "2026-10-12",
      },
    },
    "qa-source-confirmation-key",
  );
  const repo = createLifecycleRepository(db),
    lifecycleSession = { ...session, authenticatedAt: Date.now() };
  const preview = await repo.preview(session.tenant, "source-to-erase");
  expect(preview.purchasesRetained).toBe(1);
  expect(preview.purchasesRemoved).toBe(0);
  await repo.deleteData(
    lifecycleSession,
    "source-to-erase",
    { confirmed: true, generation: 1, previewFingerprint: preview.fingerprint },
    "qa-confirmed-source-delete",
  );
  const cleanup = createLifecycleCleanup(db, null);
  for (let unit = 0; unit < 50; unit++)
    if ((await cleanup.runOne()).status === "completed") break;
  expect(
    await db
      .prepare(
        "SELECT id,amount_minor,origin,observation_id FROM ledger_entries WHERE user_id=?",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({
    id: confirmed.entryId,
    amount_minor: 8000,
    origin: "user-confirmed",
    observation_id: null,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM documents WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("EDIT-02 old A workspace token cannot mutate B with colliding purchase ID/version; B current token works", async () => {
  const a = await owner("qa-token-a"),
    b = await owner("qa-token-b");
  await purchase(a.tenant.userId, "same-record");
  await purchase(b.tenant.userId, "same-record");
  await purchase(b.tenant.userId, "positive-b");
  const origin = "https://qa-correction.example.invalid",
    secret = "synthetic-correction-auth-secret-never-live-123";
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: origin,
    AUTH_SECRET: secret,
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: JSON.stringify([
      "qa-token-a@example.invalid",
      "qa-token-b@example.invalid",
    ]),
    CORRECTIONS_ENABLED: "true",
  };
  async function cookie(session: Awaited<ReturnType<typeof owner>>) {
    const token = `synthetic-token-${session.tenant.userId}`,
      key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(token),
    );
    return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  }
  const app = worker;
  async function request(
    session: Awaited<ReturnType<typeof owner>>,
    path: string,
    mutationToken?: string,
  ) {
    return app.fetch(
      new Request(`${origin}/api${path}`, {
        method: mutationToken ? "PATCH" : "GET",
        headers: {
          Cookie: await cookie(session),
          ...(mutationToken
            ? {
                Origin: origin,
                "Content-Type": "application/json",
                "Idempotency-Key": `qa-key-${path.replaceAll("/", "-")}`,
                "X-Workspace-Token": mutationToken,
              }
            : {}),
        },
        ...(mutationToken
          ? {
              body: JSON.stringify({
                version: 1,
                changes: { category: "software" },
              }),
            }
          : {}),
      }),
      bindings,
    );
  }
  const old = await request(a, "/purchases/same-record/corrections"),
    current = await request(b, "/purchases/same-record/corrections");
  expect(old.status).toBe(200);
  expect(current.status).toBe(200);
  const oldToken = correctionStateSchema.parse(await old.json()).mutationToken,
    currentToken = correctionStateSchema.parse(
      await current.json(),
    ).mutationToken;
  expect((await request(b, "/purchases/positive-b", currentToken)).status).toBe(
    200,
  );
  expect((await request(b, "/purchases/same-record", oldToken)).status).toBe(
    403,
  );
  expect(
    await db
      .prepare(
        "SELECT category,version FROM purchases WHERE user_id=? AND id='same-record'",
      )
      .bind(b.tenant.userId)
      .first(),
  ).toEqual({ category: "other", version: 1 });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM correction_audit WHERE user_id=? AND entity_id='same-record'",
      )
      .bind(b.tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("EDIT-01 account erasure purges correction audit and overrides in bounded native units", async () => {
  const session = await owner("qa-edit-account-erase");
  await purchase(session.tenant.userId, "edited-before-delete");
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "purchase-edit",
      purchaseId: "edited-before-delete",
      request: { version: 1, changes: { totalMinor: "12000" } },
    },
    "qa-before-account-key",
  );
  await db.batch(
    Array.from({ length: 104 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) VALUES(?,?,'purchase','edited-before-delete','field-corrected','0','1',0)",
        )
        .bind(`extra-audit-${index}`, session.tenant.userId),
    ),
  );
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'account',?,'qa-audit-erasure',0,0,1)",
    )
    .bind(session.tenant.userId, session.tenant.userId)
    .run();
  let previous = 105,
    complete = false;
  for (let unit = 0; unit < 80; unit++) {
    const meter = createInvocationDatabase(env.DB, 40),
      result = await createLifecycleCleanup(meter.db, null).runOne();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    const remaining = await db
      .prepare("SELECT COUNT(*) n FROM correction_audit WHERE user_id=?")
      .bind(session.tenant.userId)
      .first<number>("n");
    if (remaining === null) throw new Error("Missing audit row count");
    expect(previous - remaining).toBeLessThanOrEqual(100);
    previous = remaining;
    if (result.status === "completed") {
      complete = true;
      break;
    }
  }
  expect(complete).toBe(true);
  for (const table of [
    "correction_audit",
    "field_overrides",
    "correction_commands",
    "manual_purchase_evidence",
    "purchase_merges",
    "ledger_match_decisions",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  expect(
    await db
      .prepare('SELECT id FROM "user" WHERE id=?')
      .bind(session.tenant.userId)
      .first(),
  ).toBeNull();
});

it("EDIT-03 manual cash and corrected date remain readable and exportable with no source observation", async () => {
  const session = await owner("qa-edit-manual-reader");
  await purchase(session.tenant.userId, "manual-read", 8000);
  await cash(session.tenant.userId, "manual-read", "manual-readable", 8000);
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "event-edit",
      entryId: "manual-readable",
      request: { version: 1, changes: { eventDate: "2026-10-12" } },
    },
    "qa-correct-date-read-key",
  );
  const reader = createPurchaseViewReader(db);
  const detail = await reader.detail(session.tenant, "manual-read");
  expect(detail).toMatchObject({
    purchase: {
      lifecycle: [
        {
          currency: "EUR",
          paidMinor: "8000",
          refundedMinor: "0",
          netMinor: "8000",
        },
      ],
    },
    ledgerEntries: [
      {
        id: "manual-readable",
        observationId: null,
        origin: "user-confirmed",
        version: 2,
        dateBasis: "user-corrected-date",
      },
    ],
  });
  const exported = await reader.exportSnapshot(session.tenant);
  expect(exported.ledgerEntries).toMatchObject([
    {
      id: "manual-readable",
      observationId: null,
      origin: "user-confirmed",
      version: 2,
      dateBasis: "user-corrected-date",
    },
  ]);
  expect(Reflect.get(exported, "overrides")).toEqual(
    expect.arrayContaining([
      {
        entityKind: "entry",
        entityId: "manual-readable",
        field: "eventDate",
        originalValue: "2026-01-10",
        value: "2026-10-12",
        revision: 2,
      },
      {
        entityKind: "entry",
        entityId: "manual-readable",
        field: "dateBasis",
        originalValue: "user-confirmed-date",
        value: "user-corrected-date",
        revision: 2,
      },
    ]),
  );
});
it("EDIT-03 two distinct confirmed installments produce10000 cash and fully paid state without duplicate replay", async () => {
  const session = await owner("qa-edit-installments");
  await purchase(session.tenant.userId, "split-payment", 10000);
  const store = createCorrectionStore(db),
    firstCommand = {
      kind: "cash-confirm" as const,
      purchaseId: "split-payment",
      entryKind: "payment" as const,
      request: {
        version: 1,
        confirmed: true as const,
        amountMinor: "5000",
        currency: "EUR",
        eventDate: "2026-10-10",
      },
    };
  const first = await store.execute(
    session,
    firstCommand,
    "qa-installment-first-key",
  );
  expect(
    await db
      .prepare("SELECT payment_state FROM purchases WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("payment_state"),
  ).toBe("partially_paid");
  const second = await store.execute(
    session,
    {
      ...firstCommand,
      request: { ...firstCommand.request, version: 2, eventDate: "2026-10-12" },
    },
    "qa-installment-second-key",
  );
  expect(second.entryId).not.toBe(first.entryId);
  expect(
    await store.execute(session, firstCommand, "qa-installment-first-key"),
  ).toEqual(first);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) count,SUM(amount_minor) total FROM ledger_entries WHERE user_id=? AND kind='payment'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({ count: 2, total: 10000 });
  expect(
    await db
      .prepare("SELECT payment_state FROM purchases WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("payment_state"),
  ).toBe("paid");
});

it("EDIT-04 merge rejects a standalone refund200 into payment100 without changing graph cash versions or audits", async () => {
  const session = await owner("qa-edit-merge-over-refund");
  await purchase(session.tenant.userId, "paid-target", 100, "paid");
  await purchase(session.tenant.userId, "refund-source", 100, "unknown");
  await cash(session.tenant.userId, "paid-target", "known-pay-100", 100);
  await cash(
    session.tenant.userId,
    "refund-source",
    "standalone-refund-200",
    200,
    "refund",
  );
  const before = (
    await db
      .prepare(
        "SELECT id,purchase_id,amount_minor,kind,eligible,version FROM ledger_entries WHERE user_id=? ORDER BY id",
      )
      .bind(session.tenant.userId)
      .all()
  ).results;
  await expect(
    createCorrectionStore(db).execute(
      session,
      {
        kind: "merge",
        request: {
          target: { id: "paid-target", version: 1 },
          source: { id: "refund-source", version: 1 },
        },
      },
      "qa-invalid-merge-refund-key",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,amount_minor,kind,eligible,version FROM ledger_entries WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual(before);
  expect(
    (
      await db
        .prepare(
          "SELECT id,record_status,version FROM purchases WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { id: "paid-target", record_status: "active", version: 1 },
    { id: "refund-source", record_status: "active", version: 1 },
  ]);
  for (const table of [
    "correction_audit",
    "correction_commands",
    "purchase_merges",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
});

it("EDIT-04 compatible partial50 and partial50 merge to paid100 and unmerge restores exact identities and states", async () => {
  const session = await owner("qa-edit-merge-installments");
  await purchase(session.tenant.userId, "split-target", 100, "partially_paid");
  await purchase(session.tenant.userId, "split-source", 100, "partially_paid");
  await cash(session.tenant.userId, "split-target", "split-payment-a", 50);
  await cash(session.tenant.userId, "split-source", "split-payment-b", 50);
  const store = createCorrectionStore(db),
    merged = await store.execute(
      session,
      {
        kind: "merge",
        request: {
          target: { id: "split-target", version: 1 },
          source: { id: "split-source", version: 1 },
        },
      },
      "qa-partial-merge-key",
    );
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE user_id=? AND id='split-target'",
      )
      .bind(session.tenant.userId)
      .first("payment_state"),
  ).toBe("paid");
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,amount_minor FROM ledger_entries WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { id: "split-payment-a", purchase_id: "split-target", amount_minor: 50 },
    { id: "split-payment-b", purchase_id: "split-target", amount_minor: 50 },
  ]);
  if (!merged.mergeId || !merged.version)
    throw new Error("Missing merge result identity");
  const sourceVersion = await db
    .prepare(
      "SELECT version FROM purchases WHERE user_id=? AND id='split-source'",
    )
    .bind(session.tenant.userId)
    .first<number>("version");
  if (!sourceVersion) throw new Error("Missing merge source version");
  await store.execute(
    session,
    {
      kind: "unmerge",
      purchaseId: "split-target",
      request: {
        mergeId: merged.mergeId,
        version: merged.version,
        sourceVersion,
      },
    },
    "qa-partial-unmerge-key",
  );
  expect(
    (
      await db
        .prepare(
          "SELECT id,payment_state FROM purchases WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { id: "split-source", payment_state: "partially_paid" },
    { id: "split-target", payment_state: "partially_paid" },
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,amount_minor,eligible,origin FROM ledger_entries WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    {
      id: "split-payment-a",
      purchase_id: "split-target",
      amount_minor: 50,
      eligible: 1,
      origin: "user-confirmed",
    },
    {
      id: "split-payment-b",
      purchase_id: "split-source",
      amount_minor: 50,
      eligible: 1,
      origin: "user-confirmed",
    },
  ]);
});

it("EDIT-05 manually completing an unlinked review exposes owned source evidence before any reprocessing without inventing AI or cash", async () => {
  const session = await owner("qa-edit-manual-source-reader");
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('qa-manual-source-mailbox',?,'mailbox','gmail','qa-source-subject','qa-receipts@example.invalid')",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('qa-manual-source-message',?,'qa-manual-source-mailbox','qa-provider-source',0,1)",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,parse_state) VALUES('qa-manual-source-document',?,'qa-manual-source-message','body',?,'text/plain',10,'ready')",
    )
    .bind(session.tenant.userId, "b".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,status,created_at,missing_fields_json) VALUES('qa-manual-source-question',?,'qa-manual-source-document','incomplete-financial-facts','financial','open',0,'[\"merchant\",\"currency\",\"total\",\"documentDate\"]')",
    )
    .bind(session.tenant.userId)
    .run();
  const completed = await createCorrectionStore(db).execute(
    session,
    {
      kind: "review-resolve",
      reviewId: "qa-manual-source-question",
      request: {
        version: 1,
        action: "complete-record",
        record: {
          merchant: "QA user supplied record",
          documentDate: "2026-01-10",
          currency: "EUR",
          totalMinor: "1000",
          category: "shopping",
        },
      },
    },
    "qa-manual-source-read-key",
  );
  if (!completed.purchaseId)
    throw new Error("Manual completion did not create a record");
  const reader = createPurchaseViewReader(db),
    detail = await reader.detail(session.tenant, completed.purchaseId);
  expect(detail).toMatchObject({
    purchase: {
      origin: "user-supplied",
      documentTotalMinor: "1000",
      paymentState: "unknown",
    },
    timeline: [],
    ledgerEntries: [],
    manualEvidence: [
      {
        documentId: "qa-manual-source-document",
        provenance: "user-associated",
        source: {
          mailboxId: "qa-manual-source-mailbox",
          provider: "gmail",
          originalAvailable: false,
        },
      },
    ],
  });
  const exported = await reader.exportSnapshot(session.tenant);
  expect(exported.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        purchaseId: completed.purchaseId,
        documentId: "qa-manual-source-document",
        observationId: null,
        mailboxId: "qa-manual-source-mailbox",
        providerMessageId: "qa-provider-source",
        provenance: "user-associated",
        originalAvailable: false,
      }),
    ]),
  );
  for (const table of ["observations", "ledger_entries"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
});

it("EDIT-03/05 settling merged20+20 with one confirmed60 payment resolves both original allocation questions and replays once", async () => {
  const session = await owner("qa-edit-plural-allocation");
  for (const name of ["a", "b"]) {
    await purchase(
      session.tenant.userId,
      `allocation-${name}`,
      100,
      "partially_paid",
    );
    await source(
      session.tenant.userId,
      `allocation-${name}`,
      `allocation-source-${name}`,
    );
    await cash(
      session.tenant.userId,
      `allocation-${name}`,
      `source-payment-${name}`,
      20,
    );
    await db
      .prepare(
        "UPDATE observations SET evidence_code='explicitly-paid',structured_fields=? WHERE user_id=? AND id=?",
      )
      .bind(
        JSON.stringify({
          schemaVersion: 1,
          documentType: "receipt",
          record: {
            merchant: "QA merchant",
            documentDate: "2026-01-10",
            eventDate: "2026-01-10",
            currency: "EUR",
            total: "1.00",
            tax: null,
            invoiceNumber: null,
            orderReference: null,
            paymentReference: `PAY-${name}`,
            refundReference: null,
            category: "other",
            paymentEvidence: "explicitly-paid",
            refundEvidence: "none",
            paymentMethodHint: "card",
            recurringCadence: "unknown",
            paymentAmount: "0.20",
            refundAmount: null,
            storeCreditAmount: null,
            provenance: [],
          },
        }),
        session.tenant.userId,
        `allocation-source-${name}`,
      )
      .run();
    await db
      .prepare(
        "UPDATE ledger_entries SET origin='source',observation_id=? WHERE user_id=? AND id=?",
      )
      .bind(
        `allocation-source-${name}`,
        session.tenant.userId,
        `source-payment-${name}`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,?,?,?,'payment-allocation-review','financial','open',0)",
      )
      .bind(
        `allocation-question-${name}`,
        session.tenant.userId,
        `allocation-source-${name}`,
        `allocation-source-${name}`,
        `allocation-${name}`,
      )
      .run();
  }
  const store = createCorrectionStore(db),
    merged = await store.execute(
      session,
      {
        kind: "merge",
        request: {
          target: { id: "allocation-a", version: 1 },
          source: { id: "allocation-b", version: 1 },
        },
      },
      "qa-plural-allocation-merge",
    );
  if (!merged.version) throw new Error("Missing merged purchase version");
  const questions = (
    await db
      .prepare(
        "SELECT id,version,status,purchase_id FROM review_items WHERE user_id=? ORDER BY id",
      )
      .bind(session.tenant.userId)
      .all<{
        id: string;
        version: number;
        status: string;
        purchase_id: string;
      }>()
  ).results;
  expect(questions).toHaveLength(2);
  expect(
    questions.every(
      (question) =>
        question.status === "open" && question.purchase_id === "allocation-a",
    ),
  ).toBe(true);
  const chosen = questions[0];
  if (!chosen) throw new Error("Missing existing allocation question");
  const command = {
    kind: "cash-confirm" as const,
    purchaseId: "allocation-a",
    entryKind: "payment" as const,
    request: {
      version: merged.version,
      confirmed: true as const,
      amountMinor: "60",
      currency: "EUR",
      eventDate: "2026-01-10",
      review: { id: chosen.id, version: chosen.version },
    },
  };
  const confirmed = await store.execute(
    session,
    command,
    "qa-plural-allocation-pay",
  );
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE user_id=? AND id='allocation-a'",
      )
      .bind(session.tenant.userId)
      .first("payment_state"),
  ).toBe("paid");
  expect(
    (
      await db
        .prepare(
          "SELECT id,status FROM review_items WHERE user_id=? ORDER BY id",
        )
        .bind(session.tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { id: "allocation-question-a", status: "resolved" },
    { id: "allocation-question-b", status: "resolved" },
  ]);
  expect(
    await store.execute(session, command, "qa-plural-allocation-pay"),
  ).toEqual(confirmed);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM ledger_entries WHERE user_id=? AND amount_minor=60 AND origin='user-confirmed'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT SUM(amount_minor) n FROM ledger_entries WHERE user_id=? AND eligible=1 AND kind='payment'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(100);
});
