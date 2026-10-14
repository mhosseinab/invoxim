import { DRIVE_AUTHORIZATION_SCOPES } from "./configuration";

const aliases: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

/** Stored scopes are a JSON array; OAuth token responses are space-separated. */
function parseScopeList(value: string): string[] | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      if (!parsed.every((item) => typeof item === "string")) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

/**
 * One Drive scope check (D4). `exact` requires the granted set to equal
 * `expected`; `includes` only requires every expected scope to be present.
 */
export function grantedScopes(
  value: string,
  expected: readonly string[],
  mode: "exact" | "includes",
): boolean {
  const parsed = parseScopeList(value);
  if (parsed === null) return false;
  if (parsed.length > 16) return false;
  if (parsed.some((scope) => scope.length < 1 || scope.length > 256))
    return false;
  const normalized = parsed.map((scope) => aliases[scope] ?? scope);
  const actual = new Set(normalized);
  if (actual.size !== normalized.length) return false;
  if (mode === "includes")
    return expected.every((scope) => actual.has(scope));
  return (
    expected.every((scope) => actual.has(scope)) &&
    [...actual].every((scope) => expected.includes(scope))
  );
}

/** Superset check used by the archive workflow before any provider dispatch. */
export function scopesInclude(value: string, permission: string): boolean {
  return grantedScopes(value, [permission], "includes");
}

/** Exact match against the configured Drive consent set. */
export function scopesMatchConfiguration(value: string): boolean {
  return grantedScopes(value, DRIVE_AUTHORIZATION_SCOPES, "exact");
}
