# Scope and architecture


Read `BLUEPRINT.md` before changing product behavior. Preserve the multi-user architecture, separate identity/mail/storage consent, Cloudflare hosting, no R2, optional user Drive, provider-agnostic AI, hosted allowance and BYOK. Gmail-first delivery does not remove Outlook from M1.

Use a modular monolith. Core/domain code may import contracts and pure libraries, never Cloudflare bindings, ORM, OAuth SDKs, or provider HTTP clients. Application use cases depend on narrow ports; adapters implement them. Route handlers validate/authorize and call use cases rather than becoming business-logic containers.

No speculative microservices, generic plugin engine, dependency-injection framework, event-sourcing system, vector database, or organization/RBAC model. Use real external boundaries as interfaces. Abstract repeated knowledge after it appears, not every three-line function. Prefer explicit typed code over clever generic machinery.

Pin a tested stable dependency set. Verify platform-specific APIs from current primary docs and the local toolchain. Record meaningful deviations before implementing them. Never silently switch to another hosting platform, database, login service, or paid email connector.

Latest owner decision (2026-10-13) supersedes the Prisma refactor: restore native D1 persistence and the established Drizzle authentication adapter, keeping the consolidated 0001_initial.sql baseline and byte-preserved historical compatibility fixtures. Retain required scheduler seeds, tenant constraints, atomic batches, exact money, millisecond auth storage, shared query limits and reviewed folder cleanup fixes. No Prisma custom driver or generation step remains. Existing databases must follow the non-destructive baseline transition checklist; no reset or deployment is authorized. Create scoped recoverable commits at useful checkpoints, especially before large refactors and after verified milestones.

Owner clarification: external-service adapters remain provider-agnostic at the application boundary. The Worker composition root validates versioned AI configuration read directly from `config/`, plus environment bindings/runtime controls. Credentials and keyrings stay in platform secrets; core code does not read environment variables or vendor SDKs. Preserve approved endpoints, explicit user destinations and no silent fallback. See docs/02-architecture.md.
