import { CredentialError } from "./cipher";
/** Security adapter boundary only: do not retain driver messages, stack, cause or payload. */
export function redactSecurityFailures<Arguments extends unknown[], Result>(
  operation: (...args: Arguments) => Promise<Result>,
): (...args: Arguments) => Promise<Result> {
  return async (...args: Arguments) => {
    try {
      return await operation(...args);
    } catch (error) {
      const code =
        error instanceof CredentialError &&
        [
          "INVALID_SECRET",
          "SECRET_UNAVAILABLE",
          "INVALID_KEYRING",
          "INVALID_OAUTH_STATE",
        ].includes(error.code)
          ? error.code
          : "SECRET_UNAVAILABLE";
      throw new CredentialError(code);
    }
  };
}
