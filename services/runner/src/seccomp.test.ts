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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { baselineSeccompFilter, ensureBaselineSeccompFilter } from "./seccomp.js";

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;

function deniedSyscalls(filter: Buffer): number[] {
  const syscalls: number[] = [];
  // Four prologue instructions precede comparison/errno pairs; the final
  // instruction allows every syscall that did not match a denied number.
  for (let offset = 4 * 8; offset < filter.length - 8; offset += 2 * 8) {
    syscalls.push(filter.readUInt32LE(offset + 4));
  }
  return syscalls;
}

function auditArchitecture(filter: Buffer): number {
  return filter.readUInt32LE(8 + 4);
}

test("baseline seccomp denies x86_64 socket-family and listener syscalls", () => {
  const filter = baselineSeccompFilter("x64");
  assert.equal(auditArchitecture(filter), AUDIT_ARCH_X86_64);
  const denied = deniedSyscalls(filter);
  for (const syscall of [41, 42, 43, 49, 50, 53, 288]) assert.ok(denied.includes(syscall));
});

test("baseline seccomp denies aarch64 socket-family and listener syscalls", () => {
  const filter = baselineSeccompFilter("arm64");
  assert.equal(auditArchitecture(filter), AUDIT_ARCH_AARCH64);
  const denied = deniedSyscalls(filter);
  for (const syscall of [198, 199, 200, 201, 202, 203, 242]) assert.ok(denied.includes(syscall));
  for (const syscall of [40, 41, 97, 104, 105, 106, 117, 142, 217, 218, 219, 224, 225, 265, 268, 270, 271, 272, 273, 280, 282, 425, 426, 427]) {
    assert.ok(denied.includes(syscall));
  }
  assert.equal(denied.includes(241), false);
});

test("baseline seccomp rejects unsupported architectures", () => {
  assert.throws(() => baselineSeccompFilter("riscv64"), /unavailable for architecture riscv64/);
});

test("baseline seccomp writes architecture-specific filter files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciencediscovery-seccomp-"));
  try {
    const x64Path = await ensureBaselineSeccompFilter(root, "x64");
    const arm64Path = await ensureBaselineSeccompFilter(root, "arm64");
    assert.match(x64Path, /seccomp-x86_64\.bpf$/);
    assert.match(arm64Path, /seccomp-aarch64\.bpf$/);
    assert.equal(auditArchitecture(await readFile(x64Path)), AUDIT_ARCH_X86_64);
    assert.equal(auditArchitecture(await readFile(arm64Path)), AUDIT_ARCH_AARCH64);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
