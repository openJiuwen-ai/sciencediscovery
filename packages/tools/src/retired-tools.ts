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
 * Tools that used to exist in the registry but were removed. A model that
 * still emits one of these names gets a recoverable error that points at the
 * replacement, instead of an opaque UNKNOWN_TOOL card that wastes a turn.
 *
 * Do not invent a fake tool that executes under the old name. The call remains
 * a failure; only the message and retryable flag change so the next call can
 * use the real tool.
 */
const RETIRED_TOOLS: Readonly<Record<string, string>> = {
  run_python:
    "Tool \"run_python\" was removed. Use run_shell with exactly one of command "
    + "(for example python -c '...' or python path/to/script.py) or scriptPath. "
    + "Select environment_id from environment_list when a managed environment is needed.",
  run_r:
    "Tool \"run_r\" was removed. Use run_shell with exactly one of command "
    + "(for example Rscript path/to/script.R) or scriptPath. "
    + "Select environment_id from environment_list when a managed environment is needed.",
};

export function retiredToolGuidance(name: string): string | undefined {
  return RETIRED_TOOLS[name];
}
