import { expect, it } from "vitest";
import {
  issueWorkspaceMutationToken,
  verifyWorkspaceMutationToken,
} from "../../../packages/adapters/src/corrections/workspace-token";

it("workspace tokens bind their closed mutation purpose as well as the actual actor/session", async () => {
  const identity = { userId: "synthetic-a", sessionId: "synthetic-session-a" };
  const secret = "synthetic-workspace-token-secret-32";
  const now = 1791849600000;
  const clock = () => now;
  const token = await Reflect.apply(issueWorkspaceMutationToken, undefined, [
    identity,
    secret,
    clock,
    "ai-settings",
  ]);
  expect(
    await verifyWorkspaceMutationToken(token, identity, secret, clock),
  ).toBe(false);
  expect(
    await Reflect.apply(verifyWorkspaceMutationToken, undefined, [
      token,
      identity,
      secret,
      clock,
      "ai-settings",
    ]),
  ).toBe(true);
  expect(
    await Reflect.apply(verifyWorkspaceMutationToken, undefined, [
      token,
      { ...identity, userId: "synthetic-b" },
      secret,
      clock,
      "ai-settings",
    ]),
  ).toBe(false);
  expect(
    await Reflect.apply(verifyWorkspaceMutationToken, undefined, [
      token,
      identity,
      secret,
      () => now + 600000,
      "ai-settings",
    ]),
  ).toBe(false);
});
