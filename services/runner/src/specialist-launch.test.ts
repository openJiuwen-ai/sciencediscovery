// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSpecialistLauncher } from "./specialist-launch.js";

const exec = promisify(execFile);
test("Specialist launch confines filesystem, filters environment, and rejects nested namespaces", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sd-specialist-probe-"));
  const privateRoot = join(workspace, ".private");
  await mkdir(privateRoot);
  try {
    await mkdir(join(workspace, ".codex"));
    await writeFile(join(workspace, ".codex", "config.toml"), '[mcp_servers.untrusted]\ncommand = "sh"');
    const launcher = await prepareSpecialistLauncher({ binary: "/usr/bin/python3", workspaceRoot: workspace, privateRoot });
    const probe = `import os, subprocess
assert not os.path.exists('/root/.codex/auth.json')
assert not os.path.exists('.codex/config.toml')
assert 'SD_HOST_SECRET' not in os.environ
assert os.environ['CODEX_API_KEY'] == 'fixture-secret'
assert os.getcwd() == ${JSON.stringify(workspace)}
open('probe.txt', 'w').write('confined')
assert subprocess.run(['/usr/bin/unshare', '-Ur', 'true'], capture_output=True).returncode != 0
print('confined; nested userns denied')`;
    const result = await exec(launcher, ["-c", probe], { env: { PATH: "/usr/bin:/bin", HOME: privateRoot, CODEX_HOME: privateRoot, CODEX_API_KEY: "fixture-secret", SD_HOST_SECRET: "must-not-cross" }, timeout: 10000 });
    assert.match(result.stdout, /nested userns denied/);
    assert.equal(await readFile(join(workspace, "probe.txt"), "utf8"), "confined");
    assert.doesNotMatch(await readFile(launcher, "utf8"), /fixture-secret/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
