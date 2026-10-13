import { expect, it } from "vitest";
import config from "../../../config/app.example.json";
import {
  acceptedLedgerEntrySchema,
  configSchema,
  processingDisclosureSchema,
  projectPublicConfig,
  publicConfigSchema,
  purchaseDisplaySchema,
  startImportSchema,
} from "../src/index";

const start = {
  connectionId: "connection-1",
  expectedConnectionGeneration: 1,
  expectedAiSettingsRevision: 1,
  acceptedDisclosureVersion: "d-1",
  startDate: "2025-10-11",
  endDate: "2026-10-11",
  timezone: "Europe/Vienna",
  reportingCurrency: "EUR",
  authorizeHourlySync: true,
};
it("PRESENT-03 accepts bounded start review but not forged authority", () => {
  expect(startImportSchema.safeParse(start).success).toBe(true);
  for (const extra of [
    { userId: "other" },
    { baseUrl: "https://evil.example" },
    { canStartImport: true },
  ])
    expect(startImportSchema.safeParse({ ...start, ...extra }).success).toBe(
      false,
    );
  for (const changes of [
    { authorizeHourlySync: false },
    { startDate: "2026-02-30" },
    { reportingCurrency: "XYZ" },
    { timezone: "invalid" },
    { startDate: "2027-01-01" },
  ])
    expect(startImportSchema.safeParse({ ...start, ...changes }).success).toBe(
      false,
    );
});
it("PRESENT-03 public projection excludes operator/tenant data and fails closed", () => {
  const projected = projectPublicConfig(configSchema.parse(config), {});
  expect(publicConfigSchema.safeParse(projected).success).toBe(true);
  expect(projected).toMatchObject({
    displayName: "Inbox Ledger",
    demoEnabled: false,
    mailProviders: [],
    features: {
      outlook: false,
      driveArchive: false,
      recurring: false,
      useTags: false,
    },
  });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    "secretRef",
    "baseUrl",
    "operatorDaily",
    "userId",
    "hosted",
  ])
    expect(serialized).not.toContain(forbidden);
  expect(
    publicConfigSchema.safeParse({ ...(projected as object), secretRef: "x" })
      .success,
  ).toBe(false);
});
it("PRESENT-03 current disclosure has bounded actual destination and nullable allowance", () => {
  const disclosure = {
    disclosureVersion: "d-1",
    aiSettingsRevision: 1,
    connectionId: "connection-1",
    connectionGeneration: 1,
    mailboxAddress: "synthetic@example.invalid",
    startDate: "2025-10-11",
    endDate: "2026-10-11",
    timezone: "Europe/Vienna",
    reportingCurrency: "EUR",
    inference: {
      providerId: "approved",
      model: "model",
      mode: "hosted",
      ready: true,
      policyVersion: "policy-1",
    },
    documentConversion: {
      providerId: "local-text",
      ready: true,
      policyVersion: "policy-1",
    },
    retentionNoticeVersion: "r-1",
    remainingDocuments: null,
    allowanceResetAt: null,
  };
  expect(processingDisclosureSchema.safeParse(disclosure).success).toBe(true);
  expect(
    processingDisclosureSchema.safeParse({
      ...disclosure,
      remainingDocuments: -1,
    }).success,
  ).toBe(false);
  expect(
    processingDisclosureSchema.safeParse({
      ...disclosure,
      inference: { ...disclosure.inference, baseUrl: "evil" },
    }).success,
  ).toBe(false);
});
it("ready flags cannot enable configured disabled capabilities; enabled reviewed demo only", () => {
  const validated = configSchema.parse(config);
  expect(
    projectPublicConfig(validated, {
      demo: true,
      gmail: true,
      outlook: true,
      driveArchive: true,
      recurring: true,
      useTags: true,
    }),
  ).toMatchObject({
    demoEnabled: true,
    mailProviders: ["gmail"],
    features: {
      outlook: false,
      driveArchive: false,
      recurring: false,
      useTags: false,
    },
  });
  expect(
    projectPublicConfig(
      { ...validated, product: { ...validated.product, demoEnabled: false } },
      { demo: true },
    ).demoEnabled,
  ).toBe(false);
});

it("malformed DTO money returns validation issues without throwing", () => {
  for (const minor of ["not-money", "1.2", "", "-1", "9000000000001"]) {
    expect(
      acceptedLedgerEntrySchema.safeParse({
        kind: "payment",
        minor,
        currency: "EUR",
        date: "2026-01-01",
        eligible: true,
      }).success,
    ).toBe(false);
    expect(
      purchaseDisplaySchema.safeParse({
        id: "p",
        merchant: null,
        date: null,
        currency: "EUR",
        documentTotalMinor: minor,
        paidMinor: null,
        refundedMinor: null,
        netMinor: null,
        evidenceCount: 0,
        paymentState: "unknown",
        originalAvailable: false,
      }).success,
    ).toBe(false);
  }
});
it("start requires IANA timezone, not a fixed offset without DST rules", () => {
  for (const timezone of ["+02:00", "-08:00"])
    expect(startImportSchema.safeParse({ ...start, timezone }).success).toBe(
      false,
    );
  expect(
    startImportSchema.safeParse({ ...start, timezone: "UTC" }).success,
  ).toBe(true);
});
