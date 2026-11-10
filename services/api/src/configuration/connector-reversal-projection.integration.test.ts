// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { ConversationalConfigurationFramework } from "./framework.js";
import type { ConfigurationPlan } from "./types.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
type ReversalFixture = {
  kind: string; reversalInput: ConfigurationValues; view: Record<string, unknown>; result: { effective: string[]; overridePresent: boolean };
};
/** Normalize only generated identifiers/times/digests. Keep the complete public
 * v3 request, especially its real choices and confirmation binding shape. */
function projection(view: ConfigurationRequestView) {
  return { ...view, id: "cfg", sessionId: "session", projectId: "project", scope: { kind: "session", id: "session" },
    previewDigest: "sha256:" + "0".repeat(64),
    ...(view.needKey ? { needKey: "sha256:" + "1".repeat(64) } : {}),
    createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z",
    ...(view.expiresAt ? { expiresAt: "2026-11-09T01:00:00.000Z" } : {}),
  };
}
// Test identities must be static so the shared CI collector can freeze them.
for (const kind of ["restoreExplicit", "restoreInheritance"]) test(`connector reversal preserves the ${kind} frontend projection contract`, async context => {
  const fixtures = JSON.parse(await readFile(new URL("../../../../test/fixtures/configuration-connector-reversal.json", import.meta.url), "utf8")) as ReversalFixture[];
  assert.deepEqual(fixtures.map(fixture => fixture.kind).sort(), ["restoreExplicit", "restoreInheritance"]);
  const fixture = fixtures.find(fixture => fixture.kind === kind)!;
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `connector-reversal-projection-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Owned reversal projection");
  await store.replaceProjectSettings(project.id, { enabledConnectorIds: ["uniprot"] });
  const session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  if (fixture.kind === "restoreExplicit") await store.replaceSessionSettings(session.id, { enabledConnectorIds: ["uniprot"] });
  const framework = new ConversationalConfigurationFramework(store, { nativeExecutor: true, connector: (_session, id) => ({ name: id, ready: true }) });
  const adapter = framework.service.registry.get("connector.enable"), previewReversal = adapter.previewReversal, preview = adapter.preview;
  assert.ok(previewReversal);
  let reversalInput: ConfigurationValues | undefined, plan: ConfigurationPlan | undefined;
  adapter.previewReversal = (receipt, snapshot) => { reversalInput = previewReversal.call(adapter, receipt, snapshot); return reversalInput; };
  adapter.preview = (input, snapshot, scope) => { plan = preview.call(adapter, input, snapshot, scope); return plan; };
  const original = await framework.propose(session.id, { protocolVersion: 3, capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  const approve = (card: ConfigurationRequestView) => framework.decide(session.id, card.id, {
    revision: card.revision, previewDigest: card.previewDigest!, selectedOptionId: card.selectedOptionId, decision: "apply",
  });
  assert.equal((await approve(original)).state, "applied");
  framework.options.connector = () => undefined;
  const inverse = await framework.service.reversal(session.id, original.id);
  assert.deepEqual(reversalInput, fixture.reversalInput);
  assert.deepEqual(projection(inverse), fixture.view);
  assert.equal(plan?.ready, true);
  assert.deepEqual(plan?.changes, inverse.changes);
  assert.equal((await approve(inverse)).state, "applied");
  const settings = store.getSessionSettings(session.id);
  assert.deepEqual({ effective: settings.effective.enabledConnectorIds, overridePresent: Object.hasOwn(settings.overrides, "enabledConnectorIds") }, fixture.result);
});
