import classification from "../../../config/ai.classification.production.json";

/** Synthetic local classifier: never invokes the remote Workers AI binding. */
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
