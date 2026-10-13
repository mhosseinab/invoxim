import { expect, it } from "vitest";
import { hasControlCharacters } from "../src/primitives";

it("rejects every ASCII control and DEL while preserving identifier text", () => {
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    127,
  ]) {
    expect(hasControlCharacters(`opaque${String.fromCharCode(code)}id`)).toBe(
      true,
    );
  }
  for (const value of [
    "opaque-id",
    " ",
    "~",
    String.fromCharCode(128),
    "café",
    "例子",
  ]) {
    expect(hasControlCharacters(value)).toBe(false);
  }
});
