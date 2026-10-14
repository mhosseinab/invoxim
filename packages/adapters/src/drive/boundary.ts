import { ArchiveServiceError } from "@invoxim/core";
import { safe } from "../security/helpers";

/**
 * D13: one store boundary error map. Domain errors rethrow; everything else
 * becomes UNAVAILABLE. Built on the SEC-2 `safe` primitive.
 */
export function archiveSafe<T>(operation: () => Promise<T>): Promise<T> {
  return safe(
    operation,
    () => new ArchiveServiceError("UNAVAILABLE"),
    (cause) => cause instanceof ArchiveServiceError,
  );
}
