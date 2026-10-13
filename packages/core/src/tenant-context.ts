/** Type boundary for authority derived internally from verified sessions or jobs.
 * No request/user-ID factory is exposed. Session/job verification belongs to
 * their application adapters; this type alone does not authenticate a caller.
 */
declare const tenantContextBrand: unique symbol;
export interface TenantContext {
  readonly userId: string;
  readonly authority: "session" | "job";
  readonly [tenantContextBrand]: true;
}
