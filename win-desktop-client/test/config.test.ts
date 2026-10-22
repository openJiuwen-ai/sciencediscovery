import test from "node:test";
import assert from "node:assert/strict";
import {
  healthUrl, resolveDataDir, resolveRepoRoot, stackEntry, tokenFilePath, uiUrl,
} from "../src/config.ts";

test("repo root: env wins, default is sibling sciencediscovery", () => {
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: "E:\\repo" }, "C:\\shell"), "E:\\repo");
  const fallback = resolveRepoRoot({}, "C:\\work\\shell");
  assert.ok(fallback.endsWith("sciencediscovery"), fallback);
  assert.ok(fallback.startsWith("C:\\work"), "default must sit next to the shell dir");
});

test("data dir: env wins, default is user profile .sciencediscovery", () => {
  assert.equal(resolveDataDir({ SCIENCE_DISCOVERY_DATA_DIR: "D:\\data" }), "D:\\data");
  const fallback = resolveDataDir({ USERPROFILE: "C:\\Users\\x" });
  assert.ok(fallback.endsWith(".sciencediscovery"), fallback);
});

test("token file lives under dataDir/secrets", () => {
  assert.ok(tokenFilePath("D:\\data").replace(/\\/g, "/").endsWith("data/secrets/auth-token"));
});

test("ui and health urls strip trailing slashes and default correctly", () => {
  assert.equal(uiUrl({}), "http://127.0.0.1:4310");
  assert.equal(uiUrl({ SD_SHELL_UI_URL: "http://10.0.0.2:4310/" }), "http://10.0.0.2:4310");
  assert.equal(healthUrl({}), "http://127.0.0.1:4410/api/health");
  assert.equal(healthUrl({ SD_SHELL_HEALTH_URL: "http://h:9/api/health/" }), "http://h:9/api/health");
});

test("stack entry points at start-stack.mjs", () => {
  assert.ok(stackEntry("R").replace(/\\/g, "/").endsWith("R/scripts/start-stack.mjs"));
});
