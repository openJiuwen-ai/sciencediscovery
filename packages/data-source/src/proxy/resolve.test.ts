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
import test from "node:test";

import type { ProxyDefaultPolicy, ProxyServerKind } from "@sciencediscovery/schema";

import {
  proxyEnvironmentDetails,
  proxyEnvOverlay,
  resolveProxyEnvironment,
  resolveProxyForUrl,
} from "./env.js";
import { resolveProxyPolicy, type ProxyRegistryView } from "./resolve.js";
import { setSystemProxyReaderForTest } from "./system.js";

function registry(defaultPolicy: ProxyDefaultPolicy = "none"): ProxyRegistryView {
  const kinds = new Map<string, ProxyServerKind>([
    ["custom", "custom_url"],
    ["environment", "environment"],
    ["system", "system"],
  ]);
  return {
    defaultPolicy,
    getServerKind: (id) => kinds.get(id),
    getServerUrl: (id) => id === "custom" ? "http://proxy.example.test:7890" : undefined,
  };
}

test("resolveProxyPolicy handles inherit, none, custom, environment, and system", () => {
  assert.deepEqual(resolveProxyPolicy(undefined, registry("proxy:custom")), {
    mode: "url",
    url: "http://proxy.example.test:7890",
  });
  assert.deepEqual(resolveProxyPolicy("inherit", registry("none")), { mode: "direct" });
  assert.deepEqual(resolveProxyPolicy("none", registry("proxy:custom")), { mode: "direct" });
  assert.deepEqual(resolveProxyPolicy("proxy:environment", registry(), {}), { mode: "environment" });

  setSystemProxyReaderForTest(() => ({ mode: "url", url: "http://system.example.test:3128" }));
  try {
    assert.deepEqual(resolveProxyPolicy("proxy:system", registry()), {
      mode: "url",
      url: "http://system.example.test:3128",
    });
  } finally {
    setSystemProxyReaderForTest(undefined);
  }
});

test("resolveProxyPolicy rejects stale ids and missing custom URLs", () => {
  assert.throws(() => resolveProxyPolicy("proxy:missing", registry()), /unknown proxy server: missing/);
  assert.throws(() => resolveProxyPolicy("proxy:custom", {
    ...registry(),
    getServerUrl: () => undefined,
  }), /has no saved URL/);
});

test("proxyEnvOverlay keeps policies isolated", () => {
  const base = {
    HTTPS_PROXY: "http://environment.example.test:3128",
    NO_PROXY: "localhost",
    unrelated: "kept-by-caller",
  };
  assert.deepEqual(proxyEnvOverlay({ mode: "direct" }, base), {});
  assert.deepEqual(proxyEnvOverlay({ mode: "environment" }, base), {
    HTTPS_PROXY: "http://environment.example.test:3128",
    NO_PROXY: "localhost",
  });
  assert.deepEqual(proxyEnvOverlay({ mode: "url", url: "http://selected.example.test:8080" }, base), {
    ALL_PROXY: "http://selected.example.test:8080",
    HTTP_PROXY: "http://selected.example.test:8080",
    HTTPS_PROXY: "http://selected.example.test:8080",
    NO_PROXY: "localhost",
    all_proxy: "http://selected.example.test:8080",
    http_proxy: "http://selected.example.test:8080",
    https_proxy: "http://selected.example.test:8080",
  });
});

test("environment proxy inspection follows runtime precedence and treats blanks as unconfigured", () => {
  const empty = resolveProxyEnvironment({});
  assert.equal(empty.status, "unconfigured");
  assert.equal(empty.variables.every((variable) => variable.status === "unconfigured"), true);

  const blankLowercase = resolveProxyEnvironment({
    HTTP_PROXY: "http://ignored.example.test:8080",
    http_proxy: "   ",
  });
  assert.equal(blankLowercase.status, "unconfigured");
  assert.deepEqual(blankLowercase.variables[0], {
    effectiveName: "http_proxy",
    names: ["http_proxy", "HTTP_PROXY"],
    status: "unconfigured",
  });

  const lowercaseWins = resolveProxyEnvironment({
    HTTP_PROXY: "http://uppercase.example.test:8080",
    http_proxy: "http://lowercase.example.test:8080",
  });
  assert.equal(lowercaseWins.status, "configured");
  assert.equal(lowercaseWins.variables[0]?.effectiveName, "http_proxy");
  assert.equal(lowercaseWins.variables[0]?.value, "http://lowercase.example.test:8080");
});

