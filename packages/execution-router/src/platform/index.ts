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

// [windows-desktop] 0.B2 §2: the single dispatch point. Consumers import this
// module only; platform files are never imported directly, and no
// `process.platform === "win32"` branches may appear in consumer code.

import { posixWslPlatform } from "./posix.js";
import type { WslCommandRunner, WslPlatform } from "./types.js";
import { detectWslState as detectWslStateWin32 } from "./win32.js";

const platform: WslPlatform = process.platform === "win32"
  ? { detectWslState: (run?: WslCommandRunner) => detectWslStateWin32(run) }
  : posixWslPlatform;

export const detectWslState: WslPlatform["detectWslState"] = platform.detectWslState;
export type { WslCommandRunner } from "./types.js";
