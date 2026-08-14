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

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_BASELINE_VERSION = "multiarch-v1-profile-aware";

// These calls are not needed by the Python science slice and expand the kernel attack surface.
const DENIED_X86_64_SYSCALLS = [
  41, 42, 43, 49, 50, 53, 101, 155, 165, 166, 167, 168, 169, 175, 176,
  246, 248, 249, 250, 272, 288, 298, 304, 308, 310, 311, 313, 321, 323,
  425, 426, 427,
] as const;

// AArch64 uses the asm-generic syscall table. Deny the same syscall intent as
// the x86_64 profile: network sockets, privilege/namespace escape surfaces,
// kernel module/keyring/kexec interfaces, cross-process memory, BPF, userfaultfd,
// and io_uring.
const DENIED_AARCH64_SYSCALLS = [
  39, 40, 41, 97, 104, 105, 106, 117, 142, 198, 199, 200, 201, 202, 203,
  217, 218, 219, 224, 225, 242, 265, 268, 270, 271, 272, 273, 280, 282,
  425, 426, 427,
] as const;

const SECCOMP_PROFILES = {
  arm64: {
    auditArchitecture: AUDIT_ARCH_AARCH64,
    deniedSyscalls: DENIED_AARCH64_SYSCALLS,
    filename: "seccomp-aarch64.bpf",
  },
  x64: {
    auditArchitecture: AUDIT_ARCH_X86_64,
    deniedSyscalls: DENIED_X86_64_SYSCALLS,
    filename: "seccomp-x86_64.bpf",
  },
} as const;

function instruction(code: number, jumpTrue: number, jumpFalse: number, value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeUInt16LE(code, 0);
  result.writeUInt8(jumpTrue, 2);
  result.writeUInt8(jumpFalse, 3);
  result.writeUInt32LE(value >>> 0, 4);
  return result;
}

type SupportedSeccompArchitecture = keyof typeof SECCOMP_PROFILES;

function seccompProfile(architecture: string) {
  const profile = SECCOMP_PROFILES[architecture as SupportedSeccompArchitecture];
  if (!profile) {
    throw new Error(`Runner seccomp baseline is unavailable for architecture ${architecture}`);
  }
  return profile;
}

export function baselineSeccompFilter(architecture: string = process.arch): Buffer {
  const profile = seccompProfile(architecture);
  const instructions = [
    instruction(BPF_LD_W_ABS, 0, 0, 4),
    instruction(BPF_JMP_JEQ_K, 1, 0, profile.auditArchitecture),
    instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, 0, 0, 0),
  ];
  for (const syscall of profile.deniedSyscalls) {
    instructions.push(
      instruction(BPF_JMP_JEQ_K, 0, 1, syscall),
      instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM),
    );
  }
  instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return Buffer.concat(instructions);
}

export async function ensureBaselineSeccompFilter(
  dataDir: string,
  architecture: string = process.arch,
): Promise<string> {
  const profile = seccompProfile(architecture);
  const runtimeDirectory = resolve(dataDir, "runner-runtime");
  const path = resolve(runtimeDirectory, profile.filename);
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path, baselineSeccompFilter(architecture), { mode: 0o600 });
  return path;
}
