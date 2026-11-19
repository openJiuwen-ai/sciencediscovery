import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
import { sourceTestIdentityProblems, sourceTestMapProblems } from "./source-test-map.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("source to test inventory is valid and every evidence file exists", async () => {
  assert.deepEqual(await sourceTestMapProblems(), []);
});

test("desktop real entry point fails closed without explicit credentials", () => {
  const result = spawnSync(process.execPath, [resolve(".ci/run-desktop-e2e.mjs"), "real"], {
    env: { ...process.env, CI_ALLOW_REAL: "", E2E_API_TOKEN: "", E2E_BASE_URL: "", E2E_LLM_BASE_URL: "", E2E_LLM_MODEL: "", E2E_LLM_TOKEN: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BLOCKED/);
});


test("source map rejects phantom and duplicate evidence and expired waivers", async t => {
  const root = await mkdtemp(join(tmpdir(), "source-test-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "component.ts"), "");
  await writeFile(join(root, "test", "component.test.ts"), "");
  const evidence = { source: "test/component.test.ts", layer: "ut", complexity: "C1" };
  const check = async (tests, waiver) => {
    await writeFile(join(root, "test", "source-test-map.json"), JSON.stringify({
      version: 1, entries: [{ source: "component.ts", owner: "desktop", risk: "P1", tests, waiver }],
    }));
    return sourceTestMapProblems(root, "2026-11-19");
  };
  assert.deepEqual(await check([evidence]), []);
  assert.match((await check([evidence, evidence]))[0], /duplicate test evidence/);
  for (const source of ["component.ts", "test/missing.spec.ts", "../test/component.test.ts", "test/./component.test.ts"]) {
    assert.match((await check([{ ...evidence, source }]))[0], /existing repository test file/);
  }
  assert.deepEqual(await check([], { owner: "desktop", expiry: "2026-11-19" }), []);
  assert.match((await check([], { owner: "desktop", expiry: "2026-11-18" }))[0], /waiver expired/);
  assert.match((await check([], { owner: "desktop", expiry: "2027-02-31" }))[0], /valid expiry date/);
});


test("mapped identities must be collected from the named file and layer", async () => {
  const id = "memory-query-http-validation";
  const source = "services/api/src/server.test.ts";
  const right = { id, source, tags: ["category:ut"], runner: "node" };
  const check = async (testcases) => (await sourceTestIdentityProblems(process.cwd(), testcases, ["ut"]))
    .find(problem => problem.includes(`${id}:`));
  assert.equal(await check([right]), undefined);
  assert.match(await check([]), /identity not collected/);
  assert.match(await check([{ ...right, source: "services/api/src/skill-library-catalog.test.ts" }]), /collected from/);
  assert.match(await check([{ ...right, tags: ["category:st"] }]), /does not match layer ut/);
  assert.match(await check([{ ...right, forbiddenSkip: true }]), /case is disabled/);
});
