import { copy } from "../copy";
export const onboardingCopy = {
  ...copy,
  signinEyebrow: "YOUR PURCHASE RECORDS",
  signinIntroduction: "Find receipts and keep your purchase history together.",
  signinNext:
    "After signing in, you choose which inbox to connect and what to import.",
  signinUnavailable:
    "Sign-in is unavailable right now. You can still explore the example.",
  signinOpeningGoogle: "Opening Google…",
  loading: "Loading your workspace…",
  unavailable:
    "Onboarding is unavailable right now. Existing records and the example remain available.",
  signedOut: "Sign in to continue to your private workspace.",
  loginTitle: "Sign in to your private workspace",
  connectTitle: "Connect the inbox where you receive receipts.",
  reviewTitle: "Review and start",
  reviewDetailsTitle: "Processing and privacy details",
  reviewMonthlyResetLabel: "Monthly reset:",
  reviewTechnicalDetails: "Technical details",
  reviewLocalConversion: "Transient conversion inside this app",
  reviewCloseDetails: "Close details",
  reviewRecentSummary:
    "Recent 30 days first, then the rest of your selected history.",
  reviewDataSummary:
    "Email text is sent to the named AI services to find receipts and extract purchase details. Originals stay in your email; no Drive archive is created.",
  reviewConsentSummary:
    "Start imports this history and enables hourly checks for new receipts.",
  noProvider:
    "Mailbox connection is not configured. You can still view existing records or explore the example.",
  authorization:
    "I authorize the displayed processing and hourly receipt checks.",
  stale:
    "Processing settings or the connection changed. Review the current details before continuing.",
  unknown:
    "The Start result is unknown. Retry the same request or check the current import before starting anything else.",
  needsReview:
    "Your changes have not been reviewed yet. Update the review before starting import.",
  processingPaused:
    "Processing is paused. Your existing records are still available.",
  processingNotConfigured:
    "Import is not available yet because receipt processing has not been configured. Your inbox is connected; this review has not started a new import.",
  policyUnavailable:
    "Processing details are unavailable. Import cannot start until approved processing is configured.",
  configurationBlocked:
    "Import is not enabled on this service yet. Your inbox is connected; no new import has started.",
  mailboxApiDisabled:
    "Gmail API is disabled for this app. Enable it in the Google Cloud project before importing.",
  providerUnavailable:
    "The mailbox authorization could not be started. Your workspace is still available; retry only when you are ready.",
  mailboxPermissionDenied:
    "Mailbox permission was not granted. You are still signed in; no import has started.",
  progressTitle: "Your import",
  finished: "Scan finished",
  noReady:
    "No purchase records are ready yet. The selected history has not finished processing.",
  reviewSources:
    "Some messages need details checked before they can become purchase records.",
  failedSources:
    "Some source messages could not be processed. This is not complete receipt coverage.",
  pageInvoxim: "Invoxim",
  pageSignInCouldNotBeStarted:
    "Sign-in could not be started. Try again when you are ready.",
  pageMailboxAuthorizationWasNotCompletedNothing:
    "Mailbox authorization was not completed. Nothing has been imported; choose an inbox when you are ready.",
  pageSkipToContent: "Skip to content",
  pageWorkspaceLinks: "Workspace links",
  pageHome: "Home",
  pagePurchases: "Purchases",
  pagePrivacy: "Privacy",
  pageContinueWithGoogle: "Continue with Google",
  pageExploreTheExample: "Explore the example",
  pageRetry: "Retry",
  signedInPrefix: "Signed in as ",
  loginMailboxSeparation:
    ". Your login account and receipt inbox can be different.",
  pageGmailAuthorizationGrantsBroadReadAccess:
    "Gmail authorization grants broad read access to the selected mailbox. Invoxim searches for receipts within the range you review; the permission itself is not limited to receipts. Connecting alone does not start processing.",
  pageReceiptInbox: "Receipt inbox",
  pageReviewSelectedInbox: "Review selected inbox",
  pageConnectGmailInbox: "Connect Gmail inbox",
  connectOutlookInbox: "Connect Outlook inbox",
  mailboxReadPermission:
    "We ask for read-only access to the selected mailbox. This permission is broader than receipts alone. You review the import range before processing starts; connecting does not start an import.",
  pageYourMailboxLimitHasBeenReached:
    "Your mailbox limit has been reached. Choose an existing inbox or manage connections.",
  pageViewConnectionStatus: "View connection status",
  pageViewExistingRecords: "View existing records",
  pageReconnectYourReceiptInbox: "Reconnect your receipt inbox",
  pageNeedsAuthorizationWithTheRequiredRead:
    " needs authorization with the required read permission. Existing records remain available. Reconnecting must use this same inbox account.",
  reconnectPrefix: "Reconnect ",
  pageChooseAnotherInbox: "Choose another inbox",
  pageReviewProcessingDetails: "Review processing details",
  reviewImportReview: "Import review",
  reviewReviewTheProcessingAuthorizationForThis:
    "Review the processing authorization for this recorded import. Opening this review does not authorize a new destination or start another scan.",
  reviewNothingIsReadOrProcessedUntil:
    "Nothing is read or processed until you explicitly start import.",
  reviewRefreshReview: "Refresh review",
  reviewLoadingTheProcessingReview: "Loading the processing review…",
  reviewSelectedMailbox: "Selected mailbox",
  reviewSelectedDates: "Selected dates",
  rangeTo: " to ",
  inclusiveSelection: " (inclusive selection)",
  reviewFrozenStart: "Frozen start",
  reviewFrozenCutoffExclusive: "Frozen cutoff (exclusive)",
  reviewTimeZone: "Time zone",
  reviewReportingCurrency: "Reporting currency",
  reviewReceiptClassification: "Receipt detection",
  reviewReceiptProcessing: "Receipt processing",
  reviewSeparatorBeforeValue: " ·",
  reviewOperatorFundedInference: "Operator-funded inference",
  reviewYourAIKey: "Your AI key",
  reviewDocumentConversion: "Document conversion",
  reviewRecent30DaysInThisInterval:
    "Recent 30 days in this interval are processed first, then the rest of your selected history. This is ordering, not a shorter import.",
  reviewProcessingPolicies: "Processing policies",
  reviewWhereReceiptDataGoes: "Where receipt data goes",
  reviewSupportedTextConversionHappensTransientlyInside:
    "Supported text conversion happens transiently inside the Worker. Full email bodies, parsed text and model transcripts are not retained as purchase records.",
  readPrefix: "Read ",
  reviewStartingImportDoesNotCreateA:
    " Starting import does not create a Drive archive.",
  reviewProcessingAllowance: "Processing allowance",
  reviewDocumentsRemainingToday: " documents remaining today ·",
  reviewThisMonth: " this month.",
  reviewProcessingUnitsRemainingToday: " processing units remaining today · ",
  reviewThisMonth2: "this month.",
  reviewDailyReset: "Daily reset: ",
  reviewMonthlyReset: ". Monthly reset:",
  period: ".",
  reviewHistoryImportsUseThisSameAllowance:
    "History imports use this same allowance. Processing pauses at the allowance or service-capacity limit. Existing records remain available.",
  reviewProcessingIsTemporarilyPausedByThe:
    "Processing is temporarily paused by the selected provider's rate limit.",
  reviewProcessingIsPausedByTheSelected:
    "Processing is paused by the selected provider's rate limit. Existing records remain available.",
  reviewThisMailboxDoesNotHaveThe:
    "This mailbox does not have the required read permission. Reconnect before starting.",
  reviewChangeDatesTimeZoneOrCurrency: "Change dates, time zone or currency",
  reviewImportPreferences: "Import preferences",
  reviewStartDate: "Start date",
  reviewEndDateInclusive: "End date (inclusive)",
  reviewUpdateReview: "Update review",
  reviewStartImportAuthorizesTheProcessingShown:
    "Start import authorizes the processing shown above and hourly checks for new purchase receipts. Existing records remain available if processing pauses.",
  reviewResumeImport: "Resume import",
  reviewStartImport: "Start import",
  reviewChangeMailbox: "Change mailbox",
  reviewRetryTheSameStartRequest: "Retry the same Start request",
  reviewCheckCurrentImport: "Check current import",
  reviewViewExistingPurchaseRecords: "View existing purchase records",
  progressTheSelectedScanHasFinishedCheck:
    "The selected scan has finished. Check the recorded outcomes below.",
  progressPurchaseRecordsAreReadyOlderHistory:
    "Purchase records are ready. Older history may still be processing.",
  progressImportIsInProgressNoPurchase:
    "Import is in progress. No purchase records are ready yet.",
  progressImportStatus: "Import status",
  progressTheImportRequestWasAcceptedRefresh:
    "The import request was accepted. Refresh status to load its recorded progress.",
  progressImportPaused: "Import paused",
  progressImportInProgress: "Import in progress",
  progressSeparatorAfterValue: "· ",
  progressRequestedInterval: "Requested interval",
  endExclusive: " (end exclusive)",
  progressCandidateMessages: "Candidate messages",
  progressProcessedMessages: "Processed messages",
  progressUnsupportedMessages: "Unsupported messages",
  progressFailedMessages: "Failed messages",
  progressMessagesNeedingReview: "Messages needing review",
  progressRecordsReadyInThisImport: "Records ready in this import",
  progressOpenReviewItems: "Open review items",
  progressRecentMessagesAreProcessedBeforeOlder:
    " Recent messages are processed before older history; the full selected interval remains requested.",
  progressNoMatchingPurchaseRecordsWereFound:
    "No matching purchase records were found in the completed range. Check the selected inbox and dates.",
  progressRefreshImportStatus: "Refresh import status",
  progressViewPurchaseRecords: "View purchase records",
  progressViewQuestionsNeedingAttention: "View questions needing attention",
  progressReviewProcessingAndRange: "Review processing and range",
  progressViewInboxCoverage: "View inbox coverage",
  settingsAdvancedAISettingsAreUnavailableYour:
    "Advanced AI settings are unavailable. Your current processing choice has not changed.",
  settingsCheckTheSelectedProviderModelAnd:
    "Check the selected provider, model and key.",
  settingsSettingsCouldNotBeSavedReload:
    "Settings could not be saved. Reload settings before retrying; no provider was substituted.",
  settingsAdvancedAIOptional: "Advanced AI (optional)",
  settingsYouCanUseAnApprovedProvider:
    "You can use an approved provider with your own key. This is optional. Saving a choice does not authorize receipt processing; review the displayed destination and policies before Start.",
  settingsReloadAISettings: "Reload AI settings",
  settingsEditingAISettingsIsUnavailableReload:
    "Editing AI settings is unavailable. Reload settings when this workspace is ready.",
  settingsYourAIProvider: "Your AI provider",
  settingsProvider: "Provider",
  settingsModel: "Model",
  settingsAIAPIKey: "AI API key",
  settingsAnEncryptedKeyIsConfiguredLeave:
    "An encrypted key is configured. Leave this field empty to retain it for the same provider.",
  policyRevisionPrefix: "Policy revision ",
  settingsNoticeReferences: ". Notice references:",
  settingsReadTheFullProcessingNoticesIn:
    ". Read the full processing notices in the updated review before Start.",
  settingsUseThisProviderAndPolicyRevision:
    "Use this provider and policy revision for the next processing review.",
  settingsSaveAIChoice: "Save AI choice",
  settingsNoApprovedAIProviderIsConfigured:
    "No approved AI provider is configured.",
  settingsSavedReviewRequired:
    "AI choice saved. Review the updated processing details before starting import.",
  settingsKeyRequired: "A key is required for your own provider.",
  progressRunPrefix: " Run: ",
} as const;
export const providerInboxLabels = {
  gmail: onboardingCopy.pageConnectGmailInbox,
  outlook: onboardingCopy.connectOutlookInbox,
} as const;
