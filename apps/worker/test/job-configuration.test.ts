import { expect, it } from "vitest";
import { jobConfiguration, QUERY_LIMIT } from "../src/job-configuration";

const base = {
  DB: {} as D1Database,
  JOBS: {} as Queue,
  JOBS_ENABLED: "true",
};

it("WRK-3 rejects queryLimit 24", () => {
  expect(jobConfiguration({ ...base, JOBS_QUERY_LIMIT: "24" })).toBeNull();
});

it("WRK-3 rejects queryLimit 39", () => {
  expect(jobConfiguration({ ...base, JOBS_QUERY_LIMIT: "39" })).toBeNull();
});

it("WRK-3 accepts queryLimit 40", () => {
  expect(jobConfiguration({ ...base, JOBS_QUERY_LIMIT: "40" })).toMatchObject({
    queryLimit: QUERY_LIMIT,
  });
});

it("WRK-3 defaults queryLimit to 40", () => {
  expect(jobConfiguration(base)).toMatchObject({ queryLimit: QUERY_LIMIT });
});
