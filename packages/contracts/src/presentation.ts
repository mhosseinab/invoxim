import { z } from "zod";
import type { AppConfig } from "./designs";
import { configSchema } from "./designs";
import {
  MINOR_BOUND,
  connectionIdSchema,
  dateSchema as date,
  generationSchema as revision,
  supportedCurrency,
  validTimezone,
} from "./primitives";

const identifier = connectionIdSchema;
const timezone = z
  .string()
  .min(1)
  .max(80)
  .refine(validTimezone, "Invalid timezone");
const currency = supportedCurrency;
const range = {
  startDate: date,
  endDate: date,
  timezone,
  reportingCurrency: currency,
};
/** Shape validation only: server-owned resource/consent checks remain mandatory. */
export const startImportSchema = z
  .strictObject({
    connectionId: identifier,
    expectedConnectionGeneration: revision,
    expectedAiSettingsRevision: revision,
    acceptedDisclosureVersion: identifier,
    ...range,
    authorizeHourlySync: z.literal(true),
  })
  .refine((value) => value.startDate <= value.endDate, "Invalid range");
const inference = z.strictObject({
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(200),
  mode: z.enum(["hosted", "byok"]),
  ready: z.boolean(),
  policyVersion: identifier,
});
const converter = z.strictObject({
  providerId: z.string().min(1).max(80),
  ready: z.boolean(),
  policyVersion: identifier,
});
export const processingDisclosureSchema = z
  .strictObject({
    disclosureVersion: identifier,
    aiSettingsRevision: revision,
    connectionId: identifier,
    connectionGeneration: revision,
    mailboxAddress: z.email().max(254),
    ...range,
    inference,
    documentConversion: converter,
    retentionNoticeVersion: identifier,
    remainingDocuments: z.number().int().min(0).max(100000).nullable(),
    allowanceResetAt: z.iso.datetime().nullable(),
  })
  .refine((value) => value.startDate <= value.endDate, "Invalid range");
export const publicConfigSchema = z.strictObject({
  displayName: z.string().min(1).max(80),
  signupMode: z.enum(["allowlist", "public"]),
  demoEnabled: z.boolean(),
  loginEnabled: z.boolean(),
  mailProviders: z.array(z.enum(["gmail", "outlook"])).max(2),
  features: z.strictObject({
    outlook: z.boolean(),
    driveArchive: z.boolean(),
    recurring: z.boolean(),
    useTags: z.boolean(),
  }),
  policyRoutes: z.strictObject({
    privacy: z.literal("/privacy").nullable(),
    terms: z.literal("/terms").nullable(),
  }),
});
/** Readiness is trusted operator/backend input. Missing/unknown values fail closed. */
export interface CapabilityReadiness {
  demo?: boolean;
  login?: boolean;
  publicSignup?: boolean;
  gmail?: boolean;
  outlook?: boolean;
  driveArchive?: boolean;
  recurring?: boolean;
  useTags?: boolean;
  privacy?: boolean;
  terms?: boolean;
}
export function projectPublicConfig(
  input: AppConfig,
  readiness: CapabilityReadiness,
): PublicConfig {
  const config = configSchema.parse(input);
  const outlook = config.product.features.outlook && readiness.outlook === true;
  return publicConfigSchema.parse({
    displayName: config.product.displayName,
    signupMode:
      config.publicSignupEnabled &&
      config.signupMode === "public" &&
      readiness.publicSignup === true
        ? "public"
        : "allowlist",
    demoEnabled: config.product.demoEnabled && readiness.demo === true,
    loginEnabled: readiness.login === true,
    mailProviders: config.mail.providers.filter((provider) =>
      provider === "gmail" ? readiness.gmail === true : outlook,
    ),
    features: {
      outlook,
      driveArchive:
        config.product.features.driveArchive && readiness.driveArchive === true,
      recurring:
        config.product.features.recurring && readiness.recurring === true,
      useTags: config.product.features.useTags && readiness.useTags === true,
    },
    policyRoutes: {
      privacy: readiness.privacy === true ? "/privacy" : null,
      terms: readiness.terms === true ? "/terms" : null,
    },
  });
}
export type PublicConfig = z.infer<typeof publicConfigSchema>;
export type StartImport = z.infer<typeof startImportSchema>;
export type ProcessingDisclosure = z.infer<typeof processingDisclosureSchema>;
const minorString = z
  .string()
  .max(100)
  .regex(/^(0|[1-9][0-9]*)$/);
const signedMinorString = z
  .string()
  .max(101)
  .regex(/^(0|-?[1-9][0-9]*)$/);
const boundedMinorString = minorString.pipe(
  z
    .string()
    .refine((value) => BigInt(value) <= MINOR_BOUND, "Amount out of range"),
);
export const acceptedLedgerEntrySchema = z.strictObject({
  kind: z.enum(["payment", "refund"]),
  minor: boundedMinorString,
  currency,
  date,
  eligible: z.boolean(),
});
export const purchaseDisplaySchema = z.strictObject({
  id: identifier,
  merchant: z.string().max(200).nullable(),
  date: date.nullable(),
  currency,
  documentTotalMinor: boundedMinorString.nullable(),
  paidMinor: minorString.nullable(),
  refundedMinor: minorString.nullable(),
  netMinor: signedMinorString.nullable(),
  evidenceCount: z.number().int().min(0).max(100000),
  paymentState: z.enum(["unknown", "unpaid", "partially_paid", "paid"]),
  originalAvailable: z.boolean(),
});
export type PurchaseDisplay = z.infer<typeof purchaseDisplaySchema>;
