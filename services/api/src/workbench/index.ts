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

import { INBOX_PROJECT_KIND, type ChatMessage, type ComposerReference, type Project, type Session, type WorkbenchSearchResponse, type WorkbenchSearchResult } from "@sciencediscovery/schema";

import { SkillCatalog } from "@sciencediscovery/specialist";
import { SessionStore } from "../store.js";

const MAX_SEARCH_RESULTS = 250;
/** How many Sessions one content search reads, newest first. A transcript is a
 *  single JSON file read whole, so the scan is deliberately bounded: the 200
 *  most recently active live Sessions outside the inbox are what a reader is
 *  likely to remember saying. Older conversations stay findable by name, title
 *  and Session id, which never need a transcript.
 *  A query that exactly names an existing Session is a lookup, not a content
 *  search, and reads nothing. */
const MAX_CONTENT_SCAN_SESSIONS = 200;
/** Messages scanned per Session before the scan stops, counted from the newest
 *  turn backwards: a transcript is stored oldest-first, and the end of it is
 *  what a reader is likely to remember saying. */
const MAX_CONTENT_SCAN_MESSAGES = 500;
/** Message-body characters scanned per Session, spent from the newest message
 *  backwards for the same reason, so a long Session loses its oldest text to
 *  the budget rather than its newest. */
const MAX_CONTENT_SCAN_CHARS = 2_000_000;
/** Across the whole query, at most this many bytes of serialized transcripts
 *  are charged. A Session is charged for the whole file `readMessages` parsed,
 *  including `modelContext` and every key outside the message body, not only
 *  the text up to the first match. One unusually large transcript still costs
 *  one whole parse — about 200 ms at 30 MB (190-240 ms measured) — but the
 *  budget stops the query from opening every Session after it. */
const MAX_CONTENT_SCAN_TOTAL_BYTES = 8_000_000;
/** Longest matching line a Session hit carries, including its ellipses. */
const MAX_SNIPPET_CHARS = 200;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum?: number): number {
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.max(minimum, Math.trunc(value!));
  return maximum === undefined ? integer : Math.min(maximum, integer);
}

/** True when `text` holds the second half of a surrogate pair at `index`. */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `text` cut to at most `limit` code points, never between the halves of a
 *  surrogate pair: an emoji at the cut must not become half a glyph. */
function clipCodePoints(text: string, limit: number): string {
  let used = 0;
  let index = 0;
  while (index < text.length && used < limit) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    used += 1;
  }
  return text.slice(0, index);
}

/** The matching line of `content`, clipped around the match. `fromEnd` walks the
 *  lines newest first, so a body that repeats the needle reports the turn that
 *  came later. Only the message body is searched: keys of the stored JSON never
 *  are. Cuts land on code points, so a surrogate pair is never split. */
function matchingSnippet(content: string, needle: string, fromEnd = false): string | undefined {
  const lines = content.split(/\r?\n/u);
  for (let cursor = fromEnd ? lines.length - 1 : 0; fromEnd ? cursor >= 0 : cursor < lines.length; cursor += fromEnd ? -1 : 1) {
    const line = lines[cursor]!;
    if (!line) continue;
    const at = line.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const before = Math.min(30, at);
    const after = Math.max(0, MAX_SNIPPET_CHARS - before - needle.length - 2);
    const start = splitsSurrogatePair(line, at - before) ? at - before - 1 : at - before;
    const end = splitsSurrogatePair(line, Math.min(line.length, at + needle.length + after))
      ? Math.min(line.length, at + needle.length + after) - 1
      : Math.min(line.length, at + needle.length + after);
    const body = clipCodePoints(line.slice(start, end).replace(/\s+/gu, " ").trim(), MAX_SNIPPET_CHARS - 2);
    if (!body) continue;
    return `${start > 0 ? "…" : ""}${body}${end < line.length ? "…" : ""}`;
  }
  return undefined;
}

