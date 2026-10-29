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
 * OS adaptation surface for services/api (the package already has a
 * bootstrap/platform.ts wiring module; the OS facade lives in platform/os/).
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
   * retries with backoff before giving up.
   */
  renameReplace(source: string, destination: string): Promise<void>;
  /**
   * At-rest secret wrapping. POSIX is the identity protector — file
   * permissions carry the protection there; Windows wraps secrets with DPAPI
   * (CurrentUser scope) so a copied or synced file is useless off this
   * account.
   */
  secretProtector: SecretProtector;
}

/**
 * Wraps raw secret bytes for at-rest storage and unwraps them on read.
 * `isWrapped` lets a reader distinguish a wrapped payload from a legacy raw
 * one without knowing the platform, so secret file formats stay
 * platform-agnostic in the store layer.
 */
export interface SecretProtector {
  /** True when the bytes are a wrapped payload this protector can unwrap. */
  isWrapped(bytes: Buffer): boolean;
  /** False when wrap() is the identity (protection relies on file ACLs). */
  readonly wrapsAtRest: boolean;
  wrap(plain: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}
