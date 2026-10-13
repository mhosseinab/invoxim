import { expect, it } from "vitest";
import {
  issueWorkspaceMutationToken,
  verifyWorkspaceMutationToken,
} from "../../../packages/adapters/src/corrections/workspace-token";

it("storage tokens bind their purpose, actor, session and expiry", async () => {
  const identity = {
    userId: "synthetic-storage-owner",
    sessionId: "synthetic-storage-session",
  };
  const secret = "synthetic-storage-token-secret-1234567890";
  const now = 1791849600000;
  const value = await Reflect.apply(issueWorkspaceMutationToken, undefined, [
    identity,
    secret,
    () => now,
    "storage-settings",
  ]);
  async function verify(
    actor = identity,
    clock = () => now,
    purpose = "storage-settings",
  ) {
    return Reflect.apply(verifyWorkspaceMutationToken, undefined, [
      value,
      actor,
      secret,
      clock,
      purpose,
    ]);
  }
  expect(await verify()).toBe(true);
  expect(await verify(identity, () => now, "ai-settings")).toBe(false);
  expect(await verify(identity, () => now, "lifecycle")).toBe(false);
  expect(await verify({ ...identity, userId: "synthetic-other-owner" })).toBe(
    false,
  );
  expect(
    await verify({ ...identity, sessionId: "synthetic-other-session" }),
  ).toBe(false);
  expect(await verify(identity, () => now + 600000)).toBe(false);
});