async function transcriptSnippet(
  store: SessionStore,
  sessionId: string,
  needle: string,
  remaining: number,
): Promise<{ charged: number; snippet?: string }> {
  let messages: ChatMessage[];
  try {
    messages = await store.readMessages(sessionId);
  } catch {
    // A Session deleted while the search runs has nothing to match; the rest
    // of the answer is still useful.
    return { charged: 0 };
  }
  // Charge what this read cost: the serialized transcript that `readMessages`
  // parsed, including modelContext and keys outside the message body. The 2M
  // character cap below only limits how much body text is scanned for the
  // needle; the whole file still had to be read, so a hit cannot under-count.
  const charged = Buffer.byteLength(JSON.stringify(messages), "utf8");
  // A transcript is stored oldest-first, so the newest turns are the last
  // entries: the message cap and the character budget are both spent from that
  // end, and a body longer than what is left is cut from its start.
  const loaded = messages.slice(-MAX_CONTENT_SCAN_MESSAGES);
  const limit = Math.min(MAX_CONTENT_SCAN_CHARS, remaining);
  let scanned = 0;
  for (let index = loaded.length - 1; index >= 0; index -= 1) {
    const room = limit - scanned;
    if (room <= 0) break;
    const content = typeof loaded[index]!.content === "string" ? loaded[index]!.content as string : "";
    const body = content.length > room ? content.slice(content.length - room) : content;
    scanned += body.length;
    const snippet = matchingSnippet(body, needle, true);
    if (snippet) return { charged, snippet };
  }
  return { charged };
}

/** Session id → matching line, for the bounded set a content search reads. */
async function contentSnippets(
  store: SessionStore,
  projects: Project[],
  sessionsByProject: Map<string, Session[]>,
  needle: string,
  titleMatches: (session: Session, projectName: string) => boolean,
): Promise<Map<string, string>> {
  const candidates = projects.flatMap((project) => (sessionsByProject.get(project.id) ?? [])
    .filter((session) => !session.archivedAt && !titleMatches(session, project.name)));
  candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const snippets = new Map<string, string>();
  let charged = 0;
  for (const session of candidates.slice(0, MAX_CONTENT_SCAN_SESSIONS)) {
    if (charged >= MAX_CONTENT_SCAN_TOTAL_BYTES) break;
    const remainingScan = Math.min(MAX_CONTENT_SCAN_CHARS, MAX_CONTENT_SCAN_TOTAL_BYTES - charged);
    const result = await transcriptSnippet(store, session.id, needle, remainingScan);
    charged += result.charged;
    if (result.snippet) snippets.set(session.id, result.snippet);
  }
  return snippets;
}

