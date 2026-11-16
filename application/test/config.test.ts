import test from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import {
  healthUrl, resolveDataDir, resolveRepoRoot, stackEntry, tokenFilePath, uiUrl,
} from "../src/config.ts";
import { CURRENT_SHELL_PLATFORM } from "../src/shell-platform.ts";

// Fixtures follow the HOST dialect: the join()s under test use node:path's
// host join, so win32-style fixture strings would not round-trip on darwin
// (the sibling-repo default is exercised with native separators here, and
// the platform branches below are injected explicitly).
const IS_DARWIN = CURRENT_SHELL_PLATFORM === "darwin";
const J = (...parts: string[]) => parts.join(sep);

test("repo root: env wins, default is sibling sciencediscovery", () => {
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: J("E:", "repo") }, J("C:", "shell")), J("E:", "repo"));
  const fallback = resolveRepoRoot({}, J("C:", "work", "shell"));
  assert.ok(fallback.endsWith("sciencediscovery"), fallback);
  assert.ok(fallback.startsWith(J("C:", "work")), "default must sit next to the shell dir");
});

test("data dir: env wins, default is the profile-rooted .sciencediscovery", () => {
  assert.equal(resolveDataDir({ SCIENCE_DISCOVERY_DATA_DIR: J("D:", "data") }), J("D:", "data"));
  if (IS_DARWIN) {
    // darwin legacy/dev fallback: HOME/.sciencediscovery.
    assert.equal(resolveDataDir({ HOME: "/Users/x" }, "darwin"), "/Users/x/.sciencediscovery");
    // Injected win32 branch keeps its USERPROFILE contract on any host
    // (joined with the win32 dialect, spelled literally so the expectation
    // matches on a POSIX runner too).
    assert.equal(resolveDataDir({ USERPROFILE: "C:\\Users\\x" }, "win32"), "C:\\Users\\x\\.sciencediscovery");
  } else {
    const fallback = resolveDataDir({ USERPROFILE: "C:\\Users\\x" });
    assert.ok(fallback.endsWith(".sciencediscovery"), fallback);
  }
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
