import type { AiBindings } from "@invoxim/adapters";
import preset from "../../../config/ai.abacus.production.json";
import classification from "../../../config/ai.classification.production.json";

/** Server-bundled defaults; credentials and explicit environment overrides remain external. */
export function runtimeAiBindings<T extends AiBindings>(bindings: T) {
  return {
    ...preset.variables,
    AI_REGISTRY_JSON: JSON.stringify(preset.registry),
    AI_CLASSIFICATION_JSON: JSON.stringify(classification),
    AI_BUDGET_JSON: JSON.stringify(preset.budget),
    ...bindings,
  };
}
