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

// [windows-desktop] the single platform dispatch point. Consumers import this
// module only; platform files are never imported directly, and no
// `process.platform === "win32"` branches may appear in consumer code.

import { posixAdaptation } from "./posix.js";
import type { OsAdaptation } from "./types.js";
import { win32Adaptation } from "./win32.js";

const adaptation: OsAdaptation = process.platform === "win32" ? win32Adaptation : posixAdaptation;

export const restrictToOwner: OsAdaptation["restrictToOwner"] = adaptation.restrictToOwner;
export const restrictToOwnerSync: OsAdaptation["restrictToOwnerSync"] = adaptation.restrictToOwnerSync;
export const renameReplace: OsAdaptation["renameReplace"] = adaptation.renameReplace;
export const secretProtector: OsAdaptation["secretProtector"] = adaptation.secretProtector;
export type { RestrictToOwnerOptions, SecretProtector } from "./types.js";
