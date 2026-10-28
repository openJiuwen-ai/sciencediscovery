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

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { CasStore } from "@sciencediscovery/cas";
import type { ArtifactOrigin, ArtifactOriginMeta, ScientificArtifactKind } from "@sciencediscovery/schema";

import { apiLog } from "../logging.js";
import type { SessionStore } from "../store.js";
import { SAMPLE_SESSION_GZIP_BASE64 } from "./payload.js";

/**
 * What a first install opens on.
 *
 * A new user lands on an empty sidebar: nothing to read, nothing to try, and
 * no way to tell whether a run is worth waiting for. This seeds one real
 * Session — the conversation, its two runs and their run streams, the
 * workspace the analysis wrote, and the artifacts it published — so the
 * transcript, the tool blocks, the panel and the 产物 tab all have something in
 * them before the user has typed anything.
 *
 * The seed happens once, on an install that has no conversations of its own.
 * Its marker file is what makes that "once": deleting the sample is a decision
 * the user made, and a later start must not undo it.
 */
export const SAMPLE_SESSION_MARKER = ".sample-session-seeded";

/** One published version of one artifact, as the catalog records it. */
interface SampleArtifact {
  /** The version's bytes. An artifact's content lives in the content store,
   *  not in the workspace, so it travels with the payload rather than under
   *  `files`. */
  contentBase64: string;
  description: string;
  /** The runs the version came from, limited to the runs this payload ships. */
  executionRunIds: string[];
  kind: ScientificArtifactKind;
  logicalName: string;
  mediaType: string;
  origin: ArtifactOrigin;
  originMeta?: ArtifactOriginMeta;
  sourcePath: string;
  title: string;
  turnId: string;
  /** 1 for a first version. A later one is written on top of the version
   *  before it in this list, which is what makes it the same artifact. */
  version: number;
}

interface SampleSession {
  /** The workspace's text files, by the path the store reads them from. */
  files: Record<string, string>;
  /** The ones that are not text — the analysis's two figures — as base64.
   *  Kept apart so a text file is written back byte for byte through utf8 and
   *  an image is not mangled through it. */
  encoded: Record<string, string>;
  /** The artifacts the analysis published, oldest version first. */
  artifacts: SampleArtifact[];
  projectName: string;
  sessionTitle: string;
}

/** The payload as it was packed; exported for the seeds and for tests. */
export function sampleSession(): SampleSession {
  const json = gunzipSync(Buffer.from(SAMPLE_SESSION_GZIP_BASE64, "base64")).toString("utf8");
  return JSON.parse(json) as SampleSession;
}

/**
 * The payload with this install's own ids in place of the placeholders.
 *
 * The Session and Project are created by the store like any other, so they get
 * new ids; every reference to the originals inside the streams is rewritten
 * here. The data directory is rewritten too, because the run streams record
 * the absolute paths the run worked in.
 */
export function fillSampleSession(
  text: string,
  ids: { dataDir: string; projectId: string; sessionId: string },
): string {
  return text
    .split("__DATA_DIR__").join(ids.dataDir)
    .split("__SESSION_ID__").join(ids.sessionId)
    .split("__PROJECT_ID__").join(ids.projectId);
}

/**
 * Seed the sample Session, if this install should have one.
 *
 * Returns whether anything was written. Never throws: a sample that cannot be
 * written is a missing convenience, not a reason to refuse to start.
 */
export async function seedSampleSession(store: SessionStore): Promise<boolean> {
  const marker = resolve(store.dataDir, SAMPLE_SESSION_MARKER);
  if (existsSync(marker)) return false;
  const existing = store.listUserProjects().flatMap((project) => store.listSessions(project.id, "all"));
  if (existing.length > 0) {
    // An install that already has conversations was not waiting for a sample.
    await writeMarker(store.dataDir, "existing workspace\n");
    return false;
  }
  try {
    const sample = sampleSession();
    const project = await store.createProject(sample.projectName);
    const session = await store.createSession(project.id, sample.sessionTitle, {}, {}, {
      allowUnconfiguredModel: true,
    });
    const ids = { dataDir: store.dataDir, projectId: project.id, sessionId: session.id };
    for (const [path, text] of Object.entries(sample.files)) {
      await writeSample(store.dataDir, path, ids, fillSampleSession(text, ids));
    }
    for (const [path, base64] of Object.entries(sample.encoded)) {
      await writeSample(store.dataDir, path, ids, Buffer.from(base64, "base64"));
    }
    await seedArtifacts(store, session.id, sample.artifacts);
    await writeMarker(store.dataDir, `${session.id}\n`);
    apiLog.info("sample_session_seeded", { projectId: project.id, sessionId: session.id });
    return true;
  } catch (error) {
    apiLog.warn("sample_session_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Publish the sample's artifacts the way the run published them: bytes into
 * the content store, metadata into the catalog, versions on top of each other.
 *
 * The 产物 tab reads the catalog, and the workspace alone cannot fill it — a
 * sample that ships only files opens on an empty artifacts panel, which is the
 * one part of the transcript a new user has nothing else to compare against.
 *
 * A version whose predecessor is missing is skipped rather than flattened into
 * a first version: the panel would then claim a history that did not happen.
 */
async function seedArtifacts(
  store: SessionStore,
  sessionId: string,
  artifacts: SampleArtifact[],
): Promise<void> {
  const cas = new CasStore(store.dataDir, "data");
  const previous = new Map<string, { artifactId: string; versionId: string }>();
  for (const artifact of artifacts) {
    const base = previous.get(artifact.logicalName);
    if (artifact.version > 1 && !base) continue;
    const content = await cas.put(Buffer.from(artifact.contentBase64, "base64"));
    const written = await store.createArtifactVersion({
      ...(base ? { artifactId: base.artifactId, baseVersionId: base.versionId } : {}),
      content,
      ...(artifact.description ? { description: artifact.description } : {}),
      ...(artifact.executionRunIds.length > 0 ? { executionRunIds: artifact.executionRunIds } : {}),
      kind: artifact.kind,
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      origin: artifact.origin,
      ...(artifact.originMeta ? { originMeta: artifact.originMeta } : {}),
      sessionId,
      ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : {}),
      ...(artifact.title ? { title: artifact.title } : {}),
      ...(artifact.turnId ? { turnId: artifact.turnId } : {}),
    });
    previous.set(artifact.logicalName, { artifactId: written.artifact.id, versionId: written.version.id });
  }
}

async function writeSample(
  dataDir: string,
  path: string,
  ids: { dataDir: string; projectId: string; sessionId: string },
  body: string | Buffer,
): Promise<void> {
  const target = resolve(dataDir, fillSampleSession(path, ids));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

async function writeMarker(dataDir: string, body: string): Promise<void> {
  await writeFile(resolve(dataDir, SAMPLE_SESSION_MARKER), body, "utf8");
}
