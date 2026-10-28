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

import type { SessionArtifactOutput } from "../api/types.js";
import { fileFolder, fileName } from "./paths.js";

/** The name a row shows: the title the artifact declared, or its file name. */
export function artifactName(output: SessionArtifactOutput): string {
  return output.artifact.title ?? fileName(output.artifact.name);
}

/** Where the version lives: the source path the run wrote it to, or the
 *  declared name for artifacts that have none. */
export function artifactPath(output: SessionArtifactOutput): string {
  return output.version.sourcePath ?? output.artifact.name;
}

/** The nearest folder of that path, when it has one. */
function artifactFolder(output: SessionArtifactOutput): string {
  return fileFolder(output.version.sourcePath ?? "") || fileFolder(output.artifact.name);
}

/**
 * One output per artifact: the latest version of each.
 *
 * The panel lists artifacts, not versions. A subagent writes `trace.md` and the
 * turn that launched it rewrites the file, and both versions belong to the same
 * artifact — two rows for them are two rows the reader has to tell apart before
 * they can open either. The version is a property of the open document (the
 * picker beside it), so the list keeps the newest one and the reader chooses
 * another after opening it.
 *
 * Version numbers are the artifact's own ordering; `createdAt` breaks a tie in
 * case two versions were recorded with the same number.
 */
export function latestOutputs(outputs: readonly SessionArtifactOutput[]): SessionArtifactOutput[] {
  const latest = new Map<string, SessionArtifactOutput>();
  for (const output of outputs) {
    const held = latest.get(output.artifact.id);
    if (held === undefined || isNewer(output, held)) latest.set(output.artifact.id, output);
  }
  return [...latest.values()];
}

function isNewer(output: SessionArtifactOutput, held: SessionArtifactOutput): boolean {
  return output.version.version === held.version.version
    ? output.version.createdAt > held.version.createdAt
    : output.version.version > held.version.version;
}

/**
 * Every version of one artifact, newest first — the order the picker offers.
 *
 * The list has one row per artifact, so the versions behind the open document
 * are reachable only through the picker, and it opens on the newest one.
 */
export function versionsOf(
  outputs: readonly SessionArtifactOutput[],
  artifactId: string,
): SessionArtifactOutput[] {
  return outputs
    .filter((output) => output.artifact.id === artifactId)
    .sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
}

/**
 * What tells each artifact apart from its neighbours, keyed by artifact id.
 *
 * Two artifacts can share a name — a subagent writes `trace.md` into its own
 * workspace and another writes its own — and then the folder is the fact that
 * differs. Names that do not repeat get no note: a column of empty hints is
 * noise around the names. The versions of one artifact are one artifact here:
 * the note describes the row, not the versions behind it.
 */
export function artifactHints(outputs: readonly SessionArtifactOutput[]): Map<string, string> {
  const byName = new Map<string, SessionArtifactOutput[]>();
  for (const output of latestOutputs(outputs)) {
    const name = artifactName(output);
    const peers = byName.get(name);
    if (peers === undefined) byName.set(name, [output]);
    else peers.push(output);
  }
  const hints = new Map<string, string>();
  for (const peers of byName.values()) {
    if (peers.length < 2) continue;
    for (const peer of peers) {
      const folder = artifactFolder(peer);
      if (folder !== "") hints.set(peer.artifact.id, folder);
    }
  }
  return hints;
}
