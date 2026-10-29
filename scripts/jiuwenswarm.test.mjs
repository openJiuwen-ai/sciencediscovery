// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
const repo = fileURLToPath(new URL("../", import.meta.url));

for (const selection of [undefined, "relative runtime", "/tmp/explicit runtime"]) {
  test(`Swarm commands resolve one runtime root (${selection ?? "home default"})`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "sd-swarm-path-"));
    try {
      const bin = join(temporary, "src/.venv/bin");
      mkdirSync(bin, { recursive: true });
      const trace = join(temporary, "trace");
      writeFileSync(join(bin, "jiuwenswarm-start"), `#!/usr/bin/env bash
printf '%s\\n' "$HOME" "$JIUWENSWARM_HOME" "$JIUWENSWARM_DATA_DIR" "$*" >> '${trace}'
printf 'Status: stopped\\n  gateway: 20001\\n  web: 20000\\n'
`, { mode: 0o755 });
      const env = { ...process.env, SCIENCE_AGENT_JIUWENSWARM_OVERRIDES: "1", JIUWENSWARM_SRC: join(temporary, "src"), TRACE: trace };
      delete env.JIUWENSWARM_HOME;
      delete env.JIUWENSWARM_INSTANCE;
      if (selection !== undefined) env.JIUWENSWARM_HOME = selection;
      const root = selection === undefined ? join(process.env.HOME || homedir(), ".sciencediscovery/jiuwenswarm") : resolve(repo, selection);
      const output = execFileSync("bash", ["scripts/jiuwenswarm.sh", "env"], { cwd: repo, env, encoding: "utf8" });
      assert.match(output, /JIUWENSWARM_GATEWAY_URL=ws:\/\/127.0.0.1:20001\/tui/);
      execFileSync("bash", ["scripts/jiuwenswarm.sh", "stop"], { cwd: repo, env });
      const lines = readFileSync(trace, "utf8").trimEnd().split("\n");
      for (let index = 0; index < lines.length; index += 4) {
        assert.equal(lines[index], root);
        assert.equal(lines[index + 1], root);
        assert.equal(lines[index + 2], join(root, ".jiuwenswarm"));
        assert.match(lines[index + 3], /^(--status|--stop) sciencediscovery$/);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

test("stack starts its selected instance before resolving ports that may belong to another root", () => {
  const temporary = mkdtempSync(join(tmpdir(), "sd-swarm-start-"));
  try {
    writeFileSync(join(temporary, "jiuwenswarm.sh"), `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$TRACE"
case "$1" in
  start) touch "$TRACE.started" ;;
  env) test -f "$TRACE.started" || exit 1
    printf 'export JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:%s/tui\\n' "$TEST_PORT"
    printf 'export JIUWENSWARM_MGMT_URL=ws://127.0.0.1:20000/ws\\n' ;;
esac
`, { mode: 0o755 });
    const stack = readFileSync(join(repo, "scripts/start-stack.sh"), "utf8");
    const block = stack.slice(stack.indexOf("    # Where the JiuwenSwarm instance listens;"), stack.indexOf('    local gateway_port="${JIUWENSWARM_GATEWAY_URL##*:}"'));
    const env = { ...process.env, TRACE: join(temporary, "trace"), TEST_PORT: "20001", SCRIPT_DIR: temporary };
    env.JIUWENSWARM_GATEWAY_URL = "ws://foreign:1/tui";
    env.JIUWENSWARM_MGMT_URL = "ws://foreign:2/ws";
    execFileSync("bash", ["-ec", `script_dir="$SCRIPT_DIR"; use_jiuwenswarm=1; ${block}`], { env });
    assert.deepEqual(readFileSync(env.TRACE, "utf8").trim().split("\n"), ["start", "env"]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

for (const optIn of [false, true]) {
  test(`inherited Swarm controls require explicit override opt-in (${optIn})`, () => {
    const env = { ...process.env, SCIENCE_AGENT_JIUWENSWARM_OVERRIDES: optIn ? "1" : "0",
      JIUWENSWARM_HOME: "/standalone", JIUWENSWARM_DATA_DIR: "/foreign-data", JIUWENSWARM_UNKNOWN: "foreign" };
    const output = execFileSync("bash", ["-ec", 'source scripts/swarm-env.sh; configure_swarm_environment; printf "%s|%s|%s" "${JIUWENSWARM_HOME:-}" "${JIUWENSWARM_DATA_DIR:-}" "${JIUWENSWARM_UNKNOWN:-}"'],
      { cwd: repo, env, encoding: "utf8" });
    assert.equal(output, optIn ? "/standalone||" : "||");
  });
}

for (const explicit of [false, true]) {
  test(`Docker keeps its persisted runtime namespace (override=${explicit})`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "sd-swarm-docker-"));
    try {
      const stack = readFileSync(join(repo, "scripts/start-stack.sh"), "utf8");
      const start = stack.indexOf("  # Preserve the container's existing persisted-home layout");
      const end = stack.indexOf('\n\n  if [[ ! -x "$gateway_python"', start);
      const env = { ...process.env, SCIENCE_AGENT_ADAPTER: "1", DATA: temporary };
      delete env.JIUWENSWARM_HOME;
      if (explicit) env.JIUWENSWARM_HOME = join(temporary, "chosen");
      const result = execFileSync("bash", ["-ec", `data_dir="$DATA"; ${stack.slice(start, end)}\nprintf '%s' "$JIUWENSWARM_HOME"`], { env, encoding: "utf8" });
      assert.equal(result, join(temporary, explicit ? "chosen" : ".home"));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
