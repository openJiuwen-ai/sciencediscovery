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
 * HUAWEI sign-in callback, received from the system browser.
 *
 * The account service only redirects to an http(s) origin it allows, and the
 * deployed service allows `http://127.0.0.1:*` (the same wildcard its own
 * origin check implements). The shell therefore starts a one-shot server on an
 * ephemeral loopback port and hands that URL to the account service as the
 * sign-in `returnUrl`. The callback page runs in the browser and posts the
 * single-use ticket back to this server; the main process forwards it to the
 * renderer, which exchanges it for a session.
 *
 * The ticket stays in the fragment (`#auth-ticket=…`), so only the page in the
 * browser can read it — that is why the server serves a tiny page instead of
 * parsing the redirect itself.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

/** What the browser posted back: a ticket, or the service's failure marker. */
export interface SignInResult {
  ticket?: string;
  error?: string;
}

export interface SignInCallbackServer {
  /** The `returnUrl` handed to the account service. */
  callbackUrl: string;
  /** Stop accepting requests and release the port. Idempotent. */
  stop: () => void;
}

export interface StartSignInCallbackOptions {
  /** Called once, with the first ticket or error the browser posts. */
  onResult: (result: SignInResult) => void;
  /** Diagnostic line for the shell log. */
  log?: (line: string) => void;
  /** Abandon the flow after this long. Defaults to 10 minutes. */
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The page the browser lands on. It reads the fragment, posts it to the
 *  per-flow result URL derived from its own path, and says whether the app now
 *  has the sign-in. Plain and self-contained: no network fetches beyond the
 *  loopback POST, no external assets. The copy is bilingual because this page
 *  is rendered by the system browser, whose language the app cannot know. */
const CALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScienceDiscovery · 登录 / Sign-in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f7f9; color: #1f2328; }
  main { max-width: 32rem; padding: 2.5rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: .25rem 0; color: #57606a; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    p { color: #8b949e; }
  }
</style>
</head>
<body>
<main>
  <h1 id="title">正在确认登录… · Signing you in…</h1>
  <p id="status">请保持此页面打开，完成后可以返回 ScienceDiscovery 应用。<br>Keep this page open; you can return to the app when it finishes.</p>
</main>
<script>
(function () {
  var title = document.getElementById("title");
  var status = document.getElementById("status");
  var fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  var query = new URLSearchParams(location.search);
  var ticket = fragment.get("auth-ticket");
  var error = query.get("error") || fragment.get("error");
  if (ticket) {
    // Do not leave the single-use ticket in the address bar.
    history.replaceState(null, "", location.pathname);
  }
  // The result endpoint carries the same per-flow nonce as this page.
  var endpoint = location.pathname.replace(/^\\/callback\\//, "/result/");
  var body = ticket ? { ticket: ticket } : { error: error || "sign-in failed" };
  fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (response) {
    if (!response.ok) throw new Error("callback rejected");
    title.textContent = ticket ? "登录成功 · Signed in" : "登录未完成 · Sign-in did not complete";
    status.textContent = ticket
      ? "请返回 ScienceDiscovery 应用。 / Return to the ScienceDiscovery app."
      : "请返回应用后重试登录。 / Return to the app and try again.";
    window.close();
  }).catch(function () {
    title.textContent = "登录未完成 · Sign-in did not complete";
    status.textContent = "请返回应用后重试登录。 / Return to the app and try again.";
  });
})();
</script>
</body>
</html>`;

/** Headers every callback-page response carries: the page is a one-shot
 *  bridge, so nothing may frame it, and the fragment must not travel onward. */
const PAGE_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
};

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("callback body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Start a one-shot loopback server and resolve with its callback URL.
 *
 * The server accepts exactly one posted result; later posts are ignored. It
 * also stops itself after `timeoutMs`, or when `stop()` is called.
 */
export function startSignInCallbackServer(
  options: StartSignInCallbackOptions,
): Promise<SignInCallbackServer> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Unguessable per flow: it is what ties a posted result to this sign-in,
     *  so another page (or another local process) cannot settle it. */
    const nonce = randomBytes(18).toString("base64url");
    /** This server's own origin, known once it is listening. */
    let selfOrigin = "";

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === `/callback/${nonce}`) {
        send(response, 200, "text/html; charset=utf-8", CALLBACK_PAGE, PAGE_HEADERS);
        return;
      }
      if (request.method === "POST" && url.pathname === `/result/${nonce}`) {
        // Depth behind the nonce: the page this server served posts a JSON body
        // from its own origin. A cross-site `text/plain` POST, which needs no
        // preflight, fails both checks.
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== selfOrigin) {
          send(response, 403, "application/json; charset=utf-8", '{"ok":false,"error":"cross_origin"}');
          return;
        }
        const fetchSite = request.headers["sec-fetch-site"];
        if (fetchSite !== undefined && fetchSite !== "same-origin") {
          send(response, 403, "application/json; charset=utf-8", '{"ok":false,"error":"cross_origin"}');
          return;
        }
        const contentType = (request.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.startsWith("application/json")) {
          send(response, 415, "application/json; charset=utf-8", '{"ok":false,"error":"unsupported_media_type"}');
          return;
        }
        void readBody(request).then((text) => {
          let body: { ticket?: unknown; error?: unknown };
          try {
            body = JSON.parse(text) as { ticket?: unknown; error?: unknown };
          } catch {
            send(response, 400, "application/json; charset=utf-8", '{"ok":false,"error":"invalid_json"}');
            return;
          }
          const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
          const error = typeof body.error === "string" ? body.error.trim() : "";
          if (!ticket && !error) {
            send(response, 400, "application/json; charset=utf-8", '{"ok":false,"error":"missing_result"}');
            return;
          }
          if (finished) {
            // A second post cannot spend a second ticket: the first one won.
            send(response, 409, "application/json; charset=utf-8", '{"ok":false,"error":"already_received"}');
            return;
          }
          finished = true;
          send(response, 200, "application/json; charset=utf-8", '{"ok":true}');
          options.log?.(ticket ? "sign-in callback: ticket received" : `sign-in callback: ${error || "failed"}`);
          options.onResult(ticket ? { ticket } : { error: error || "sign-in failed" });
          stop();
          return;
        }).catch(() => {
          send(response, 400, "application/json; charset=utf-8", '{"ok":false,"error":"invalid_body"}');
        });
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "not found");
    });

    function stop(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      server.close();
      server.unref();
    }

    server.on("error", (error) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      // `listen` on a loopback port always yields an address; the guard is what
      // the compiler needs, and it also covers a server closed before this runs.
      const address = server.address();
      if (address === null || typeof address === "string") {
        stop();
        reject(new Error("callback server has no loopback address"));
        return;
      }
      selfOrigin = `http://127.0.0.1:${address.port}`;
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        options.log?.("sign-in callback timed out");
        stop();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      resolve({
        callbackUrl: `${selfOrigin}/callback/${nonce}`,
        stop,
      });
    });
  });
}
