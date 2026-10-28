// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { SessionsApiClient } from "../src/api/sessions.js";
import { ApiRequestError } from "../src/api/auth.js";

test("CFG client isolates credential upload, encodes request ownership, and sends versioned decisions with idempotency", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new SessionsApiClient("control-token");
    await client.submitConfigurationCredential("session/a", "request/b", { expectedRevision: 4, fieldId: "apiToken", secret: "test-key" }, "credential-operation");
    await client.previewConfigurationRequest("session/a", "request/b", { expectedRevision: 4, values: { baseUrl: "https://example.test" }, credentialHandle: "draft" }, "preview-operation");
    await client.decideConfigurationRequest("session/a", "request/b", { revision: 5, previewDigest: "sha256:approved", decision: "apply" }, "decision-operation");
    await client.continueConfigurationRequest("session/a", "request/b", "continue-operation");
    await client.reverseConfigurationRequest("session/a", "request/b", "reversal-operation");
    await client.createConfigurationRequest("session/a", { capabilityId: "model.repair_credential", values: { modelId: "model-1" } }, "create-operation");
    await client.consentConfigurationEndpoint("session/a", "request/b", { revision: 5, endpointTarget: "https://example.test|openai" }, "user-destination-consent");
    assert.match(calls[0]!.url, /sessions\/session%2Fa\/configuration-requests\/request%2Fb\/credentials$/);
    assert.deepEqual(calls[0]!.body, { expectedRevision: 4, fieldId: "apiToken", secret: "test-key" });
    assert.deepEqual(calls[2]!.body, { revision: 5, previewDigest: "sha256:approved", decision: "apply" });
    assert.equal(calls[2]!.headers.get("Idempotency-Key"), "decision-operation");
    assert.deepEqual(calls[5]!.body, { capabilityId: "model.repair_credential", values: { modelId: "model-1" } });
    assert.match(calls[6]!.url, /\/endpoint-consent$/);
    assert.deepEqual(calls[6]!.body, { revision: 5, endpointTarget: "https://example.test|openai" });
    assert.ok(calls.every((call) => call.headers.get("authorization") === "Bearer control-token"));
    assert.ok(calls.every((call) => !/\/(messages|runs)(\/|$)/.test(call.url)));
    assert.doesNotMatch(JSON.stringify(calls.slice(1)), /test-key/);
  } finally { globalThis.fetch = originalFetch; }
});

test("CFG client preserves error codes and field identity without treating domain failures as a sign-in failure", async () => {
  const originalFetch = globalThis.fetch;
  let authFailures = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Invalid field", code: "INVALID_CONFIGURATION_INPUT", field: "baseUrl" }), { status: 400 });
  try {
    const client = new SessionsApiClient("control-token", () => { authFailures++; });
    await assert.rejects(() => client.previewConfigurationRequest("s", "r", { expectedRevision: 1, values: {} }, "key"), (reason: unknown) => {
      assert.ok(reason instanceof ApiRequestError);
      assert.equal(reason.code, "INVALID_CONFIGURATION_INPUT");
      assert.equal(reason.details?.field, "baseUrl");
      return true;
    });
    assert.equal(authFailures, 0);
  } finally { globalThis.fetch = originalFetch; }
});
