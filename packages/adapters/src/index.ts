// Public facade for @invoxim/adapters.
// Explicit re-exports only — names consumed outside this package.
// Internal helpers stay package-internal and are not leaked here.

export { createReceiptClassifierFactory } from "./ai/classifier-factory";
export type { ClefBinding } from "./ai/clef";
export { CLEF_RECEIPT_POLICY_VERSION } from "./ai/clef-protocol";
export type { AiBindings, AiConfiguration } from "./ai/configuration";
export { aiConfiguration } from "./ai/configuration";
export {
  createAiProbeService,
  createAiProviderFactory,
} from "./ai/provider-factory";
export { AiSettingsError, createAiSettingsService } from "./ai/settings";
export type { AuthBindings, LoginConfiguration } from "./auth/configuration";
export { loginConfiguration } from "./auth/configuration";
export {
  AuthRequestError,
  handleLoginRequest,
  isLoginRequest,
  readAuthJson,
} from "./auth/http";
export { createLoginAuth } from "./auth/login";
export type { ProfileRow } from "./auth/profile";
export {
  createProfileService,
  preferencesSchema,
  projectProfile,
} from "./auth/profile";
export { createConnectionsViewRepository } from "./connection-views";
export { createCorrectionStore } from "./corrections/store";
export {
  issueWorkspaceMutationToken,
  verifyWorkspaceMutationToken,
} from "./corrections/workspace-token";
export { createOutlookJobRunner } from "./discovery/outlook-job";
export { createOutlookDiscoveryProviderFactory } from "./discovery/outlook-provider-factory";
export { createGmailDiscoveryProviderFactory } from "./discovery/provider-factory";
export type { DiscoveryServiceOptions } from "./discovery/service";
export { createDiscoveryService } from "./discovery/service";
export { createLocalPdfTextExtractor } from "./documents/pdf";
export { createArchiveConsentRepository } from "./drive/archive-consent";
export { createDriveAuthorization } from "./drive/authorization";
export type { DriveBindings } from "./drive/configuration";
export { driveConfiguration } from "./drive/configuration";
export { createDriveConnectionsRepository } from "./drive/connections";
export { createDriveService } from "./drive/service";
export type { FxReferenceBindings } from "./fx/configuration";
export { fxReferenceConfiguration } from "./fx/configuration";
export {
  createFxPeriodService,
  type FxPeriodInput,
  type FxPeriodResult,
} from "./fx/period";
export { createFxPeriodSigning } from "./fx/period-signing";
export { createPublicReferenceRateReader } from "./fx/reference";
export type {
  FxReportingPage,
  FxReportingPageInput,
  FxRevaluationPage,
} from "./fx/service";
export { createFxReportingService } from "./fx/service";
export { BoundedJsonError, boundedJsonResponse } from "./http";
export { classifyManualSync, createJobStore } from "./jobs/store";
export { createLifecycleCleanup } from "./lifecycle/cleanup";
export type { LifecycleBindings } from "./lifecycle/configuration";
export { lifecycleDependencies } from "./lifecycle/configuration";
export { createLifecycleRepository } from "./lifecycle/repository";
export { createGoogleCredentialRevoker } from "./lifecycle/revocation";
export type {
  GmailBindings,
  GmailConfiguration,
} from "./mailbox/configuration";
export {
  GMAIL_AUTHORIZATION_SCOPES,
  gmailConfiguration,
} from "./mailbox/configuration";
export { createGmailAuthorization } from "./mailbox/gmail";
export { createOutlookAuthorization } from "./mailbox/outlook";
export type { OutlookBindings } from "./mailbox/outlook-configuration";
export { outlookConfiguration } from "./mailbox/outlook-configuration";
export {
  createMailboxManagement,
  createMailboxService,
} from "./mailbox/service";
export { createOnboardingImportPreparation } from "./onboarding/import-preparation";
export {
  createProcessingDiscoveryReadiness,
  createProcessingReviewResolver,
} from "./onboarding/processing-readiness";
export { ProcessingNotConfiguredError } from "./onboarding/read";
export { createOnboardingRepository } from "./onboarding/repository";
export { createGmailContentFactory } from "./pipeline/gmail-factory";
export { createOutlookContentFactory } from "./pipeline/outlook-factory";
export { createPipelineRepository } from "./pipeline/repository";
export { connectionConsentLiveSql } from "./pipeline/repository-guards";
export { createPipelineService } from "./pipeline/service";
export type { TransientContentFactory } from "./pipeline/types";
export { createPurchaseViewReader, PurchaseViewError } from "./purchase-views";
export {
  createReviewSourceReader,
  lookupReviewProvider,
  ReviewSourceError,
} from "./purchase-views/review-source";
export type {
  RecurringListInput,
  RecurringWriteResult,
} from "./recurring/service";
export { createRecurringService } from "./recurring/service";
export { createCredentialCipher, encodeBase64url } from "./security/cipher";
export { createOAuthStateStore } from "./security/oauth-state";
export { createCredentialVault } from "./security/vault";
