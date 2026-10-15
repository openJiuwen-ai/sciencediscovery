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

import type { ChildProcess } from "node:child_process";

/** Options for restricting a file or directory to its owner. */
export interface RestrictToOwnerOptions {
  directory?: boolean;
}

/**
 * OS adaptation surface for services/runner (0.B2 分层约定 §2).
 * Consumers import only index.ts; platform files are never imported directly.
 */
export interface OsAdaptation {
  /**
   * POSIX: `chmod 0600/0700`. Windows: icacls owner-only ACL (0600 has no
   * POSIX meaning on NTFS; Node's chmod only toggles the read-only bit).
   */
  restrictToOwner(path: string, options?: RestrictToOwnerOptions): Promise<void>;

  /**
   * Kill a child and its whole tree. POSIX keeps Node's signal semantics
   * (the caller's signal reaches only the direct child, matching upstream);
   * Windows has no signals, so taskkill /T /F is the equivalent — and it
   * also covers grandchildren, which a bare `child.kill()` would orphan.
   */
  terminateTree(child: ChildProcess): boolean;
}
