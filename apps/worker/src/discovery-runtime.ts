import type { DiscoveryServiceOptions } from "@invoxim/adapters";
import { createDiscoveryService } from "@invoxim/adapters";
import type { JobHandler } from "@invoxim/core";
/** Internal queue handler only; public Start and processor readiness remain separate gates. */
export function createDiscoveryRuntime(
  options: DiscoveryServiceOptions & { db: D1Database },
): JobHandler {
  return {
    run(lease, control) {
      return createDiscoveryService(options.db, options).runPage(
        lease,
        control,
      );
    },
  };
}
