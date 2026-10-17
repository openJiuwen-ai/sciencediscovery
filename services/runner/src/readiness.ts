// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { detectSandboxCapability, detectSeatbeltCapability, sandboxUnusableMessage, procFallbackMessage, disableUsernsOmittedMessage, missingSandboxExecutableMessage } from "@sciencediscovery/sandbox-capability";
import type { RunnerExecutionCapability } from "@sciencediscovery/schema";

const execute = promisify(execFile);
const requiredOptions = ["--cap-drop", "--die-with-parent", "--new-session", "--seccomp", "--unshare-all", "--unshare-user"];

/** One bounded, single-flight probe in the actual execution process. */
export class RunnerReadiness {
  private readonly instanceId = randomUUID();
  private cached?: RunnerExecutionCapability;
  private pending?: Promise<RunnerExecutionCapability>;
  constructor(private readonly sandbox: "bubblewrap" | "seatbelt", private readonly executable: string) {}

  async get(refresh = false): Promise<RunnerExecutionCapability> {
    if (this.pending) return this.pending;
    if (!refresh && this.cached) return this.cached;
    this.pending = this.probe().then(value => (this.cached = value)).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async probe(): Promise<RunnerExecutionCapability> {
    const report: RunnerExecutionCapability = {
      instanceId: this.instanceId, checkedAt: new Date().toISOString(), sandbox: this.sandbox,
      dependencyAvailable: false, sandboxUsable: false, ready: false, reason: "dependency-unavailable",
    };
    try {
      const result = await execute(this.executable, this.sandbox === "bubblewrap" ? ["--help"] : ["-h"],
        { timeout: 5000, maxBuffer: 1024 * 1024 });
      report.dependencyAvailable = true;
      if (this.sandbox === "bubblewrap") {
        const missing = requiredOptions.filter(option => !`${result.stdout}\n${result.stderr}`.includes(option));
        if (missing.length) return { ...report, reason: "incompatible", detail: `Missing sandbox options: ${missing.join(", ")}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A spawn failure means the executable is missing or not executable; say
      // how to install it instead of passing on the bare ENOENT.
      if (["ENOENT", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))) {
        return { ...report, detail: missingSandboxExecutableMessage(this.sandbox, this.executable, message) };
      }
      // sandbox-exec's help returns nonzero on some macOS versions. Only a
      // spawn failure proves it missing; the real profile probe is authoritative.
      if (this.sandbox === "bubblewrap") return { ...report, detail: message };
      report.dependencyAvailable = true;
    }
    try {
      const capability = this.sandbox === "seatbelt"
        ? await detectSeatbeltCapability(this.executable, { refresh: true })
        : await this.probeBubblewrap();
      return { ...report, checkedAt: new Date().toISOString(), sandboxUsable: capability.sandboxUsable,
        ready: capability.sandboxUsable, reason: capability.sandboxUsable ? "ready" : "sandbox-unusable",
        ...(capability.detail ? { detail: capability.detail } : {}) };
    } catch (error) {
      return { ...report, reason: "sandbox-unusable", detail: String(error) };
    }
  }

  private async probeBubblewrap() {
    const capability = await detectSandboxCapability(this.executable, { refresh: true });
    if (!capability.sandboxUsable) console.warn(sandboxUnusableMessage(this.executable, capability));
    else {
      if (capability.procFallback) console.warn(procFallbackMessage(this.executable, capability));
      if (!capability.disableUserns) console.warn(disableUsernsOmittedMessage(this.executable, capability));
    }
    return capability;
  }
}
