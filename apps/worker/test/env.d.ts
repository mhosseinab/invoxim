declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string;
    CORRECTIONS_ENABLED?: string;
    AUTH_SECRET?: string;
    AUTH_GOOGLE_CLIENT_ID?: string;
    AUTH_GOOGLE_CLIENT_SECRET?: string;
    AUTH_ORIGIN?: string;
    AUTH_ALLOWED_EMAILS?: string;
    JOBS?: Queue<{ schemaVersion: 1; jobId: string }>;
    JOBS_ENABLED?: string;
    JOBS_QUERY_LIMIT?: string;
    JOBS_DISPATCH_LIMIT?: string;
    JOBS_SCHEDULE_LIMIT?: string;
    JOBS_TENANT_CONCURRENCY?: string;
    JOBS_GLOBAL_CONCURRENCY?: string;
    JOBS_MAX_ATTEMPTS?: string;
    JOBS_LEASE_MS?: string;
    JOBS_REDELIVERY_MS?: string;
    LIFECYCLE_ENABLED?: string;
    LIFECYCLE_GOOGLE_REVOCATION_ENABLED?: string;
    DELETION_JOURNAL?: Fetcher;
    DELETION_JOURNAL_SECRET?: string;
    EXTRACTION_ENABLED?: string;
    GMAIL_ENABLED?: string;
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    CREDENTIAL_KEYRING?: string;
    MAILBOX_LIMIT?: string;
    API: Fetcher;
    ASSETS: Fetcher;
    ECHO: Fetcher;
  }
}

declare module "*.json?raw" {
  const json: string;
  export default json;
}
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
declare module "*.pdf?inline" {
  const asset: string;
  export default asset;
}
declare module "*.jpg?inline" {
  const asset: string;
  export default asset;
}
declare module "*.png?inline" {
  const asset: string;
  export default asset;
}