test("environment projection and target resolution share httpx-compatible case precedence", () => {
  const cases = [
    [{ http_proxy: "http://lower.test:1" }, "http://lower.test:1", false],
    [{ HTTP_PROXY: "http://upper.test:2" }, "http://upper.test:2", false],
    [{ http_proxy: " ", HTTP_PROXY: "http://upper.test:2" }, undefined, false],
    [{ http_proxy: "invalid", HTTP_PROXY: "http://upper.test:2" }, undefined, true],
    [{ http_proxy: "http://lower.test:1", HTTP_PROXY: "http://upper.test:2" }, "http://lower.test:1", false],
  ] as const;
  for (const [environment, expected, invalid] of cases) {
    const snapshot = resolveProxyEnvironment(environment);
    assert.equal(snapshot.variables[0]?.value, expected);
    if (invalid) {
      assert.equal(snapshot.variables[0]?.status, "invalid");
      assert.throws(() => resolveProxyForUrl({ mode: "environment" }, "http://target.test", environment));
    } else {
      assert.deepEqual(
        resolveProxyForUrl({ mode: "environment" }, "http://target.test", environment),
        expected ? { mode: "url", url: expected } : { mode: "direct" },
      );
    }
  }
});

test("environment target resolution is protocol-specific and honours ALL_PROXY and NO_PROXY", () => {
  const environment = {
    ALL_PROXY: "http://all.test:3",
    HTTP_PROXY: "http://http.test:1",
    HTTPS_PROXY: "http://https.test:2",
    NO_PROXY: ".example.test,port.test:8443",
  };
  assert.deepEqual(resolveProxyForUrl({ mode: "environment" }, "http://outside.test", environment), {
    mode: "url", url: "http://http.test:1",
  });
  assert.deepEqual(resolveProxyForUrl({ mode: "environment" }, "https://outside.test", environment), {
    mode: "url", url: "http://https.test:2",
  });
  assert.deepEqual(resolveProxyForUrl({ mode: "environment" }, "https://sub.example.test", environment), {
    mode: "direct",
  });
  assert.deepEqual(resolveProxyForUrl({ mode: "environment" }, "https://port.test:8443", environment), {
    mode: "direct",
  });
  assert.deepEqual(resolveProxyForUrl(
    { mode: "environment" },
    "https://outside.test",
    { HTTP_PROXY: "http://http-only.test:1" },
  ), { mode: "direct" });
  assert.deepEqual(resolveProxyForUrl(
    { mode: "environment" },
    "https://outside.test",
    { ALL_PROXY: "http://all-only.test:3" },
  ), { mode: "url", url: "http://all-only.test:3" });
});

test("environment subprocess overlay canonicalizes contradictory variants", () => {
  assert.deepEqual(proxyEnvOverlay({ mode: "environment" }, {
    HTTP_PROXY: "http://ignored.test:1",
    HTTPS_PROXY: "http://upper-https.test:2",
    http_proxy: "http://effective.test:3",
    https_proxy: " ",
    no_proxy: "localhost",
  }), {
    HTTP_PROXY: "http://effective.test:3",
    NO_PROXY: "localhost",
  });
});

test("authenticated environment settings display the complete effective value", () => {
  const value = "http://user:secret@proxy.example.test:8080/path?token=abc&region=private";
  const details = proxyEnvironmentDetails(resolveProxyEnvironment({
    HTTP_PROXY: value,
    NO_PROXY: "localhost,.example.test",
  }));
  assert.equal(details.status, "configured");
  assert.equal(details.variables[0]?.status, "configured");
  assert.equal(details.variables[0]?.effectiveName, "HTTP_PROXY");
  assert.equal(details.variables[0]?.effectiveValue, value);
  assert.equal(details.variables[3]?.effectiveValue, "localhost,.example.test");
});

test("invalid environment proxy values are diagnosed without echoing the value and rejected by resolver", () => {
  const snapshot = resolveProxyEnvironment({ HTTPS_PROXY: "not-a-proxy-url-with-secret" });
  const details = proxyEnvironmentDetails(snapshot);
  assert.equal(snapshot.status, "invalid");
  assert.equal(details.status, "invalid");
  assert.equal(details.variables[1]?.effectiveName, "HTTPS_PROXY");
  assert.equal(details.variables[1]?.effectiveValue, undefined);
  assert.match(details.variables[1]?.reason ?? "", /HTTPS_PROXY is not a valid proxy URL/);
  assert.doesNotMatch(JSON.stringify(details), /not-a-proxy-url-with-secret/);
  assert.throws(
    () => resolveProxyPolicy("proxy:environment", registry(), { HTTPS_PROXY: "not-a-proxy-url-with-secret" }),
    /HTTPS_PROXY is not a valid proxy URL/,
  );
});
