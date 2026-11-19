import assert from "node:assert/strict";
import { createTest } from "../test/support/tagged/compat.mjs";
import { comparePlans, planIdentitySet } from "./plan-stability.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

test("plan stability compares revision, catalog, digest and identity set", () => {
  const first = {
    revision: "abc",
    catalogDigest: "catalog-a",
    digest: "plan-a",
    entries: [{ key: "one" }, { key: "two" }],
  };
  const same = {
    revision: "abc",
    catalogDigest: "catalog-a",
    digest: "plan-a",
    entries: [{ key: "two" }, { key: "one" }],
  };
  assert.deepEqual(planIdentitySet(first), ["one", "two"]);
  assert.deepEqual(comparePlans(first, same), []);
  assert.deepEqual(comparePlans(first, { ...same, digest: "plan-b" }), ["plan digest changed"]);
  assert.deepEqual(comparePlans(first, { ...same, digest: "plan-b", entries: [{ key: "one" }, { key: "three" }] }), ["plan digest changed", "plan identity set changed"]);
});
