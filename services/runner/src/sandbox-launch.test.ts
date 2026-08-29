// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath as realpathFs, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { resetSandboxCapabilityCache, type SandboxProcMode } from "@sciencediscovery/sandbox-capability";

import {
  buildSandboxLaunch,
  hostInterpreterMaskArguments,
  resolveHostRuntimeSupport,
  sandboxLaunchProfile,
  type HostRuntimeSupport,
} from "./executor.js";

/** Quote for a shell single-quoted string; bubblewrap messages contain apostrophes. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

const PROC_EPERM = "bwrap: Can't mount proc on /newroot/proc: Operation not permitted";
const USERNS_EROFS = "bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system";

function launch(options: {
  disableUserns: boolean;
  hostRuntimeSupport?: HostRuntimeSupport;
  procMode: SandboxProcMode;
}) {
  return buildSandboxLaunch({
    chdir: "/workspace",
    disableUserns: options.disableUserns,
    environmentBinds: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: options.hostRuntimeSupport ?? { bindArgs: [], env: {} },
    language: "python",
    pathEnv: "/usr/bin",
    procMode: options.procMode,
    workspaceBindArgs: ["--bind", "/data/workspace", "/workspace"],
  });
}

function launchArguments(options: { disableUserns: boolean; procMode: SandboxProcMode }): string[] {
  return launch(options).args;
}

/** Isolation that must survive either degradation, checked as adjacent pairs. */
function assertBaselineIsolation(args: string[]): void {
  for (const option of ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session"]) {
    assert.ok(args.includes(option), `expected ${option}`);
  }
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--seccomp") + 1], "3");
  assert.ok(args.includes("--clearenv"));
  assert.equal(args[args.indexOf("--ro-bind") + 1], "/usr");
  // /proc is provided one way or the other; it is never simply dropped.
  assert.ok(args.includes("--proc") || args.join(" ").includes("--ro-bind /proc /proc"));
}

describe("sandbox launch arguments", () => {
  test("mounts a fresh /proc and adds --disable-userns in the full profile", () => {
    const args = launchArguments({ disableUserns: true, procMode: "new" });
    assert.ok(args.includes("--disable-userns"));
    assert.equal(args[args.indexOf("--proc") + 1], "/proc");
    assert.ok(!args.join(" ").includes("--ro-bind /proc /proc"));
    // Order matters: the option is only meaningful after --unshare-user.
    assert.ok(args.indexOf("--unshare-user") < args.indexOf("--disable-userns"));
    assertBaselineIsolation(args);
  });

  test("binds /proc in the fallback profile without weakening anything else", () => {
    const args = launchArguments({ disableUserns: true, procMode: "bind" });
    assert.ok(!args.includes("--proc"));
    assert.ok(args.join(" ").includes("--ro-bind /proc /proc"));
    assertBaselineIsolation(args);
    // The fallback differs from the default by exactly the /proc arguments.
    const fresh = launchArguments({ disableUserns: true, procMode: "new" });
    const strip = (list: string[]) =>
      list.join(" ").replace("--ro-bind /proc /proc", "@proc@").replace("--proc /proc", "@proc@");
    assert.equal(strip(args), strip(fresh));
  });

  test("omits --disable-userns without weakening any other isolation", () => {
    const args = launchArguments({ disableUserns: false, procMode: "new" });
    assert.ok(!args.includes("--disable-userns"));
    assertBaselineIsolation(args);
    assert.deepEqual(
      launchArguments({ disableUserns: true, procMode: "new" })
        .filter((argument) => argument !== "--disable-userns"),
      args,
    );
  });

  test("supports both degradations at once", () => {
    const args = launchArguments({ disableUserns: false, procMode: "bind" });
    assert.ok(!args.includes("--disable-userns"));
    assert.ok(!args.includes("--proc"));
    assert.ok(args.join(" ").includes("--ro-bind /proc /proc"));
    assertBaselineIsolation(args);
  });
});

