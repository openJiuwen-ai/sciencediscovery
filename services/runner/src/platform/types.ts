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
 * Base starter-environment package specs (shared by both adaptations).
 * Platform files may substitute individual entries — see win32.ts.
 */
export const STARTER_PACKAGE_SPECS = {
  python: ["python=3.12", "numpy=2.0", "pandas=2.2", "scipy=1.14", "matplotlib=3.9"],
  r: ["r-base=4.4", "r-tidyverse=2.0", "r-data.table=1.16"],
} as const;

/**
 * OS adaptation surface for services/runner (platform facade convention).
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

  /**
   * Managed micromamba binary file name. Windows can only execute a
   * file whose extension is in PATHEXT, so the managed binary is
   * `micromamba.exe` there and `micromamba` elsewhere.
   */
  micromambaBinaryName: string;

  /**
   * Interpreter path inside a conda environment prefix. POSIX conda
   * layout keeps python/R under `bin/`; the win-64 layout puts `python.exe`
   * at the prefix root and `R.exe` under `Scripts/`.
   */
  environmentInterpreterPath(prefixPath: string, language: "python" | "r"): string;

  /**
   * Directories a direct (unsandboxed) execution must prepend to PATH so a
   * conda environment works without activation . win-64
   * interpreters delay-load DLLs from `Library\bin`, so win32 needs
   * `[prefix, prefix\Library\bin, prefix\Scripts]`; posix needs `[prefix/bin]`.
   */
  condaActivationPaths(prefixPath: string): string[];

  /**
   * Rename over an existing destination (same retry shape as the
   * API layer): Windows AV scanners/indexers briefly hold freshly written
   * files, so win32 backs off and retries EPERM/EACCES/EBUSY; posix passes
   * straight through to fs.rename.
   */
  renameReplace(source: string, destination: string): Promise<void>;

  /**
   * Starter environment package specs for a language. win32 substitutes
   * matplotlib-base for matplotlib: the qt6 dependency tree contains internal
   * paths deeper than MAX_PATH  even under a shallow prefix, and
   * agents render figures to files (Agg) rather than interactively.
   */
  starterPackages(language: "python" | "r"): string[];

  /**
   * Guidance appended to a failed package install. conda-forge win-64
   * covers fewer packages than linux-64, so when a solve reports a missing
   * package win32 points at the alternatives (pip name, WSL sandbox plugin,
   * remote execution) instead of leaving a raw solver dump. posix returns
   * null: the error passes through unchanged.
   */
  packageInstallGuidance(rawErrorMessage: string): string | null;

  /**
   * Shell interpreter inside a conda environment prefix. Windows hosts have
   * no bash; win32 starter envs preinstall m2-bash (MSYS2 port), landing at
   * `Library\usr\bin\bash.exe` (verified on a real install). posix conda layouts
   * also expose `bin/bash` for completeness; posix runners take the
   * bwrap/seatbelt path and never use the unsandboxed shell path.
   */
  environmentShellPath(prefixPath: string): string;
}
