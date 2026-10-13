import type { FxRateQuote, FxRateRequest } from "@invoxim/contracts";

/** Public reference data only; selection and persistence belong to the adapter. */
export interface PublicReferenceRateReader {
  lookup(request: FxRateRequest): Promise<FxRateQuote | null>;
}

export class FxInputError extends Error {
  constructor() {
    super("INVALID_FX_INPUT");
    this.name = "FxInputError";
  }
}