export async function searchWorkbench(
  store: SessionStore,
  query: string,
  options: { limit?: number; offset?: number } = {},
): Promise<WorkbenchSearchResponse> {
  const needle = query.trim().toLocaleLowerCase().slice(0, 200);
  const limit = boundedInteger(options.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const offset = boundedInteger(options.offset, 0, 0);
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLocaleLowerCase().includes(needle));
  const projects = store.listProjects().filter((project) => project.kind !== INBOX_PROJECT_KIND);
  const sessionsByProject = new Map(projects.map((project) => [project.id, store.listSessions(project.id, "all")]));
  const titleMatches = (session: Session, projectName: string) => matches(session.title, projectName, session.id);
  // An exact Session id is the web client's "open this Session" lookup, not a
  // request to search what was said: the id hit already answers it.
  const idLookup = needle !== "" && [...sessionsByProject.values()].some((sessions) => sessions.some((session) => session.id.toLocaleLowerCase() === needle));
  const snippets = needle && !idLookup
    ? await contentSnippets(store, projects, sessionsByProject, needle, titleMatches)
    : new Map<string, string>();
  const results: WorkbenchSearchResult[] = [];

  for (const project of projects) {
    // Standalone conversations are not a Project a reader can navigate to or
    // search for; folding them in would surface a name no client shows.
    const sessions = sessionsByProject.get(project.id) ?? [];
    // A Project has no stamp of its own worth ordering by: what moved is the
    // newest Session inside it, and a Project with none falls back to its birth.
    const projectStamp = sessions.reduce<string>(
      (latest, session) => (session.updatedAt > latest ? session.updatedAt : latest),
      project.createdAt,
    );
    if (matches(project.name)) {
      results.push({
        detail: "Project",
        id: `project:${project.id}`,
        kind: "project",
        label: project.name,
        projectId: project.id,
        projectName: project.name,
        updatedAt: projectStamp,
      });
    }
    for (const session of sessions) {
      const snippet = snippets.get(session.id);
      if (titleMatches(session, project.name) || snippet !== undefined) {
        results.push({
          detail: `${project.name}${session.archivedAt ? " · Archived" : ""}`,
          id: `session:${session.id}`,
          kind: "session",
          label: session.title,
          projectId: project.id,
          projectName: project.name,
          sessionId: session.id,
          updatedAt: session.updatedAt,
          ...(session.archivedAt ? { archived: true } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
        });
      }
    }
    for (const artifact of store.listProjectArtifacts(project.id)) {
      const session = sessions.find((item) => item.id === artifact.createdInSessionId);
      if (!matches(artifact.name, artifact.title ?? "", artifact.createdInSessionTitle, project.name)) continue;
      results.push({
        detail: `${project.name} / ${session?.title ?? "Deleted Session"} · ${artifact.origin}`,
        id: `artifact:${artifact.id}`,
        kind: "artifact",
        label: artifact.name,
        origin: artifact.origin,
        path: artifact.name,
        projectId: project.id,
        projectName: project.name,
        updatedAt: artifact.updatedAt,
        ...(session ? { sessionId: session.id, sessionTitle: session.title } : {}),
      });
    }
  }
  const total = results.length;
  const page = results.slice(offset, offset + limit);
  return {
    hasMore: offset + page.length < total,
    limit,
    offset,
    results: page,
    total,
  };
}

export async function resolveComposerReferences(
  references: ComposerReference[] | undefined,
  sessionId: string,
  store: SessionStore,
  skillCatalog: SkillCatalog,
): Promise<ComposerReference[]> {
  if (!references?.length) return [];
  if (references.length > 16) throw new Error("A message can contain at most 16 context references");
  const resolved: ComposerReference[] = [];
  const currentSession = store.getSession(sessionId);
  if (!currentSession) throw new Error("Session not found");
  for (const reference of references) {
    if (!reference || typeof reference.id !== "string" || typeof reference.kind !== "string") {
      throw new Error("Composer reference is malformed");
    }
    if (reference.kind === "artifact") {
      const artifact = store.getProjectArtifact(currentSession.projectId, reference.id)
        ?? (reference.path ? store.getArtifactByName(sessionId, reference.path) : undefined);
      if (!artifact) throw new Error(`Referenced Project artifact is unavailable: ${reference.path ?? reference.id}`);
      resolved.push({
        createdInSessionTitle: artifact.createdInSessionTitle,
        id: artifact.id,
        kind: "artifact",
        label: artifact.name,
        origin: artifact.origin,
        path: artifact.name,
        projectId: artifact.projectId,
        sessionId: artifact.createdInSessionId,
      });
      continue;
    }
    if (reference.kind === "session") {
      const target = store.getSession(reference.id);
      if (!target) throw new Error(`Referenced Session is unavailable: ${reference.id}`);
      resolved.push({
        id: target.id,
        kind: "session",
        label: target.title,
        projectId: target.projectId,
        sessionId: target.id,
      });
      continue;
    }
    if (reference.kind === "skill") {
      const skill = skillCatalog.get(reference.id);
      if (!skill) throw new Error(`Referenced skill is unavailable: ${reference.id}`);
      resolved.push({ id: skill.id, kind: "skill", label: skill.name });
      continue;
    }
    throw new Error(`Unsupported Composer reference kind: ${reference.kind}`);
  }

  return resolved.filter((reference, index, values) =>
    values.findIndex((candidate) => candidate.kind === reference.kind && candidate.id === reference.id) === index);
}

export function messagePromptContent(message: Pick<ChatMessage, "annotations" | "content" | "references" | "runtimeNotice">): string {
  // Runtime records are stored beside the message body, never inside it. The
  // model input is the only place they are re-attached.
  const body = message.runtimeNotice
    ? [message.content, message.runtimeNotice.prompt].filter((part) => part.trim()).join("\n\n")
    : message.content;
  if (!message.references?.length && !message.annotations?.length) return body;
  const lines = (message.references ?? []).map((reference) => {
    if (reference.kind === "artifact") {
      return `- Artifact: ${reference.label} (artifact_id=${reference.id}, origin=${reference.origin ?? "unknown"}, created in session ${reference.createdInSessionTitle ?? reference.sessionId ?? "unknown"}); use read_artifact to read its content`;
    }
    if (reference.kind === "session") return `- Session: ${reference.label} (id: ${reference.id})`;
    return `- Attached skill: ${reference.label} (id: ${reference.id})`;
  });
  const annotations = (message.annotations ?? []).map((annotation) => {
    const region = annotation.width !== undefined && annotation.height !== undefined
      ? `region x=${annotation.x.toFixed(4)}, y=${annotation.y.toFixed(4)}, width=${annotation.width.toFixed(4)}, height=${annotation.height.toFixed(4)}`
      : `point x=${annotation.x.toFixed(4)}, y=${annotation.y.toFixed(4)}`;
    return `- Figure annotation on ${annotation.artifactLogicalName} (version id ${annotation.artifactVersionId}), ${region}: ${annotation.note}`;
  });
  return `${body}\n\nStructured context references:\n${[...lines, ...annotations].join("\n")}`;
}
