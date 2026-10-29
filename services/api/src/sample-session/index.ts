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
import type {
  ArtifactOrigin,
  ArtifactOriginMeta,
  Project,
  RunStreamEvent,
  ScientificArtifactKind,
  Subagent,
  SubagentStep,
} from "@sciencediscovery/schema";

import { apiLog } from "../logging.js";
import type { SessionStore } from "../store.js";
import { SAMPLE_SESSION_GZIP_BASE64 } from "./payload.js";

/**
 * What a first install opens on.
 *
 * A new user lands on an empty sidebar: nothing to read, nothing to try, and
 * no way to tell whether a run is worth waiting for. This seeds one real
 * Session — the conversation, its run and that run's streams, the workspace
 * the analysis wrote, and the artifacts it published — so the transcript, the
 * tool blocks, the panel and the 产物 tab all have something in them before the
 * user has typed anything.
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
  /** The Artifact id the recorded transcript cites, when one of its messages
   *  carries a chip for this document. Seeding mints new ids, so the reference
   *  is rewritten to the new one — a citation has to open the seeded document,
   *  not a row that does not exist on this install. */
  recordedArtifactId?: string;
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
  /** The ones that are not text — a figure, an image — as base64. Kept apart
   *  so a text file is written back byte for byte through utf8 and an image is
   *  not mangled through it. */
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
 * The children the recorded run delegated, with the execution the catalog is
 * the only place to read.
 *
 * The parent's stream carries a `subagent.updated` snapshot whenever a child
 * changes and no steps at all — the steps travel on the child's own substream.
 * A live child writes both into the catalog, so a Session that arrives as a
 * recording opens every delegation on "no execution recorded" unless the seed
 * puts those rows back. They are rebuilt from the same two sources: the child's
 * last snapshot, and the steps its substream recorded, merged by step id
 * because a step is re-emitted as it changes.
 *
 * A child the recording left `running` is left out. The catalog closes such a
 * row on load as interrupted by a restart, and this install has no attempt of
 * its own to continue it.
 */
function recordedSubagents(
  sample: SampleSession,
  ids: { dataDir: string; projectId: string; sessionId: string },
): Subagent[] {
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(sample.files)) {
    files.set(fillSampleSession(path, ids), fillSampleSession(text, ids));
  }
  const streams = new Map<string, string>();
  const snapshots = new Map<string, Subagent>();
  for (const [path, text] of files) {
    const child = /\/subagent-([^/]+)\.jsonl$/.exec(path);
    if (child) streams.set(child[1]!, text);
    if (!path.endsWith("/main.jsonl")) continue;
    for (const event of parseStream(text)) {
      if (event.type === "subagent.updated") snapshots.set(event.subagent.id, event.subagent);
    }
  }
  const children: Subagent[] = [];
  for (const [id, snapshot] of snapshots) {
    if (snapshot.status === "running") continue;
    const steps = new Map<string, SubagentStep>();
    for (const event of parseStream(streams.get(id) ?? "")) {
      if (event.type === "subagent.step") steps.set(event.step.id, event.step);
    }
    children.push({ ...snapshot, steps: [...steps.values()] });
  }
  return children;
}

/** One stream's events. A recording is data, not code, so a line this build
 *  cannot read is skipped rather than allowed to take the sample with it. */
function parseStream(text: string): RunStreamEvent[] {
  const events: RunStreamEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as { event?: RunStreamEvent };
      if (record.event !== undefined) events.push(record.event);
    } catch {
      continue;
    }
  }
  return events;
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
  let created: Project | undefined;
  try {
    const sample = sampleSession();
    const project = await store.createProject(sample.projectName);
    created = project;
    const session = await store.createSession(project.id, sample.sessionTitle, {}, {}, {
      allowUnconfiguredModel: true,
    });
    const ids = { dataDir: store.dataDir, projectId: project.id, sessionId: session.id };
    const artifactIds = await seedArtifacts(store, session.id, sample.artifacts);
    for (const [path, text] of Object.entries(sample.files)) {
      const filled = fillSampleSession(text, ids);
      // Only the transcript carries chip references. A run stream is a
      // recording of what happened, and its artifact events are snapshots of
      // the ids the run minted — rewriting those would make the recording
      // disagree with the version ids beside them.
      await writeSample(store.dataDir, path, ids, path.startsWith("messages/")
        ? rewriteArtifactIds(filled, artifactIds)
        : filled);
    }
    for (const [path, base64] of Object.entries(sample.encoded)) {
      await writeSample(store.dataDir, path, ids, Buffer.from(base64, "base64"));
    }
    await store.restoreSubagents(recordedSubagents(sample, ids));
    await writeMarker(store.dataDir, `${session.id}\n`);
    apiLog.info("sample_session_seeded", { projectId: project.id, sessionId: session.id });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // All or nothing. A seed that stopped part-way leaves its own Project
    // behind, and the next start reads any Project with a Session as "this
    // install already has conversations" — so the half-written sample would
    // stay forever, as the transcript this PR exists to stop shipping: a
    // first step that reads a file nothing wrote. Removing it lets the next
    // start seed the sample whole.
    if (created) {
      try {
        await store.deleteProject(created.id, created.id);
      } catch (cleanupError) {
        apiLog.warn("sample_session_cleanup_failed", {
          projectId: created.id,
          reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    apiLog.warn("sample_session_failed", { reason });
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
 *
 * Returns the ids the transcript has to be rewritten with: recorded id → the
 * id this install minted.
 */
async function seedArtifacts(
  store: SessionStore,
  sessionId: string,
  artifacts: SampleArtifact[],
): Promise<Map<string, string>> {
  const cas = new CasStore(store.dataDir, "data");
  const previous = new Map<string, { artifactId: string; versionId: string }>();
  const rewritten = new Map<string, string>();
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
    if (artifact.recordedArtifactId) rewritten.set(artifact.recordedArtifactId, written.artifact.id);
  }
  return rewritten;
}

/** Point the transcript's chip references at the artifacts this install minted. */
function rewriteArtifactIds(text: string, ids: ReadonlyMap<string, string>): string {
  let rewritten = text;
  for (const [recorded, seeded] of ids) rewritten = rewritten.split(recorded).join(seeded);
  return rewritten;
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
