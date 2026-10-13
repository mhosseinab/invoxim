import catalog from "../../../contracts/ux-copy.en.json";

/** Existing preview labels, centralized for translation; canonical text stays authoritative. */
export const copy = {
  ...{
    "release.liveUnavailable": "Sign-in is not configured for this preview.",
    "demo.previewHistory":
      "One purchase. Four supporting documents. A documented partial refund.",
    "purchase.viewHistory": "View purchase history",
    "manualSource.title": "Sources you linked",
    "manualSource.document": "Document you linked",
    "manualSource.sourceLabel": "Source",
    "manualSource.associationNotice":
      "You associated this document with the purchase. This link does not create extracted receipt fields or prove a payment.",
    "manualSource.userSuppliedRecord": "Record details were supplied by you.",
    "landing.previewEyebrow": "Purchase records · Working preview",
    "landing.previewTitle": "A purchase, with the evidence in one place.",
    "demo.shortLabel": "Example data",
    "landing.outcomesTitle": "Find the receipt. Understand the history.",
    "landing.findTitle": "Find a purchase",
    "landing.findDescription":
      "Search purchase records and open the documents that support them.",
    "landing.amountsTitle": "See paid and refunded amounts",
    "landing.amountsDescription":
      "An invoice is not another charge. Completed refunds belong alongside the payment they explain.",
    "landing.futureTitle": "From inbox to purchase records",
    "landing.stepSignin": "Sign in to your private workspace.",
    "landing.stepConnect": "Connect the inbox where receipts arrive.",
    "landing.stepStart":
      "Review the account, range and processing destinations, then explicitly start the import.",
    "landing.futureHistory":
      "Recent records will be processed first while the rest of your chosen history continues. Login alone does not authorize mailbox access.",
    "privacy.title": "Clear permissions. Limited coverage.",
    "privacy.example":
      "This example uses static synthetic data. It does not read your inbox or send documents for processing.",
    "privacy.mailboxQuestion": "What will mailbox access mean?",
    "privacy.startExplanation":
      "Live import requires a separate review and Start action. The selected processing destinations and allowance must be shown before that action.",
    "privacy.coverageQuestion": "Is this a complete financial overview?",
    "privacy.coverageExplanation":
      "Purchase records depend on receipts in supported connected inboxes. Cash purchases without an emailed receipt are not visible. Figures are not bank-verified.",
    "privacy.originalsQuestion": "Where do originals stay?",
    "drive.previewUnavailable":
      "Drive archiving is not available in this preview.",
    "privacy.integrationsQuestion": "Which integrations can I use now?",
    "privacy.integrationsUnavailable":
      "The example is available without an account. Sign-in and mailbox setup follow the services configured for this preview; processing requires your review and Start. Drive archiving is not available yet.",
    "demo.dateCaption": "September 2026 · Synthetic records",
    "demo.liveUnavailable": "Live inbox connection is not available yet.",
    "purchase.statusLabel": "Payment status",
    "purchase.filterAll": "All records",
    "purchase.paymentDocumented": "Payment documented",
    "purchase.filterUnpaid": "Unpaid",
    "demo.emptySearch": "No example purchases match these filters.",
    "demo.summaryRange": "All example records · 1–30 September 2026",
    "demo.summaryExplanation":
      "The EUR 80.00 unpaid invoice is excluded. This summary uses payment and completed-refund event dates; purchase histories above show lifecycle values.",
    "demo.exploreTitle": "Explore without connecting anything",
    "demo.actionsExplanation":
      "This example cannot edit, export, sync or archive records. Source evidence is synthetic and stays on this page.",
    "navigation.skip": "Skip to content",
    "navigation.how": "How it works",
    "navigation.privacy": "Privacy",
    "product.previewSuffix": "· Working preview",
    "release.staticAvailable":
      "Static example data. Importing your own records requires configured services and your processing approval.",
    "navigation.main": "Main",
    "demo.searchRegion": "Search example purchases",
    "demo.searchPlaceholder": "Merchant, date or receipt detail",
    "demo.purchasesRegion": "Example purchases",
    "demo.actionsRegion": "Read-only example actions",
    "purchase.unpaidInvoice": "Unpaid invoice",
    "timeline.order": "Order received",
    "timeline.invoice": "Invoice issued",
    "timeline.refund": "Refund documented",
    "action.edit": "Edit",
    "action.export": "Export",
    "action.sync": "Sync",
    "action.archive": "Archive",
    "navigation.introduction": "Back to introduction",
    "purchase.recordNoun": "purchase",
    "demo.countOne": "{count} example purchase",
    "demo.countMany": "{count} example purchases",
    "product.workingName": "Invoxim",
    "navigation.dashboard": "Dashboard",
    "navigation.purchases": "Purchases",
    "navigation.recurring": "Recurring",
    "navigation.connections": "Connections",
    "navigation.review": "Review",
    "navigation.settings": "Settings",
    "navigation.unavailable": "Live features unavailable",
    "demo.privacyTitle": "Example data stays example data.",
    "demo.privacyCaption":
      "No inbox connection. No receipt processing. Explore the synthetic records locally.",
    "demo.headerCaption": "Read-only example",
    "navigation.preview": "Preview links",
    "navigation.summary": "Summary",
    "demo.searchInstruction":
      "Search a merchant, date or receipt detail, or choose a payment status.",
    "demo.filterAll": "All",
    "demo.filterPaid": "Paid",
    "demo.filterRefunded": "With refund",
    "demo.clearSearch": "Clear search",
    "demo.resetFilters": "Reset filters",
    "demo.showAll": "Show all purchases",
    "demo.exploreDescription":
      "Try these examples to see how a purchase and its evidence fit together.",
    "demo.seeRefund": "See a refund",
    "demo.findUnpaid": "Find an unpaid invoice",
    "demo.refundGuide":
      "Follow a payment and completed partial refund in one purchase history.",
    "demo.unpaidGuide":
      "See why an invoice without a documented payment is excluded from spending.",
    "demo.localOnly":
      "Read-only synthetic records. Search and evidence stay on this page.",
  },
  ...catalog.messages,
} as const;
