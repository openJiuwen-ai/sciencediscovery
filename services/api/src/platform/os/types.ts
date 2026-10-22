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

/**
 * Options for restricting a file or directory to its owner.
 * `directory` selects the permission shape (0o700 / (OI)(CI)F) so callers
 * do not need a stat round-trip.
 */
export interface RestrictToOwnerOptions {
  directory?: boolean;
}

/**
 * OS adaptation surface for services/api (0.B2 分层约定 §2: 本包已有
 * bootstrap/platform.ts 依赖装配模块，OS 适配层固定在 platform/os/ 子目录).
 * Consumers import only index.ts; platform files are never imported directly.
 */
export interface OsAdaptation {
  /** chmod 0600/0700 on POSIX; icacls owner-only ACL on Windows. */
  restrictToOwner(path: string, options?: RestrictToOwnerOptions): Promise<void>;
  restrictToOwnerSync(path: string, options?: RestrictToOwnerOptions): void;
  /**
   * Atomic replace via rename. POSIX rename always replaces; on Windows the
   * replace can transiently fail with EPERM/EACCES/EBUSY while an antivirus
   * scanner or indexer holds the destination, so the win32 implementation
   * retries with backoff before giving up (炸点③-13).
   */
  renameReplace(source: string, destination: string): Promise<void>;
}
