import assert from "node:assert/strict";
import { createTest } from "../test/support/tagged/compat.mjs";
import { runRealCombinationJourney } from "./combination-real-fixture.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64"] });

for (const id of ["GJ-01", "GJ-02", "GJ-03", "GJ-04", "GJ-05", "GJ-06"]) {
  test(`${id} executes real HTTP fixture requests and persists cross-feature side effects`, async () => {
    const result = await runRealCombinationJourney(id);
    assert.equal(result.status, "passed");
    assert.ok(result.calls >= 3, `${id} did not exercise enough product requests`);
  });
}
