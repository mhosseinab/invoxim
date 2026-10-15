import classification from "../../../config/ai.classification.clef.json";

/**
 * Synthetic local Clef classifier: never invokes the remote Workers AI binding.
 * Uses the versioned Clef configuration so Clef-path regressions keep their
 * destination identity; production now selects Perplexity (covered by
 * perplexity-pipeline and classification-provider-configuration tests).
 */
export const syntheticClassificationBindings = {
  AI_CLASSIFICATION_ENABLED: "true",
  AI_CLASSIFICATION_JSON: JSON.stringify(classification),
  AI: {
    async run() {
      return {
        model: "clef",
        answers: {
          documentType: {
            type: "choice",
            choice: "invoice",
            probabilities: { invoice: 1 },
            confidence: 1,
          },
          receipt: { type: "noul", noul: 0.9 },
          category: {
            type: "choice",
            choice: "uncategorized",
            probabilities: { uncategorized: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      };
    },
  },
};
