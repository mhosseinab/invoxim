/**
 * Facade for the split validation modules (AI-8). The public surface of this
 * path is unchanged; implementation lives in candidate / grounded / model /
 * persistable. SW-3 may collapse this.
 */

export { validateExtraction } from "./grounded";
export { validateModelExtraction } from "./model";
export { validatePersistableAiResult } from "./persistable";
export { NON_CASH_DOCUMENT_TYPES } from "./types";
