import { DOCUMENT_LIMITS } from "@invoxim/core";
import { z } from "zod";
import type { ReceiptClassificationConfiguration } from "../ai/clef";
import { receiptClassificationConfigurationSchema } from "../ai/clef";
import type { AiDestination, AiModel } from "../ai/configuration";
import {
  aiNoticeSchema,
  selectedAiConfigurationDigest,
} from "../ai/configuration";
import { LOCAL_PDF_PARSER_VERSION } from "../documents/pdf-preflight";

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
  return hashOnboardingValue(configDigestInputsSchema.parse(input));
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
    ...(input.classification?.enabled
      ? {
          classification: input.classification,
          classificationNotice: RECEIPT_CLASSIFIER_NOTICE,
        }
      : {}),
    parser: LOCAL_PARSER_POLICY,
  });
}
export async function hashOnboardingValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const RECEIPT_CLASSIFIER_NOTICE = Object.freeze({
  id: "cloudflare-clef-v4",
  displayName: "Cloudflare Workers AI — Clef email classification",
  dataUseSummary:
    "Each readable document, including locally converted text PDFs, is sent to Cloudflare Clef to identify its document type, detect financial documents and suggest a category. An attachment does not qualify its covering email. Plausible uncertain documents may be verified and extracted by your selected financial provider; known nonfinancial documents are excluded. Financial extraction uses your selected provider. Cloudflare states it does not train on this content without explicit consent.",
  retentionSummary:
    "This app does not store email text or model transcripts. Cloudflare processes classification content under its Workers AI terms; this app does not enable remote content storage or assert a fixed retention period.",
  privacyUrl:
    "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
});
