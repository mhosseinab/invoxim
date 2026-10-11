# Security and data handling


All tenant authorization comes from the server-verified session or a trusted internal job loaded from D1. Every repository query/join/mutation and source/archive link must be tenant-scoped. A client-supplied user ID is never authority. Use composite ownership constraints and adversarial cross-tenant tests.

Raw emails, documents, parsed full text and model transcripts are transient only. No raw contents in D1, queues, logs, traces, analytics, exception messages, CI artifacts or temporary R2. Only explicitly authorized originals go to user-owned Drive. Do not log invoice values, titles or merchant identities. Synthetic fixture content is the only repository test data by default.

Encrypt retained refresh tokens and BYOK keys with authenticated encryption and scoped AAD. Keep root keys/OAuth client secrets in platform secret storage. Model output cannot specify URLs, tools, credentials, tenant IDs or destinations. Constrain outbound provider endpoints and redirects; do not fetch arbitrary invoice links or remote HTML assets.

Never put real credentials or receipt content into a coding-agent prompt. No destructive migration, public launch, broadened scope, paid upgrade, production deployment or third-party upload without explicit authority. Respect user-selected processing destinations and consent; no silent AI fallback.
