import { z } from "zod";
import { onboardingViewSchema } from "./designs";
import {
  MINOR_BOUND,
  hasControlCharacters,
  supportedCurrency,
  validCalendarDate,
  validTimezone,
} from "./primitives";

const id = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
const date = z.string().refine(validCalendarDate);
const version = z.number().int().min(0).max(2147483646);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number(MINOR_BOUND));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timezone = z.string().max(80).refine(validTimezone);
const currency = supportedCurrency;
export const onboardingQuerySchema = z.strictObject({
  connectionId: id.optional(),
});
export const processingDisclosureQuerySchema = z
  .strictObject({
    connectionId: id,
    startDate: date.optional(),
    endDate: date.optional(),
    timezone: timezone.optional(),
    reportingCurrency: currency.optional(),
  })
  .refine(
    (value) =>
      !value.startDate || !value.endDate || value.startDate <= value.endDate,
  );
export const onboardingStartRequestSchema = z
  .strictObject({
    connectionId: id,
    expectedConnectionGeneration: generation,
    expectedAiSettingsRevision: version,
    expectedProfileVersion: generation,
    acceptedDisclosureVersion: digest,
    reviewToken: z.string().min(1).max(4096),
    startDate: date,
    endDate: date,
    timezone,
    reportingCurrency: currency,
    authorizeHourlySync: z.literal(true),
  })
  .refine((value) => value.startDate <= value.endDate);
export type OnboardingStartRequest = z.infer<
  typeof onboardingStartRequestSchema
>;
export type ProcessingDisclosureQuery = z.infer<
  typeof processingDisclosureQuerySchema
>;
const policyText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
const notice = z.strictObject({
  id,
  displayName: policyText(120),
  dataUseSummary: policyText(400),
  retentionSummary: policyText(400),
  privacyUrl: z
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !hasControlCharacters(value)
        );
      } catch {
        return false;
      }
    }),
});
const inference = z.strictObject({
  providerId: id,
  model: id,
  mode: z.enum(["hosted", "byok"]),
  policyVersion: generation,
  notices: z.array(notice).max(10),
  noticeRefs: z.array(id).min(1).max(10),
  ready: z.boolean(),
});
const parser = z.strictObject({
  providerId: id,
  version: id,
  policyVersion: id,
  noticeRefs: z.array(id).min(1).max(10),
  ready: z.boolean(),
});
const allowance = z.strictObject({
  dailyDocumentsRemaining: count,
  monthlyDocumentsRemaining: count,
  dailyUnitsRemaining: count,
  monthlyUnitsRemaining: count,
  hostedFundingAvailable: z.boolean(),
  cooldownActive: z.boolean(),
  dailyResetAt: z.iso.datetime(),
  monthlyResetAt: z.iso.datetime(),
});
export const onboardingDisclosureSchema = z.strictObject({
  disclosureVersion: digest,
  configurationDigest: digest,
  reviewToken: z.string().min(1).max(4096),
  expiresAt: z.iso.datetime(),
  connectionId: id,
  connectionGeneration: generation,
  mailboxAddress: z.email().max(254),
  loginEmail: z.email().max(254),
  profileVersion: generation,
  aiSettingsRevision: version,
  selectedAiSettingsRevision: generation,
  startDate: date,
  endDate: date,
  startAt: z.iso.datetime(),
  cutoffAt: z.iso.datetime(),
  timezone,
  reportingCurrency: currency,
  inference,
  documentConversion: parser,
  classification: inference.optional(),
  allowance: allowance.nullable(),
  canStartImport: z.boolean(),
  availability: z.enum([
    "ready",
    "configuration",
    "budget",
    "rate-limit",
    "permission",
    "connection",
  ]),
  retentionNoticeVersion: id,
  authorizeHourlySync: z.literal(true),
});
export type OnboardingDisclosure = z.infer<typeof onboardingDisclosureSchema>;
export const onboardingResponseSchema = z.strictObject({
  view: onboardingViewSchema,
  login: z.strictObject({ email: z.email().max(254) }),
  settings: z.strictObject({
    version: generation,
    timezone,
    reportingCurrency: currency,
  }),
  connections: z
    .array(
      z.strictObject({
        id,
        provider: z.enum(["gmail", "outlook"]),
        address: z.string().max(254),
        generation,
        state: z.string().max(60),
        schedulingState: z.string().max(60),
        scopeReady: z.boolean(),
      }),
    )
    .max(10),
  capabilities: z.strictObject({
    mailboxProviders: z.array(z.enum(["gmail", "outlook"])).max(2),
  }),
  mailboxLimit: z.number().int().min(1).max(10),
  progress: z
    .strictObject({
      importRunId: id,
      connectionId: id,
      startAt: z.iso.datetime(),
      cutoffAt: z.iso.datetime(),
      stage: z.string().max(80),
      discoveredSources: count,
      processedSources: count,
      unsupportedSources: count,
      failedSources: count,
      reviewSources: count,
      readyRecordCount: count,
      reviewItemCount: count,
      pendingJobs: count,
      pausedJobs: count,
      failedJobs: count,
      historyComplete: z.boolean(),
      pauseReason: z.string().max(120).nullable(),
    })
    .nullable(),
});
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;
export const onboardingStartResponseSchema = z.strictObject({
  importRunId: id,
  reused: z.boolean(),
});
export type OnboardingStartResponse = z.infer<
  typeof onboardingStartResponseSchema
>;
