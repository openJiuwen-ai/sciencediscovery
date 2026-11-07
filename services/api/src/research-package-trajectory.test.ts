// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalize, RECORD_MEDIA_TYPE } from "@sciencediscovery/cas";
import { importedTrajectoryAccess } from "./research-package-trajectory.js";

const ref = (bytes: Uint8Array) => ({ pool: "agent-state", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.byteLength, mediaType: "application/octet-stream" });

test("legacy trajectory aliases require verified evidence objects from the exact agent stream", () => {
  const bytes = Buffer.from("included context bytes"), contextRef = ref(bytes);
  const source = { runEvents: [{ streams: [{ streamId: "main", events: [{ event: {
    type: "context.captured", evidence: { agentId: "main:source", contextRef },
  } }] }] }] };
  const owner = (streamId: string) => streamId === "main" ? "main:imported" : undefined;
  const access = importedTrajectoryAccess(source, owner, new Map([[contextRef.digest.slice(7), bytes]]));
  assert.equal(access.agentAliases["main:source"], "main:imported");
  assert.deepEqual(access.refs, [`agent-state:${contextRef.digest}`]);
  assert.deepEqual(importedTrajectoryAccess(source, owner, new Map()).agentAliases, Object.create(null));
  assert.deepEqual(importedTrajectoryAccess(source, () => undefined, new Map([[contextRef.digest.slice(7), bytes]])).agentAliases, Object.create(null));
  assert.deepEqual(importedTrajectoryAccess(source, owner, new Map([[contextRef.digest.slice(7), Buffer.from("forged")]])).agentAliases, Object.create(null));
});

test("conflicting legacy stream owners never receive an imported alias", () => {
  const bytes = Buffer.from("included context bytes"), contextRef = ref(bytes);
  const event = { evidence: { agentId: "subagent:reused", contextRef } };
  const source = { runEvents: ["subagent-a", "subagent-b"].map((streamId) => ({ streams: [{ streamId, events: [{ event }] }] })) };
  const access = importedTrajectoryAccess(source, (streamId) => `subagent:${streamId.slice("subagent-".length)}`, new Map([[contextRef.digest.slice(7), bytes]]));
  assert.equal(Object.hasOwn(access.agentAliases, "subagent:reused"), false);
});

test("legacy refs cannot escape the verified imported dependency closure", () => {
  const data = Buffer.from("same bytes"), dataRef = { ...ref(data), pool: "data" as const };
  const state = Buffer.from(canonicalize({ schemaVersion: 1, kind: "Context", value: { private: dataRef }, dependencies: [] }));
  const stateRef = { ...ref(state), mediaType: RECORD_MEDIA_TYPE };
  const source = { runEvents: [{ streams: [{ streamId: "main", events: [{ event: {
    evidence: { agentId: "main:source", contextRef: stateRef },
  } }] }] }] };
  assert.deepEqual(importedTrajectoryAccess(source, () => "main:imported", new Map([[stateRef.digest.slice(7), state]])).agentAliases, Object.create(null));
});
