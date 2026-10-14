import { expect, it } from "vitest";
import config from "../../../config/app.example.json";
import {
  configSchema,
  projectPublicConfig,
  publicConfigSchema,
} from "../src/index";

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
