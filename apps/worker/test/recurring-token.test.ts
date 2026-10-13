import { expect, it } from "vitest";
import {
  issueWorkspaceMutationToken,
  verifyWorkspaceMutationToken,
} from "../../../packages/adapters/src/corrections/workspace-token";

it("RECUR-UX-01 recurring mutation authority binds actor session purpose and expiry", async () => {
  const owner = {
    userId: "synthetic-recurring-user",
    sessionId: "synthetic-session",
  };
  const secret = "synthetic-recurring-token-secret-32-characters";
  const clock = () => 1000;
  const token = await issueWorkspaceMutationToken(
    owner,
    secret,
    clock,
    "recurring",
  );
  expect(
    await verifyWorkspaceMutationToken(
      token,
      owner,
      secret,
      clock,
      "recurring",
    ),
  ).toBe(true);
  expect(
    await verifyWorkspaceMutationToken(
      token,
      owner,
      secret,
      clock,
      "corrections",
    ),
  ).toBe(false);
  expect(
    await verifyWorkspaceMutationToken(
      token,
      { ...owner, userId: "other-synthetic-user" },
      secret,
      clock,
      "recurring",
    ),
  ).toBe(false);
  expect(
    await verifyWorkspaceMutationToken(
      token,
      { ...owner, sessionId: "other-synthetic-session" },
      secret,
      clock,
      "recurring",
    ),
  ).toBe(false);
  expect(
    await verifyWorkspaceMutationToken(
      token,
      owner,
      secret,
      () => 601000,
      "recurring",
    ),
  ).toBe(false);
});
