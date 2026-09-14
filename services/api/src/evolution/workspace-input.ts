// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { committedWorkspaceSnapshot, streamSnapshotFile, workspaceSnapshotFiles, type VersionStore } from "@sciencediscovery/cas";

/** Export a selected file, not whichever bytes a concurrent Shell has written so
 * far. Explicit inline text remains an independent, immutable input. */
export async function storeEvolutionInput(versions: VersionStore, workspace: string,
  input: { content?: string; path?: string }): Promise<string> {
  if (input.content !== undefined) return (await versions.put("agent-state", input.content)).digest;
  const path = input.path ?? "";
  const snapshot = await committedWorkspaceSnapshot(versions, workspace);
  const file = (await workspaceSnapshotFiles(versions, snapshot, [path])).find((entry) => entry.path === path);
  if (!file) throw new Error("Evolution input must select a regular file in the committed Workspace snapshot");
  // Validate the closure before exposing a successful input reference.
  for await (const _ of streamSnapshotFile(versions, file.content)) { /* verify without buffering */ }
  return file.content.digest;
}
