/**
 * Facade for the split design modules (CON-5). The public surface of this
 * path is unchanged; implementation lives in extraction / onboarding-view /
 * app-config. SW-3 may collapse this.
 */

export type { AppConfig } from "./app-config";
export { configSchema } from "./app-config";
export type { Extraction } from "./extraction";
export {
  EXTRACTION_PROMPT_VERSION,
  extractionSchema,
  inferenceExtractionSchema,
  supportedExtractionPrompt,
} from "./extraction";
export { copyKeySchema, onboardingViewSchema } from "./onboarding-view";
