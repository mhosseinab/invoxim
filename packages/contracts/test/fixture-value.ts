/** Fail fast when a required synthetic fixture value is absent. */
export function requireFixture<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Required synthetic fixture value is unavailable");
  }
  return value;
}
