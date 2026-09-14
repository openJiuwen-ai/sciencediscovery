// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { killSandboxProcess, spawnSandboxProcess } from "./executor.js";

test("sandbox cancellation kills monitor and descendants before parent-death binding", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-group-"));
  // Model bwrap's startup window: its descendant exists but has not yet bound
  // its lifetime to the monitor. Both keep stdout open. Killing only the
  // monitor must fail this regression, regardless of scheduler timing.
  const descendant = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
  const monitor = `require("node:child_process").spawn(process.execPath,
    ["-e", ${JSON.stringify(descendant)}], {stdio: ["ignore", 1, 2]});
    setInterval(() => {}, 1000);`;
  const child = await spawnSandboxProcess({ dataDir: root, bwrapPath: process.execPath }, {
    args: ["--new-session"], commandPrefix: [], chdir: root, env: {}, sandbox: "bubblewrap",
  }, ["-e", monitor], "baseline");
  const closed = once(child, "close");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((done) => {
        let output = "";
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("ready\n")) {
            child.stdout.removeListener("data", read);
            done();
          }
        };
        child.stdout.on("data", read);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("descendant did not start")), 5000); }),
    ]);
    clearTimeout(timer);
    assert.equal(killSandboxProcess(child), true);
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("descendant kept sandbox pipes open after cancellation")), 1500); }),
    ]);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    clearTimeout(timer);
    // Independent cleanup also works when testing the broken single-PID kill.
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
