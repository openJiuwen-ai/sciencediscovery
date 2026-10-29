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

import { chmodSync } from "node:fs";
import { chmod, rename } from "node:fs/promises";

import type { OsAdaptation, RestrictToOwnerOptions, SecretProtector } from "./types.js";

function modeFor(options?: RestrictToOwnerOptions): number {
  return options?.directory ? 0o700 : 0o600;
}

/**
 * No wrapping on POSIX: the 0600 file permission is the at-rest protection,
 * so raw bytes are stored and read back unchanged.
 */
export const identitySecretProtector: SecretProtector = {
  wrapsAtRest: false,
  isWrapped: () => false,
  async wrap(plain) {
    return plain;
  },
  async unwrap(wrapped) {
    return wrapped;
  },
};

export const posixAdaptation: OsAdaptation = {
  secretProtector: identitySecretProtector,
  restrictToOwner(path, options) {
    return chmod(path, modeFor(options));
  },
  restrictToOwnerSync(path, options) {
    chmodSync(path, modeFor(options));
  },
  renameReplace(source, destination) {
    return rename(source, destination);
  },
};
