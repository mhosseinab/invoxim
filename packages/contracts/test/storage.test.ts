import { expect, it } from "vitest";
import {
  archiveDisableRequestSchema,
  archiveEnableRequestSchema,
  archiveSettingsViewSchema,
  storageConnectionViewSchema,
  storageDisconnectRequestSchema,
  storageStartRequestSchema,
} from "../src/storage";

it("separate storage consent accepts a verified connection without implying archiving", () => {
  expect(storageStartRequestSchema.safeParse({}).success).toBe(true);
  expect(
    storageConnectionViewSchema.safeParse({
      id: "synthetic-drive",
      provider: "google-drive",
      kind: "storage",
      address: "drive-d@example.test",
      state: "connected",
      generation: 1,
      credentialVersion: 1,
      configured: true,
      archivingEnabled: false,
    }).success,
  ).toBe(true);
});
it("explicit archive consent uses a separate version and selected destination", () => {
  expect(
    archiveSettingsViewSchema.safeParse({
      version: 0,
      enabled: false,
      connectionId: null,
      generation: null,
      disclosureVersion: null,
      acceptedAt: null,
    }).success,
  ).toBe(true);
  expect(
    archiveEnableRequestSchema.safeParse({
      expectedVersion: 0,
      connectionId: "synthetic-drive",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }).success,
  ).toBe(true);
  expect(
    archiveDisableRequestSchema.safeParse({ expectedVersion: 1 }).success,
  ).toBe(true);
  expect(
    storageDisconnectRequestSchema.safeParse({
      generation: 1,
      credentialVersion: 1,
    }).success,
  ).toBe(true);
});
it("storage commands reject request identity, stale-shaped consent and unknown fields", () => {
  for (const input of [
    { userId: "other" },
    { connectionId: "" },
    { connectionId: "x", enableArchiving: true },
  ])
    expect(storageStartRequestSchema.safeParse(input).success).toBe(false);
  expect(
    archiveEnableRequestSchema.safeParse({
      expectedVersion: 0,
      connectionId: "x",
      expectedGeneration: 0,
      disclosureVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    archiveEnableRequestSchema.safeParse({
      expectedVersion: 0,
      connectionId: "x",
      expectedGeneration: 1,
      disclosureVersion: 2,
    }).success,
  ).toBe(false);
});
