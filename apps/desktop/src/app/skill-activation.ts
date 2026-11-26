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
 * What became of a package's switch after the package itself was installed.
 *
 * Installation and activation are two writes to two different stores: the
 * catalog owns the package, JiuwenSwarm owns its switch. A view that only
 * learns "installed" would show a success notice for a package no session can
 * select, so the enable step reports its own outcome and the view that is on
 * screen is the one that says what happened.
 */
export interface SkillActivationOutcome {
  /** `on`: switched on; `skipped`: this backend has no switch for the package
   *  or it was already installed; `failed`: the switch was refused or its
   *  state could not be read. */
  state: "failed" | "on" | "skipped";
  /** The server's own words for the failure, shown next to the retry. */
  error?: string;
  /** Set when no switch was tried because the state read itself failed, so the
   *  failure is "unknown", not "refused". */
  stateUnknown?: boolean;
}
