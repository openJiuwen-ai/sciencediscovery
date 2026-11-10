// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { configurationRequestActions, listConfigurationRequests, createConfigurationRequest } from "../src/api/configuration.js";
import { StubClient, json } from "./api-stub.js";
const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
describe("desktop configuration API", () => {
  it("encodes session IDs and passes cancellation to the list read", async () => {
    const stub = new StubClient().reply({ items: [] }); const controller = new AbortController();
    await listConfigurationRequests(stub.asClient(), "session/one", controller.signal);
    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone/configuration-requests");
    assert.equal(stub.calls[0]!.init.signal, controller.signal);
  });
  it("uses the same versioned and idempotent action contracts as web", async () => {
    const stub = new StubClient(); const actions = configurationRequestActions(stub.asClient(), { sessionId: "session/one", id: "request/one" } as ConfigurationRequestView);
    const preview = { expectedRevision: 2, values: { name: "模型" } };
    const consent = { revision: 2, endpointTarget: "https://example.test/api" };
    const decision = { revision: 2, previewDigest: "digest", decision: "apply" as const };
    await actions.preview(preview, "preview-key"); await actions.consent!(consent, "consent-key");
    await actions.decide(decision, "decision-key"); await actions.query();
    await actions.continue("continue-key"); await actions.reversal("reverse-key");
    const prefix = "/api/sessions/session%2Fone/configuration-requests/request%2Fone";
    assert.deepEqual(stub.calls.map(call => call.path), ["/preview", "/endpoint-consent", "/decision", "", "/continue", "/reversal"].map(suffix => prefix + suffix));
    assert.deepEqual(stub.calls.map(call => call.init.method), ["POST", "POST", "POST", undefined, "POST", "POST"]);
    assert.deepEqual([json(stub.calls[0]!), json(stub.calls[1]!), json(stub.calls[2]!), json(stub.calls[4]!), json(stub.calls[5]!)], [preview, consent, decision, {}, {}]);
    assert.deepEqual(stub.calls.map(call => call.init.headers), [{ "Idempotency-Key": "preview-key" }, { "Idempotency-Key": "consent-key" }, { "Idempotency-Key": "decision-key" }, undefined, { "Idempotency-Key": "continue-key" }, { "Idempotency-Key": "reverse-key" }]);
  });
  it("sends an explicit revision-bound security acknowledgment through its dedicated action", async () => {
    const stub = new StubClient().reply({});
    const actions = configurationRequestActions(stub.asClient(), { sessionId: "s", id: "r" } as ConfigurationRequestView);
    const input = { revision: 3, targetDigest: "server-projected-target", acknowledged: true as const };
    await actions.securityConsent!(input, "security-key");
    assert.equal(stub.calls[0]!.path, "/api/sessions/s/configuration-requests/r/security-consent");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), input);
    assert.deepEqual(stub.calls[0]!.init.headers, { "Idempotency-Key": "security-key" });
  });
  it("sends manual settings confirmation through its own version-bound no-write endpoint", async () => {
    const stub = new StubClient().reply({});
    const actions = configurationRequestActions(stub.asClient(), { sessionId: "s", id: "r" } as ConfigurationRequestView);
    const input = { revision: 2, stateVersion: 4, destination: "models" as const, completed: false };
    await actions.confirmSettings!(input, "manual-key");
    assert.equal(stub.calls[0]!.path, "/api/sessions/s/configuration-requests/r/settings-confirmation");
    assert.deepEqual(json(stub.calls[0]!), input);
    assert.deepEqual(stub.calls[0]!.init.headers, { "Idempotency-Key": "manual-key" });
  });
  it("sends credentials only through the dedicated endpoint and never carries them into later actions", async () => {
    const stub = new StubClient().reply({ handle: "draft" });
    const actions = configurationRequestActions(stub.asClient(), { sessionId: "s", id: "r" } as ConfigurationRequestView);
    const credential = { expectedRevision: 1, fieldId: "apiKey", secret: "test-only-secret" };
    await actions.credential(credential, "credential-key"); await actions.continue("continue-key");
    assert.equal(stub.calls[0]!.path, "/api/sessions/s/configuration-requests/r/credentials");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), credential);
    assert.deepEqual(stub.calls[0]!.init.headers, { "Idempotency-Key": "credential-key" });
    assert.equal(JSON.stringify(stub.calls[1]).includes("test-only-secret"), false);
  });
  it("keeps action responses and failures unchanged, without caching across requests", async () => {
    const first = { revision: 2 } as ConfigurationRequestView;
    const second = { revision: 3 } as ConfigurationRequestView;
    const failure = new Error("uncertain response");
    const stub = new StubClient().reply(first).fail(failure).reply(second);
    const actions = configurationRequestActions(stub.asClient(), { sessionId: "s/one", id: "r/one" } as ConfigurationRequestView);
    const other = configurationRequestActions(stub.asClient(), { sessionId: "s/two", id: "r/two" } as ConfigurationRequestView);
    const input = { expectedRevision: 1, values: { name: "Original" } };
    assert.equal(await actions.preview(input, "first-key"), first);
    input.values.name = "Changed";
    await assert.rejects(other.preview(input, "other-key"), reason => reason === failure);
    assert.equal(await actions.query(), second);
    assert.deepEqual(stub.calls.map(call => call.path), [
      "/api/sessions/s%2Fone/configuration-requests/r%2Fone/preview",
      "/api/sessions/s%2Ftwo/configuration-requests/r%2Ftwo/preview",
      "/api/sessions/s%2Fone/configuration-requests/r%2Fone",
    ]);
    assert.deepEqual(json(stub.calls[0]!), { expectedRevision: 1, values: { name: "Original" } });
    assert.deepEqual(json(stub.calls[1]!), input);
    assert.deepEqual(stub.calls[1]!.init.headers, { "Idempotency-Key": "other-key" });
    assert.deepEqual(stub.calls[2]!.init, {});
  });
  it("preserves create inputs and rejects failures rather than turning them into an empty list", async () => {
    const input = { protocolVersion: 3 as const, capabilityId: "model.connect" as const, values: {} };
    const stub = new StubClient().reply({}).fail(new Error("failed"));
    await createConfigurationRequest(stub.asClient(), "s", input, "create-key");
    assert.deepEqual(json(stub.calls[0]!), input);
    assert.deepEqual(stub.calls[0]!.init.headers, { "Idempotency-Key": "create-key" });
    await assert.rejects(listConfigurationRequests(stub.asClient(), "s"), /failed/);
  });
});
