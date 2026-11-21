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
 * HUAWEI ID sign-in: the browser leaves for the HUAWEI ID page, the user signs
 * in there with their phone number and the code HUAWEI sends, and HUAWEI
 * redirects to the account service with an authorization code. The phone number
 * and the SMS never touch this app.
 *
 * `redirect_uri` is `<account service>/v1/auth/huawei/callback`, not this app.
 * The service starts the authorization with its own PKCE verifier, exchanges
 * the code, creates or loads the account, and sends the browser back to
 * `/login#auth-ticket=…`.
 * The ticket is single-use and short-lived; only the service can turn it into a
 * session, so an intercepted URL is worth little and nothing durable is left in
 * browser history.
 */

/** What the account service hands back in the fragment. */
export interface AuthorizeTicket {
  ticket: string;
}

/** Reads `#auth-ticket=…`, the one-time ticket the account service issued. */
export function readAuthTicket(hash: string): AuthorizeTicket | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const ticket = params.get("auth-ticket");
  if (!ticket) return undefined;
  return { ticket };
}

/** True when the account service reported a refusal as `#error=…`. */
export function readAuthorizeFailure(hash: string): boolean {
  return Boolean(new URLSearchParams(hash.replace(/^#/, "")).get("error"));
}
