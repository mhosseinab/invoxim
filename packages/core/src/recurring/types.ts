export class RecurringInputError extends Error {
  constructor() {
    super("INVALID_RECURRING_INPUT");
    this.name = "RecurringInputError";
  }
}
