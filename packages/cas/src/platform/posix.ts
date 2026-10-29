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

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { OsAdaptation } from "./types.js";

export const posixAdaptation: OsAdaptation = {
  async syncDirectory(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  // Posix keeps the historical full-length sha256 name so coordination and
  // lease files already on disk — including `<digest>.failed` poison markers
  // — stay readable across upgrades; only win32 shortens it (MAX_PATH
  // headroom, see win32.ts). The coordination directory is machine-local, so
  // lock names never need to match across platforms.
  lockFileName(key) {
    return createHash("sha256").update(key).digest("hex");
  },
};
