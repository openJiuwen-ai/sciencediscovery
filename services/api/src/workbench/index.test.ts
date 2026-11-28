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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { ChatMessage, Project, ScientificArtifact, Session } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";
import { searchWorkbench } from "./index.js";

const project: Project = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "project-1",
  name: "Mixed catalog",
  remoteRunnerHostIds: [],
  settingsOverrides: {},
};

function session(index: number): Session {
  const id = `session-${index}`;
  return {
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-01-01T00:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id,
    permissionEpochId: `epoch-${index}`,
    projectId: project.id,
    reviewCriteria: [],
    reviewMode: "manual",
    reviewerAutomaticReviewEnabled: true,
    reviewerSpecialistLevel: "quick",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    title: `Analysis session ${index}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function artifact(index: number): ScientificArtifact {
  const target = index === 149;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    createdInSessionId: "session-0",
    createdInSessionTitle: "Analysis session 0",
    currentVersion: 1,
    id: `artifact-${index}`,
    kind: "dataset",
    logicalName: target ? "target-after-250.csv" : `result-${index}.csv`,
    name: target ? "target-after-250.csv" : `result-${index}.csv`,
    origin: "user_upload",
    projectId: project.id,
    sessionId: "session-0",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("server-side query reaches matching mixed-catalog records beyond the first 250", async () => {
  const sessions = Array.from({ length: 150 }, (_, index) => session(index));
  const artifacts = Array.from({ length: 150 }, (_, index) => artifact(index));
  const store = {
    listProjectArtifacts: () => artifacts,
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async () => [],
  } as unknown as SessionStore;

  const firstPage = await searchWorkbench(store, "", { limit: 250 });
  assert.equal(firstPage.total, 301);
  assert.equal(firstPage.results.length, 250);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.results.some((result) => result.label === "target-after-250.csv"), false);

  const secondPage = await searchWorkbench(store, "", { limit: 250, offset: 250 });
  assert.equal(secondPage.results.length, 51);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.results.some((result) => result.label === "target-after-250.csv"), true);

  const targeted = await searchWorkbench(store, "target-after-250");
  assert.deepEqual(targeted.results.map((result) => result.label), ["target-after-250.csv"]);
  assert.deepEqual({ hasMore: targeted.hasMore, total: targeted.total }, { hasMore: false, total: 1 });
});

test("results carry the parts of their English detail, so a client can show them in its own language", async () => {
  const archived = { ...session(1), archivedAt: "2026-01-02T00:00:00.000Z" };
  const orphan = { ...artifact(2), createdInSessionId: "session-gone", name: "orphan.csv" };
  const store = {
    listProjectArtifacts: () => [artifact(1), orphan],
    listProjects: () => [project],
    listSessions: () => [session(0), archived],
  } as unknown as SessionStore;

  const byId = new Map((await searchWorkbench(store, "")).results.map((result) => [result.id, result]));
  assert.deepEqual(byId.get("project:project-1"), {
    detail: "Project", id: "project:project-1", kind: "project", label: "Mixed catalog", projectId: "project-1", projectName: "Mixed catalog",
    // A Project has no stamp of its own to order by: its newest Session is what
    // moved, and here its Sessions are as old as the Project itself.
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(byId.get("session:session-0")?.archived, undefined);
  assert.equal(byId.get("session:session-1")?.archived, true);
  assert.equal(byId.get("session:session-1")?.detail, "Mixed catalog · Archived");
  const kept = byId.get("artifact:artifact-1")!;
  assert.deepEqual([kept.projectName, kept.sessionTitle, kept.origin], ["Mixed catalog", "Analysis session 0", "user_upload"]);
  const deleted = byId.get("artifact:artifact-2")!;
  assert.equal(deleted.sessionTitle, undefined);
  assert.equal(deleted.detail, "Mixed catalog / Deleted Session · user_upload");
});

test("every hit carries the stamp a client orders by, and a Project borrows its newest Session's", async () => {
  // The dialog groups by kind and sorts each group newest first, and the route
  // promises no order — so each hit has to say when it last moved. A Session
  // and an artifact know their own; a Project is a container, so the newest
  // Session inside it stands in, and a Project with none falls back to its birth
  // rather than sorting as unknown.
  const moved = { ...session(0), updatedAt: "2026-01-05T00:00:00.000Z" };
  const store = {
    listProjectArtifacts: () => [artifact(1)],
    listProjects: () => [project],
    listSessions: () => [moved],
  } as unknown as SessionStore;

  const byId = new Map((await searchWorkbench(store, "")).results.map((result) => [result.id, result]));
  assert.equal(byId.get("project:project-1")?.updatedAt, "2026-01-05T00:00:00.000Z", "a Project is stamped with its newest Session");
  assert.equal(byId.get("session:session-0")?.updatedAt, "2026-01-05T00:00:00.000Z", "a Session carries its own stamp");
  assert.equal(byId.get("artifact:artifact-1")?.updatedAt, "2026-01-01T00:00:00.000Z", "an artifact carries its own stamp");

  const empty = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [],
  } as unknown as SessionStore;
  const born = (await searchWorkbench(empty, "")).results.find((result) => result.kind === "project");
  assert.equal(born?.updatedAt, project.createdAt, "a Project with no Sessions is stamped with its birth");
});

test("the recent-sessions Project and its contents never appear in search results", async () => {
  const inbox: Project = { ...project, id: "inbox-1", kind: "inbox", name: "Recent sessions" };
  const store = {
    listProjectArtifacts: (projectId: string) => (projectId === inbox.id ? [{ ...artifact(1), projectId: inbox.id, name: "standalone.csv" }] : []),
    listProjects: () => [project, inbox],
    listSessions: (projectId: string) => (projectId === inbox.id ? [{ ...session(9), projectId: inbox.id, title: "Standalone chat" }] : [session(0)]),
  } as unknown as SessionStore;

  const results = (await searchWorkbench(store, "")).results;
  assert.deepEqual(results.map((result) => result.projectId), [project.id, project.id]);
  assert.equal(results.some((result) => result.label === "Recent sessions" || result.label === "Standalone chat"), false);
});

function message(content: string, index = 0): ChatMessage {
  return { content, createdAt: `2026-01-01T00:00:0${index}.000Z`, id: `message-${index}`, role: "user" };
}

test("a Session found only by its message text is one session hit carrying the matching line", async () => {
  const sessions = [session(0), { ...session(1), title: "Untitled notes", updatedAt: "2026-01-02T00:00:00.000Z" }];
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => sessionId === "session-1"
      ? [message("We grew a CRYSTAL STRUCTURE at 300 K.")]
      : [message("Unrelated notes")],
  } as unknown as SessionStore;

  // The needle is not in the Project name, the Session title or the Session id,
  // so only the transcript can produce this hit.
  const answer = await searchWorkbench(store, "crystal structure");
  assert.deepEqual(answer.results.map((result) => result.id), ["session:session-1"]);
  assert.equal(answer.total, 1);
  const hit = answer.results[0]!;
  assert.equal(hit.kind, "session");
  assert.equal(hit.label, "Untitled notes");
  assert.match(hit.snippet ?? "", /CRYSTAL STRUCTURE/u, "the hit carries the line that matched, in its own casing");
  assert.equal(searchSnippetCount(answer, "snippet"), 1);

  const absent = await searchWorkbench(store, "phrase that was never said");
  assert.deepEqual(absent.results, []);
  assert.equal(absent.total, 0);
});

function searchSnippetCount(answer: Awaited<ReturnType<typeof searchWorkbench>>, field: "snippet"): number {
  return answer.results.filter((result) => result[field] !== undefined).length;
}

test("message matching is case-insensitive and never matches a key of the stored JSON", async () => {
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0)],
    // The stored record holds `role` and `content` keys; only the body is searched.
    readMessages: async () => [{ ...message("nothing relevant here"), role: "assistant" }],
  } as unknown as SessionStore;

  assert.deepEqual((await searchWorkbench(store, "ROLE")).results, [], "a JSON key is not message text");
  assert.deepEqual((await searchWorkbench(store, "content")).results, [], "nor is the content key itself");
  const found = await searchWorkbench(store, "NOTHING RELEVANT");
  assert.deepEqual(found.results.map((result) => result.id), ["session:session-0"]);
  assert.match(found.results[0]?.snippet ?? "", /nothing relevant here/u);
});

test("a title hit whose transcript also matches appears once and is not read", async () => {
  let reads = 0;
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [{ ...session(0), title: "Crystal report" }],
    readMessages: async () => {
      reads += 1;
      return [message("Crystal report")];
    },
  } as unknown as SessionStore;

  const answer = await searchWorkbench(store, "crystal");
  assert.deepEqual(answer.results.map((result) => result.id), ["session:session-0"]);
  assert.equal(answer.total, 1, "the title and the body matching is one Session, not two");
  assert.equal(reads, 0, "a title hit needs no transcript read");
});

test("content hits page a mixed result set without duplicates or gaps", async () => {
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    ...session(index),
    updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  })).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const matching = new Set(["session-0", "session-2", "session-4"]);
  const store = {
    listProjectArtifacts: () => [{ ...artifact(1), logicalName: "measured phrase table.csv", name: "measured phrase table.csv" }],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => [message(matching.has(sessionId) ? "The measured phrase is here" : "Something else")],
  } as unknown as SessionStore;

  const first = await searchWorkbench(store, "measured phrase", { limit: 2 });
  const second = await searchWorkbench(store, "measured phrase", { limit: 2, offset: 2 });
  assert.equal(first.total, 4, "three Sessions and one artifact");
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual([...first.results, ...second.results].map((result) => result.id), [
    "session:session-4", "session:session-2", "session:session-0", "artifact:artifact-1",
  ]);
  assert.equal(new Set([...first.results, ...second.results].map((result) => result.id)).size, 4, "no row repeats");
  assert.deepEqual(first.results.filter((result) => result.kind === "session").map((result) => result.snippet !== undefined), [true, true]);
});

test("an empty query and an exact Session-id lookup read no transcripts", async () => {
  const reads: string[] = [];
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0), session(1)],
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return [message("body phrase")];
    },
  } as unknown as SessionStore;

  await searchWorkbench(store, "");
  await searchWorkbench(store, "   ");
  assert.deepEqual(reads, [], "listing the whole index and an empty query never scan transcripts");

  const byId = await searchWorkbench(store, "session-1");
  assert.deepEqual(byId.results.map((result) => result.id), ["session:session-1"]);
  assert.deepEqual(reads, [], "the web client's Session-id lookup is not a content search");

  const content = await searchWorkbench(store, "body phrase");
  assert.deepEqual(content.results.map((result) => result.id), ["session:session-0", "session:session-1"]);
  assert.ok(reads.length > 0, "a real content query does read the bounded candidates");
});

test("inbox and archived Sessions are never content-searched, while a title hit keeps its archived mark", async () => {
  const inbox: Project = { ...project, id: "inbox-1", kind: "inbox", name: "Recent sessions" };
  const archived = { ...session(1), archivedAt: "2026-01-02T00:00:00.000Z" };
  const reads: string[] = [];
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project, inbox],
    listSessions: (projectId: string) => (projectId === inbox.id
      ? [{ ...session(9), projectId: inbox.id, title: "Standalone chat" }]
      : [archived, session(2)]),
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return [message("the shared phrase")];
    },
  } as unknown as SessionStore;

  const content = await searchWorkbench(store, "shared phrase");
  assert.deepEqual(content.results.map((result) => result.id), ["session:session-2"], "only the live Project Session is a content hit");
  assert.equal(content.total, 1, "an inbox or archived body match cannot raise the total");
  assert.deepEqual(reads, ["session-2"], "only the live candidate is read");

  const archivedTitle = await searchWorkbench(store, "Analysis session 1");
  const archivedHit = archivedTitle.results.find((result) => result.id === "session:session-1");
  assert.equal(archivedHit?.archived, true, "a title hit in an archived Session keeps the mark the client drops it by");
});

test("a long matching line is clipped around the needle", async () => {
  const line = `${"a".repeat(400)} needle ${"b".repeat(400)}`;
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0)],
    readMessages: async () => [message(line)],
  } as unknown as SessionStore;

  const snippet = (await searchWorkbench(store, "needle")).results[0]?.snippet ?? "";
  assert.ok(snippet.includes("needle"));
  assert.ok(snippet.length <= 200, "the snippet is bounded");
  assert.match(snippet, /^…/u);
  assert.match(snippet, /…$/u);
});

test("the aggregate body budget stops opening more transcripts", async () => {
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    ...session(index),
    updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  })).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const reads: string[] = [];
  const transcript = "x".repeat(3_000_000);
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return [message(transcript)];
    },
  } as unknown as SessionStore;

  const answer = await searchWorkbench(store, "a phrase that is not in the transcripts");
  assert.deepEqual(answer.results, []);
  // Each 3M-character transcript costs about 3M serialized bytes, so the 8M
  // aggregate budget stops after three files. The remaining seven are never
  // opened, so neither a large catalog nor large files can make every
  // keystroke pay for the whole workspace.
  assert.equal(reads.length, 3);
  assert.deepEqual(reads, sessions.slice(0, 3).map((item) => item.id));
});

test("the aggregate budget also stops after hits, because each read is charged in full", async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    ...session(index),
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  })).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const reads: string[] = [];
  // 500 × 4,000-character messages ≈ 2M characters per Session, the documented
  // cap; the needle is in the newest message, so a hit returns at once even
  // when the aggregate budget has already shrunk what this Session may scan.
  const transcript = Array.from({ length: 500 }, (_, index) => message(
    index === 499 ? `needle ${"y".repeat(3_993)}` : "y".repeat(4_000),
    index,
  ));
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return transcript;
    },
  } as unknown as SessionStore;

  const answer = await searchWorkbench(store, "needle");
  // A hit must still charge the whole transcript that was parsed: four ~2M-byte
  // files exhaust the 8M budget, not all forty.
  assert.equal(reads.length, 4);
  assert.equal(answer.total, 4);
  assert.equal(answer.results.length, 4);
  assert.ok(answer.results.every((result) => result.snippet?.includes("needle")));
});

test("modelContext bytes count toward the budget even when the message body is short", async () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    ...session(index),
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  })).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const reads: string[] = [];
  // ~1.5 MB of modelContext per Session with a tiny body: the file that
  // readMessages parses is what costs, not just message.content.
  const record = {
    ...message("short body"),
    modelContext: [{ text: "m".repeat(1_500_000) }],
  };
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return [record];
    },
  } as unknown as SessionStore;

  const answer = await searchWorkbench(store, "needle");
  assert.deepEqual(answer.results, []);
  assert.equal(reads.length, 6, "6 × ~1.5 MB exhausts the 8 MB budget; the other fourteen are not opened");
});

test("four transcripts well over the per-Session scan cap stop after one or two reads", async () => {
  const sessions = Array.from({ length: 4 }, (_, index) => session(index));
  const reads: string[] = [];
  const transcript = [message("x".repeat(5_000_000))];
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return transcript;
    },
  } as unknown as SessionStore;

  await searchWorkbench(store, "needle");
  assert.ok(reads.length >= 1 && reads.length <= 2,
    `the actual serialized cost stops the scan after one or two 5 MB files, got ${reads.length}`);
});

test("an ordinary 200-Session corpus still reaches the oldest content hit", async () => {
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    ...session(index),
    updatedAt: `2026-01-${String(Math.floor(index / 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
  })).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const reads: string[] = [];
  const body = "ordinary observation ".repeat(1_700);
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => sessions,
    readMessages: async (sessionId: string) => {
      reads.push(sessionId);
      return [message(sessionId === "session-0" ? `${body} the only needle` : body)];
    },
  } as unknown as SessionStore;

  const answer = await searchWorkbench(store, "the only needle");
  assert.equal(reads.length, 200, "the whole 200 × ~36k corpus (~7.2 MB) fits the budget");
  assert.ok(answer.results.some((result) => result.id === "session:session-0"),
    "the oldest Session is still reached when the ordinary corpus fits");
});

