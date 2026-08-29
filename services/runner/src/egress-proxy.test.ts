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

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EgressProxyCredentialsError,
  egressProxyForTarget,
  proxyAuthorizationHeader,
  proxyAuthorizationValue,
  proxyEndpoint,
  proxyPort,
} from "./egress-proxy.js";

const TARGET = { host: "example.org", port: 443, tls: true } as const;
const PLAIN = { host: "example.org", port: 80, tls: false } as const;

test("direct and url policies are used exactly as the API resolved them", () => {
  assert.equal(egressProxyForTarget(undefined, TARGET, {}), undefined);
  assert.equal(egressProxyForTarget({ mode: "direct" }, TARGET, {}), undefined);
  const proxy = egressProxyForTarget({ mode: "url", url: "http://proxy.test:3128" }, TARGET, {});
  assert.equal(proxy?.host, "proxy.test:3128");
  assert.equal(proxyPort(proxy!), 3128);
  // The environment is irrelevant once the registry named one server.
  assert.equal(
    egressProxyForTarget({ mode: "url", url: "http://proxy.test:3128" }, TARGET, { HTTPS_PROXY: "http://other.test:1" })?.host,
    "proxy.test:3128",
  );
});

test("an environment policy follows the same variable rules as the model stack", () => {
  const environment = { mode: "environment" } as const;
  // Protocol-specific first: HTTP_PROXY is deliberately not an HTTPS fallback.
  assert.equal(
    egressProxyForTarget(environment, TARGET, { HTTPS_PROXY: "http://tls.test:8080", HTTP_PROXY: "http://plain.test:8080" })?.host,
    "tls.test:8080",
  );
  assert.equal(
    egressProxyForTarget(environment, PLAIN, { HTTPS_PROXY: "http://tls.test:8080", HTTP_PROXY: "http://plain.test:8080" })?.host,
    "plain.test:8080",
  );
  assert.equal(egressProxyForTarget(environment, TARGET, { HTTP_PROXY: "http://plain.test:8080" }), undefined);
  // ALL_PROXY is the fallback for both.
  assert.equal(egressProxyForTarget(environment, TARGET, { ALL_PROXY: "http://any.test:8080" })?.host, "any.test:8080");
  // A present lowercase variable wins over its uppercase twin.
  assert.equal(
    egressProxyForTarget(environment, TARGET, { https_proxy: "http://lower.test:8080", HTTPS_PROXY: "http://upper.test:8080" })?.host,
    "lower.test:8080",
  );
  assert.equal(egressProxyForTarget(environment, TARGET, {}), undefined);
});

test("NO_PROXY bypasses the environment proxy for the hosts it names", () => {
  const environment = { mode: "environment" } as const;
  const base = { HTTPS_PROXY: "http://tls.test:8080" };
  assert.equal(egressProxyForTarget(environment, TARGET, { ...base, NO_PROXY: "example.org" }), undefined);
  assert.equal(egressProxyForTarget(environment, TARGET, { ...base, NO_PROXY: "*" }), undefined);
  assert.equal(
    egressProxyForTarget({ ...environment }, { host: "api.example.org", port: 443, tls: true }, { ...base, no_proxy: ".example.org" }),
    undefined,
  );
  assert.equal(egressProxyForTarget(environment, TARGET, { ...base, NO_PROXY: "other.test" })?.host, "tls.test:8080");
  // A port-qualified entry only bypasses that port.
  assert.equal(egressProxyForTarget(environment, TARGET, { ...base, NO_PROXY: "example.org:8443" })?.host, "tls.test:8080");
  assert.equal(egressProxyForTarget(environment, TARGET, { ...base, NO_PROXY: "example.org:443" }), undefined);
});

test("a proxy this gateway cannot speak to is refused rather than silently bypassed", () => {
  // Chaining is an HTTP proxy conversation, so a socks5 registry entry has to
  // fail loudly: quietly connecting direct would leave the deployment's egress.
  assert.throws(
    () => egressProxyForTarget({ mode: "url", url: "socks5://proxy.test:1080" }, TARGET, {}),
    /cannot send allowed traffic through a socks5 proxy/,
  );
  assert.throws(() => egressProxyForTarget({ mode: "url", url: "not a url" }, TARGET, {}), /invalid egress proxy URL/);
  assert.throws(
    () => egressProxyForTarget({ mode: "environment" }, TARGET, { HTTPS_PROXY: "socks5://proxy.test:1080" }),
    /cannot send allowed traffic through a socks5 proxy/,
  );
});

test("userinfo that cannot be decoded fails where the route is resolved", () => {
  // `normalizeProxyUrl` keeps a stray `%` as written, so a saved registry entry
  // can reach the runner with userinfo that `decodeURIComponent` rejects. That
  // has to surface here, inside the gateway's route guard — the alternative is
  // a throw from a socket callback, which takes the runner process down.
  const malformed = "http://user%zz:p@proxy.test:3128";
  for (const resolved of [
    { mode: "url", url: malformed } as const,
    { mode: "environment" } as const,
  ]) {
    assert.throws(
      () => egressProxyForTarget(resolved, TARGET, { HTTPS_PROXY: malformed }),
      (error: Error) => {
        assert.ok(error instanceof EgressProxyCredentialsError, error.message);
        assert.match(error.message, /username of the egress proxy http:\/\/proxy\.test:3128/);
        assert.match(error.message, /not valid percent-encoding/);
        return true;
      },
    );
  }
  // A malformed password is caught the same way, and neither message repeats
  // the raw userinfo it failed to read.
  const badPassword = new URL("http://user:p%zz@proxy.test:3128");
  for (const read of [() => proxyAuthorizationValue(badPassword), () => proxyAuthorizationHeader(badPassword)]) {
    assert.throws(read, (error: Error) => {
      assert.ok(error instanceof EgressProxyCredentialsError, error.message);
      assert.match(error.message, /password of the egress proxy/);
      assert.doesNotMatch(error.message, /%zz/);
      return true;
    });
  }
});

test("proxy credentials are used for authorization and kept out of the endpoint label", () => {
  const proxy = new URL("http://re%40search:p%40ss@proxy.test:3128");
  assert.equal(proxyAuthorizationValue(proxy), `Basic ${Buffer.from("re@search:p@ss").toString("base64")}`);
  assert.equal(proxyAuthorizationHeader(proxy), `Proxy-Authorization: ${proxyAuthorizationValue(proxy)}\r\n`);
  // The label reaches logs and sandbox-visible errors, so it carries no secret.
  assert.equal(proxyEndpoint(proxy), "http://proxy.test:3128");
  assert.equal(proxyAuthorizationValue(new URL("http://proxy.test:3128")), undefined);
  assert.equal(proxyAuthorizationHeader(new URL("http://proxy.test:3128")), "");
  assert.equal(proxyPort(new URL("https://proxy.test")), 443);
  assert.equal(proxyPort(new URL("http://proxy.test")), 80);
});