describe("host CA trust inside the sandbox", () => {
  /** Adjacent `--ro-bind <source> <target>` triples, as bwrap reads them. */
  function readOnlyBinds(args: string[]): Array<{ source: string; target: string }> {
    return args.flatMap((argument, index) => argument === "--ro-bind"
      ? [{ source: args[index + 1]!, target: args[index + 2]! }]
      : []);
  }

  test("carries the resolved trust store into the binds and the environment", () => {
    const built = launch({
      disableUserns: true,
      hostRuntimeSupport: {
        bindArgs: ["--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"],
        env: { SSL_CERT_DIR: "/etc/ssl/certs", SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt" },
      },
      procMode: "new",
    });
    assert.ok(readOnlyBinds(built.args).some(
      ({ source, target }) => source === "/etc/ssl/certs" && target === "/etc/ssl/certs",
    ));
    assert.equal(built.env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt");
    assert.equal(built.env.SSL_CERT_DIR, "/etc/ssl/certs");
    // Trust is not reachability: nothing here opens a network path.
    assert.ok(!built.args.includes("--share-net"));
    assertBaselineIsolation(built.args);
  });

  test("binds a real trust store from this host and points TLS clients at it", async (t) => {
    const support = await resolveHostRuntimeSupport();
    const binds = readOnlyBinds(support.bindArgs);
    const trustStores = binds.filter(({ source }) => source.startsWith("/etc/ssl/") || source.startsWith("/etc/pki/"));
    if (trustStores.length === 0) {
      t.skip("this host has no system CA trust store to bind");
      return;
    }
    // Every bundle the environment advertises must be reachable in the sandbox,
    // otherwise curl fails on the missing file (exit 77) exactly as before.
    for (const key of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"]) {
      const bundle = support.env[key];
      assert.ok(bundle, `expected ${key}`);
      assert.ok(
        binds.some(({ target }) => bundle === target || bundle!.startsWith(`${target}/`)),
        `${key}=${bundle} is not covered by a bind`,
      );
    }
    const built = launch({ disableUserns: true, hostRuntimeSupport: support, procMode: "new" });
    assert.ok(!built.args.includes("--share-net"));
    assertBaselineIsolation(built.args);
  });
});

describe("detection feeding the launch", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-runner-sandbox-"));
    resetSandboxCapabilityCache();
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  async function stubBwrap(name: string, rejects: Array<{ argument: string; failure: string }>): Promise<string> {
    const path = join(workspace, name);
    await writeFile(path, [
      "#!/bin/sh",
      'for candidate in "$@"; do',
      "  :",  // keep the loop body non-empty when nothing is rejected
      ...rejects.flatMap(({ argument, failure }) => [
        `  if [ "$candidate" = "${argument}" ]; then`,
        `    echo ${shellQuote(failure)} >&2`,
        "    exit 1",
        "  fi",
      ]),
      "done",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(path, 0o755);
    return path;
  }

  test("keeps the full profile where nothing is refused", async () => {
    const stub = await stubBwrap("bwrap-supported", []);
    const profile = await sandboxLaunchProfile(stub);
    assert.deepEqual(profile, { disableUserns: true, procMode: "new" });
    const args = launchArguments(profile);
    assert.ok(args.includes("--proc"));
    assert.ok(args.includes("--disable-userns"));
  });

  test("binds /proc when a fresh procfs is refused, and still builds a launch", async () => {
    // Docker without systempaths=unconfined.
    const stub = await stubBwrap("bwrap-proc-eperm", [{ argument: "--proc", failure: PROC_EPERM }]);
    const profile = await sandboxLaunchProfile(stub);
    assert.deepEqual(profile, { disableUserns: true, procMode: "bind" });
    const args = launchArguments(profile);
    assert.ok(!args.includes("--proc"));
    assert.ok(args.join(" ").includes("--ro-bind /proc /proc"));
    assertBaselineIsolation(args);
  });

  test("degrades both axes where the environment refuses both", async () => {
    const stub = await stubBwrap("bwrap-both", [
      { argument: "--proc", failure: PROC_EPERM },
      { argument: "--disable-userns", failure: USERNS_EROFS },
    ]);
    const profile = await sandboxLaunchProfile(stub);
    assert.deepEqual(profile, { disableUserns: false, procMode: "bind" });
    const args = launchArguments(profile);
    assert.ok(!args.includes("--proc"));
    assert.ok(!args.includes("--disable-userns"));
    assertBaselineIsolation(args);
  });

  test("does not touch /proc when only --disable-userns is refused", async () => {
    const stub = await stubBwrap("bwrap-userns-only", [
      { argument: "--disable-userns", failure: USERNS_EROFS },
    ]);
    const profile = await sandboxLaunchProfile(stub);
    assert.deepEqual(profile, { disableUserns: false, procMode: "new" });
    assert.ok(launchArguments(profile).includes("--proc"));
  });
});

describe("host interpreter masks", () => {
  let root = "";

  before(async () => {
    // A RHEL-family /usr/bin: the interpreters are symlinks through
    // /etc/alternatives and only the versioned binary is a real file.
    // realpath: on macOS /var is itself a symlink to /private/var, and the
    // function under test resolves its targets — the fixture root has to be
    // resolved the same way or the comparison fails on the prefix alone.
    root = await realpathFs(await mkdtemp(join(tmpdir(), "mask-")));
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "libexec"), { recursive: true });
    await mkdir(join(root, "alternatives"), { recursive: true });
    await writeFile(join(root, "libexec", "platform-python3.6"), "#!/bin/sh\n");
    await symlink(join(root, "libexec", "platform-python3.6"), join(root, "alternatives", "python3"));
    await symlink(join(root, "alternatives", "python3"), join(root, "bin", "python3.6"));
    await symlink(join(root, "bin", "python3.6"), join(root, "bin", "python3"));
    await symlink(join(root, "bin", "python3"), join(root, "bin", "python"));
    // A real file alongside them, the Debian-family shape.
    await writeFile(join(root, "bin", "python3.8"), "#!/bin/sh\n");
    // Something that must not be masked at all.
    await writeFile(join(root, "bin", "pythonic-tool"), "#!/bin/sh\n");
    // A dangling alternatives link: nothing to mask, and it must not throw.
    await symlink(join(root, "alternatives", "gone"), join(root, "bin", "Rscript"));
  });

  after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  test("masks the resolved target, never the symlink itself", async () => {
    const args = await hostInterpreterMaskArguments(join(root, "bin"));
    const targets = args.filter((_, at) => at % 3 === 2);

    // Binding onto a symlink makes bwrap follow it and try to create the
    // mountpoint at the far end, inside the read-only /usr bind. That fails the
    // whole launch — "Can't create file at /usr/bin/python" — and takes every
    // run_python on the host with it.
    for (const target of targets) {
      assert.equal((await lstat(target)).isSymbolicLink(), false, `${target} is a symlink`);
    }
  });

  test("four names sharing one real interpreter collapse to one mask", async () => {
    const args = await hostInterpreterMaskArguments(join(root, "bin"));
    const targets = args.filter((_, at) => at % 3 === 2);

    assert.deepEqual(targets.sort(), [
      join(root, "bin", "python3.8"),
      join(root, "libexec", "platform-python3.6"),
    ].sort());
  });

  test("a name that merely starts with python is left alone", async () => {
    const args = await hostInterpreterMaskArguments(join(root, "bin"));

    assert.ok(!args.some((arg) => arg.endsWith("pythonic-tool")));
  });

  test("a dangling link is skipped rather than failing the launch", async () => {
    // Every sandbox launch on the host calls this; throwing here would mean no
    // execution at all, for a link that points at nothing anyway.
    const args = await hostInterpreterMaskArguments(join(root, "bin"));

    assert.ok(!args.some((arg) => arg.includes("Rscript")));
  });
});