test("a Session longer than the message cap is searched from its newest turn", async () => {
  const transcript = Array.from({ length: 600 }, (_, index) => message(`observation ${index}`));
  transcript[599] = message("the newest turn mentions the needle");
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0)],
    readMessages: async () => transcript,
  } as unknown as SessionStore;

  // A transcript is stored oldest-first: the turn that carries the needle is
  // #599, so only a scan that starts from the newest end can find it.
  const answer = await searchWorkbench(store, "the needle");
  assert.deepEqual(answer.results.map((result) => result.id), ["session:session-0"]);
  assert.match(answer.results[0]?.snippet ?? "", /newest turn/u);
});

test("the per-Session character budget is spent from the newest message", async () => {
  const filler = "observation ".repeat(500_000);
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0)],
    readMessages: async () => [
      message(filler),
      message(filler),
      message("closing remark carries the needle"),
    ],
  } as unknown as SessionStore;

  // The two filler turns hold 6 MB of body, far past the 2M character cap, so
  // spending the budget on the oldest text first would never reach the needle.
  const answer = await searchWorkbench(store, "carries the needle");
  assert.deepEqual(answer.results.map((result) => result.id), ["session:session-0"]);
  assert.match(answer.results[0]?.snippet ?? "", /closing remark/u);
});

test("a clipped snippet never splits an emoji in half", async () => {
  const line = `${"a".repeat(30)}needles${"\u{1F642}".repeat(200)}`;
  const store = {
    listProjectArtifacts: () => [],
    listProjects: () => [project],
    listSessions: () => [session(0)],
    readMessages: async () => [message(line)],
  } as unknown as SessionStore;

  const snippet = (await searchWorkbench(store, "needles")).results[0]?.snippet ?? "";
  assert.ok(snippet.includes("needles"));
  assert.doesNotMatch(snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    "a surrogate pair is never cut in half");
});
