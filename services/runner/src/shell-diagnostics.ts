// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ShellExecutionResult } from "@sciencediscovery/schema";

type ShellDiagnostic = NonNullable<ShellExecutionResult["diagnostic"]>;

/** Exit 127 alone is ambiguous: scripts may return it intentionally. Only add
 * guidance when Bash also names a simple command in its standard failure. */
export function shellFailureDiagnostic(exitCode: number, stderr: string): ShellDiagnostic | undefined {
  if (exitCode !== 127) return undefined;
  const command = /(?:^|\n)(?:[^\r\n]*?: )?(?:line \d+: )?([A-Za-z0-9._+-]+): command not found(?:\r?\n|$)/u
    .exec(stderr)?.[1];
  if (!command) return undefined;
  return {
    code: "COMMAND_NOT_FOUND",
    command,
    instruction: "Inspect check_runner shell.utilities and use an available command or Python equivalent; do not retry the same command unchanged.",
  };
}
