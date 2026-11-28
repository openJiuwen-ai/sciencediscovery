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
 * Regression coverage for #1543.
 *
 * A workspace file whose current revision has no `contentHash` has no address a
 * preview could name, so the preview books its size in `unpinnedObjectBytes`
 * and nothing else. It used to leave `objectPath: ""` in the CAS work set as
 * well, where the lookup threw and was recorded as `cas::unavailable source
 * object` — a limitation the dialog showed and the real export never declared,
 * because the export hashes the file while it copies.
 *
 * These cases assert the user-visible contract: the preview's limitations are
 * the ones the package declares, and an internal CAS diagnostic is not one of
 * them.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { createResearchSnapshots } from "./research-snapshots.js";
import { SessionStore } from "./store.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** The preview sizing object the service builds per request (research-snapshots.ts). */
function sizing() {
  return {
    objectSizes: new Map<string, number>(), additionalRecordBytes: 0, unpinnedObjectBytes: [] as number[],
    hashes: new Set<string>(), refs: new Map(),
    jsonSizes: new WeakMap<object, number>(), casVisited: new WeakSet<object>(), refsVisited: new WeakSet<object>(),
    workspaceListings: new Map(),
  } as never;
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "preview-omissions-"));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const cas = new CasStore(root);
  const project = await store.createProject("preview omissions");
  const session = await store.createSession(project.id, "hash-less workspace file", {}, {}, { allowUnconfiguredModel: true });
  // A file written into the workspace without a provenance revision is the shape
  // the issue reports: the current revision has no `contentHash` to point at.
  const relative = "notes/plain-notes.txt";
  const absolute = resolve(store.workspacePath(session.id), relative);
  await mkdir(dirname(absolute), { recursive: true });
  const body = "the agent wrote this file, nobody hashed it yet\n";
  await writeFile(absolute, body);
  const snapshots = createResearchSnapshots({
    store,
    evolutionStore: {} as never,
    evolveCandidates: {} as never,
    memoryGraphClient: { snapshotRevision: async () => "" } as never,
    memoryGraphEnabled: () => false,
    provenanceRecorder: { cas: {
      exists: (hash: string) => cas.exists(hash),
      read: (hash: string) => cas.read(hash),
      storedSize: async (hash: string) => await cas.storedSize(hash),
      stream: async function* (hash: string) { yield* cas.stream(hash); },
    } } as never,
  }, async () => false);
  return { root, store, project, session, snapshots, relative, body };
}

test("a preview lists the limitations the export declares, not a CAS diagnostic for an unaddressed file", async () => {
  const f = await fixture();
  try {
    const previewSizing = sizing();
    const preview = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined, previewSizing, false, false);
    const exported = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete");

    const previewOmissions = (preview as { omissions?: string[] }).omissions ?? [];
    const exportedOmissions = (exported as { omissions?: string[] }).omissions ?? [];
    assert.ok(previewOmissions.length > 0, "the fixture still declares its ordinary limitations");
    assert.deepEqual(
      previewOmissions.filter((item) => item.startsWith("cas:")),
      [],
      `the preview must not invent a CAS loss: ${previewOmissions.join(" | ")}`,
    );
    assert.equal(
      previewOmissions.length,
      exportedOmissions.length,
      `the dialog shows what the package declares: preview=${previewOmissions.length} export=${exportedOmissions.length} (${previewOmissions.join(" | ")} / ${exportedOmissions.join(" | ")})`,
    );

    // The byte count is still in the estimate, and the export still carries the file.
    const sizingState = previewSizing as unknown as { unpinnedObjectBytes: number[] };
    assert.ok(sizingState.unpinnedObjectBytes.includes(Buffer.byteLength(f.body)),
      `an unaddressed file still contributes its size: ${JSON.stringify(sizingState.unpinnedObjectBytes)}`);
    const record = (exported.records as { sessions: Array<{ workspace: Array<{ path: string; objectPath?: string }> }> }).sessions[0]!;
    const written = record.workspace.find((file) => file.path === f.relative);
    assert.ok(written, `the export still carries the file: ${JSON.stringify(record.workspace)}`);
    assert.match(written?.objectPath ?? "", /^[0-9a-f]{64}$/u,
      "the export addresses the file while it copies, so the package carries it in full");
  } finally { await rm(f.root, { recursive: true, force: true }).catch(() => undefined); }
});