import { DOCUMENT_LIMITS } from "@invoxim/core";
import { z } from "zod";
import type { ReceiptClassificationConfiguration } from "../ai/classification-config";
import {
  classificationProvider,
  receiptClassificationConfigurationSchema,
} from "../ai/classification-config";
import type { AiDestination, AiModel } from "../ai/configuration";
import {
  aiNoticeSchema,
  selectedAiConfigurationDigest,
} from "../ai/configuration";
import { LOCAL_PDF_PARSER_VERSION } from "../documents/pdf-preflight";
import { hashJsonValue } from "../hash";

/** Code-owned local parser policy: transient in-Worker processing, no remote converter. */
export const LOCAL_PARSER_POLICY = Object.freeze({
  providerId: "local-unpdf",
  version: LOCAL_PDF_PARSER_VERSION,
  policyVersion: "local-parser-transient-v2",
  noticeRefs: ["local-parser-transient-v2"],
  limits: DOCUMENT_LIMITS,
});
const id = z.string().min(1).max(120);
export const configDigestInputsSchema = z.strictObject({
  mode: z.enum(["hosted", "byok"]),
  settingsRevision: z.number().int().min(1).max(2147483646),
  aiConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  classification: receiptClassificationConfigurationSchema.optional(),
  classificationNotice: aiNoticeSchema.optional(),
  parser: z.strictObject({
    providerId: id,
    version: id,
    policyVersion: id,
    noticeRefs: z.array(id).min(1).max(10),
    limits: z.strictObject({
      bytes: z.number().int().positive(),
      parts: z.number().int().positive(),
      depth: z.number().int().positive(),
      pages: z.number().int().positive(),
      textCharacters: z.number().int().positive(),
    }),
  }),
});
export type ConfigDigestInputs = z.infer<typeof configDigestInputsSchema>;
export async function onboardingConfigurationDigest(
  input: ConfigDigestInputs,
): Promise<string> {
  return hashJsonValue(configDigestInputsSchema.parse(input));
}
export async function selectedOnboardingConfigurationDigest(input: {
  mode: "hosted" | "byok";
  settingsRevision: number;
  destination: AiDestination;
  model: AiModel;
  classification?: ReceiptClassificationConfiguration | undefined;
}): Promise<string> {
  return onboardingConfigurationDigest({
    mode: input.mode,
    settingsRevision: input.settingsRevision,
    aiConfigurationDigest: await selectedAiConfigurationDigest(
      input.destination,
      input.model,
    ),
    ...classificationDigestInputs(input.classification),
    parser: LOCAL_PARSER_POLICY,
  });
}
/** The reviewed classifier configuration and its own processor notice, or nothing when disabled. */
export function classificationDigestInputs(
  classification: ReceiptClassificationConfiguration | undefined,
): Pick<ConfigDigestInputs, "classification" | "classificationNotice"> {
  return classification?.enabled
    ? {
        classification,
        classificationNotice: receiptClassifierNotice(classification),
      }
    : {};
}
export const RECEIPT_CLASSIFIER_NOTICE = Object.freeze({
  id: "cloudflare-clef-v4",
  displayName: "Cloudflare Workers AI — Clef email classification",
  dataUseSummary:
    "Each readable document, including locally converted PDF text, is sent to Cloudflare Clef to identify financial document type and category. An attachment does not qualify its covering email. Plausible uncertain documents may be verified by your selected financial provider. Cloudflare states it does not train on this content without explicit consent.",
  retentionSummary:
    "This app does not store email text or model transcripts. Cloudflare processes classification content under its Workers AI terms; this app does not enable remote content storage or assert a fixed retention period.",
  privacyUrl:
    "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
});
/**
 * Perplexity Decisions API notice. Its documentation (checked 2026-10-15)
 * publishes no data-retention or training terms, so none are claimed here.
 */
export const PERPLEXITY_DECIDER_CLASSIFIER_NOTICE = Object.freeze({
  id: "perplexity-decider-v1",
  displayName: "Perplexity Decisions API — pplx-decider email classification",
  dataUseSummary:
    "Each readable document, including locally converted PDF text, is sent to Perplexity to identify financial document type and category. An attachment does not qualify its covering email. Plausible uncertain documents may be verified by your selected financial provider.",
  retentionSummary:
    "This app does not store email text or model transcripts. Perplexity's Decisions API documentation does not publish data-retention or model-training terms, so this app makes no retention or no-training claim for Perplexity.",
  privacyUrl: "https://docs.perplexity.ai/docs/decisions/quickstart",
});
/** The disclosed processor notice for the configured classification provider. */
export function receiptClassifierNotice(
  classification: ReceiptClassificationConfiguration,
) {
  return classificationProvider(classification) === "perplexity-decider"
    ? PERPLEXITY_DECIDER_CLASSIFIER_NOTICE
    : RECEIPT_CLASSIFIER_NOTICE;
}
