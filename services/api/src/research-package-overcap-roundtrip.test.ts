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
 * The invariant #1152 exists for: a package the export ceiling admits is importable by a
 * build whose *configured* cap is lower.
 *
 * The cap is resolved when `@sciencediscovery/research-package` is first evaluated, and
 * ES imports are hoisted above this file's own statements — so the package is imported
 * dynamically, after the environment is set. This is also why the case lives in its own
 * file: the shared plan runs each file in its own process, and the alternative (a
 * >512 MiB payload) is not something a unit gate should allocate.
 */

process.env.SCIENCE_AGENT_RESEARCH_PACKAGE_MAX_BYTES = String(64 * 1024 * 1024);

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const {
  RESEARCH_PACKAGE_MAX_BYTES, RESEARCH_PACKAGE_MAX_MAX_BYTES,
  createResearchPackage, importResearchPackage, researchPackageUploadBytes, sha256,
} = await import("@sciencediscovery/research-package");

test("a package the ceiling admits is importable though the configured cap is smaller", () => {
  assert.equal(RESEARCH_PACKAGE_MAX_BYTES, 64 * 1024 * 1024, "this file lowered the cap before importing");
  assert.ok(RESEARCH_PACKAGE_MAX_MAX_BYTES > RESEARCH_PACKAGE_MAX_BYTES);

  // Incompressible payload, larger than the configured cap: the shape that made the
  // original 512 MiB export / 256 MiB import pair a round-trip defect.
  const payload = randomBytes(80 * 1024 * 1024);
  const digest = sha256(payload);
  const input = {
    source: { projectId: "p-overcap", title: "Over-cap round trip" },
    createdAt: "2026-01-01T00:00:00.000Z",
    records: { claims: [{ id: "c1" }] },
    objects: [{ path: `objects/${digest}`, bytes: payload }],
  };

  // At the configured cap the exporter refuses …
  assert.throws(() => createResearchPackage(input), /exceeds the archive size limit/);

  // … and under the ceiling an acknowledged export produces a real package.
  const produced = createResearchPackage(input, RESEARCH_PACKAGE_MAX_MAX_BYTES);
  assert.ok(produced.bytes.byteLength > RESEARCH_PACKAGE_MAX_BYTES,
    "the archive is larger than the configured cap, which is the case being pinned");
  assert.ok(produced.bytes.byteLength <= researchPackageUploadBytes(RESEARCH_PACKAGE_MAX_MAX_BYTES),
    "the upload bound covers what the exporter emits");

  // The importer reads it back: the object lands and the manifest agrees.
  const imported = importResearchPackage(produced.bytes);
  const restored = imported.objects.get(digest);
  assert.ok(restored, "the object survives the round trip");
  assert.equal(restored.byteLength, payload.byteLength);
  assert.equal(sha256(restored), digest);
  const entry = imported.manifest.inventory.find((item) => item.kind === "object");
  assert.equal(entry?.checksum, digest);
  assert.equal(entry?.sizeBytes, payload.byteLength);
});
