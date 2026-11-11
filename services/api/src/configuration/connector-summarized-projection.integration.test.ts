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
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { ConversationalConfigurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
type SummarizedFixture = { kind: string; enabled: string[]; view: Record<string, unknown> };
/** Normalize only generated identifiers/times/digests. Keep the complete public
 * v3 request, especially the summarized baseline the desktop card classifies. */
function projection(view: ConfigurationRequestView) {
  return { ...view, id: "cfg", sessionId: "session", projectId: "project", runId: "run",
    scope: { kind: "session", id: "session" }, resumption: { ...view.resumption, runId: "run" },
    previewDigest: "sha256:" + "0".repeat(64),
    ...(view.needKey ? { needKey: "sha256:" + "1".repeat(64) } : {}),
    createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
    ...(view.expiresAt ? { expiresAt: "2026-11-11T01:00:00.000Z" } : {}),
  };
}
// Test identities must be static so the shared CI collector can freeze them.
test("connector enable keeps its summarized projection once the session selection passes ten IDs", async context => {
  const fixtures = JSON.parse(await readFile(new URL("../../../../test/fixtures/configuration-connector-summarized-addition.json", import.meta.url), "utf8")) as SummarizedFixture[];
  assert.deepEqual(fixtures.map(fixture => fixture.kind), ["summarizedAddition"]);
  const fixture = fixtures[0]!;
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `connector-summarized-projection-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Owned summarized projection");
  const session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  await store.replaceSessionSettings(session.id, { enabledConnectorIds: fixture.enabled });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Enable UniProt for this task", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  await store.updateSessionRun(session.id, run.id, { status: "running" });
  const framework = new ConversationalConfigurationFramework(store, { nativeExecutor: false, jiuwenLiveWait: true,
    connector: (_sessionId, id) => ({ name: id, ready: true }), resume: async () => undefined });
  const view = await framework.propose(session.id, { protocolVersion: 3, capabilityId: "connector.enable", values: { connectorId: "uniprot" }, runId: run.id });
  assert.equal(view.state, "awaiting_confirmation");
  assert.equal(view.activation.mode, "same_run");
  assert.equal(view.autoApplyAt, undefined);
  assert.deepEqual(view.changes, [{ field: "enabledConnectorIds",
    before: "11 connectors: arxiv, biorxiv, chembl, clinvar, ensembl, europe-pmc, geo, llm-wiki, medrxiv, pdb …",
    after: "12 connectors: arxiv, biorxiv, chembl, clinvar, ensembl, europe-pmc, geo, llm-wiki, medrxiv, pdb …" }]);
  assert.deepEqual(projection(view), fixture.view);
});
