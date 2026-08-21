// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactManager, artifactMediaType, type ArtifactVersionInput } from "./manager.js";

test("registerWorkspaceArtifact classifies and persists through domain ports", async () => {
  let saved: ArtifactVersionInput | undefined;
  const manager = new ArtifactManager(
    { putWorkspaceFile: async () => ({ hash: "a".repeat(64), size: 12 }) },
    {
      createVersion: async (input) => {
        saved = input;
        return {
          artifact: { createdAt: "now", createdInSessionId: input.sessionId, createdInSessionTitle: "s", currentVersion: 1, id: "a", kind: input.kind, logicalName: input.logicalName, name: input.logicalName, origin: input.origin, projectId: "p", sessionId: input.sessionId, updatedAt: "now" },
          version: { artifactId: "a", content: input.content, createdAt: "now", executionRunIds: [], id: "v", inputArtifactVersionIds: [], mediaType: input.mediaType, projectId: "p", sessionId: input.sessionId, version: 1 },
        };
      },
    },
  );
  await manager.registerWorkspaceArtifact({ path: "reports/final.md", sessionId: "s", workspaceRoot: "/w" });
  assert.equal(saved?.kind, "markdown");
  assert.equal(saved?.mediaType, "text/markdown");
  assert.equal(saved?.origin, "user_upload");
});

test("artifactMediaType has a conservative binary fallback", () => {
  assert.equal(artifactMediaType("model.pdb"), "chemical/x-pdb");
  assert.equal(artifactMediaType("result.unknown"), "application/octet-stream");
});
