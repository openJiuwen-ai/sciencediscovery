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
 * Decides when a rejected access token should open the Connection settings.
 *
 * A wrong token makes every request fail, so "open the dialog on 401" would
 * reopen it dozens of times during one page load. The gate remembers which
 * token value it already prompted about: that token gets exactly one dialog no
 * matter how many requests fail, and a different token — the user's next
 * attempt — earns a fresh prompt.
 */
export interface AuthTokenPromptGate {
  /** True when this rejected token warrants opening the dialog now. */
  shouldPrompt(token: string): boolean;
}

export function createAuthTokenPromptGate(): AuthTokenPromptGate {
  let promptedToken: string | undefined;
  return {
    shouldPrompt(token: string): boolean {
      if (promptedToken === token) return false;
      promptedToken = token;
      return true;
    },
  };
}
