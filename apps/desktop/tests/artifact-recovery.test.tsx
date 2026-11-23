// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiClient } from "../src/api/client.js";
import type { SessionArtifactOutput, SessionRun, Subagent } from "../src/api/types.js";
import { artifactAnchors } from "../src/app/artifact-anchors.js";
import { useTurnArtifacts } from "../src/app/use-turn-artifacts.js";
import { turnArtifactsByRun, turnLineage, type TurnArtifacts } from "../src/app/turn-artifacts.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { Conversation } from "../src/views/Conversation.js";
import { TurnArtifactStrip } from "../src/views/TurnArtifactStrip.js";
import { TEXT } from "../src/text.js";

const idle = emptyRunStream();
const rows = [{ id: "r1", sessionId: "s1", status: "completed", userMessageId: "q1", assistantMessageId: "a1" }] as SessionRun[];
const messages = [
  { id: "q1", role: "user", content: "Question", createdAt: "2026-11-23" },
  { id: "a1", role: "assistant", content: "Saved reply", createdAt: "2026-11-23" },
] as const;
function output(id = "report", turnId = "r1", sessionId = "s1"): SessionArtifactOutput {
  return { artifact: { id, kind: "report", name: `${id}.md` }, version: {
    id: `${id}-v1`, artifactId: id, sessionId, turnId, version: 1,
    createdAt: "2026-11-23", content: { hash: id, size: 64 },
  } } as SessionArtifactOutput;
}
const summary = turnArtifactsByRun([output()], turnLineage(["r1"], []));

test("a pruned answer uses the persisted reply once and keeps status-only replay separate", () => {
  const replay = { runId: "r1", userMessageId: "q1", state: { ...idle, runId: "r1", terminal: true, status: "completed" as const } };
  const anchors = artifactAnchors("s1", rows, [replay], messages, summary, idle);
  assert.equal(anchors.stored.get("a1"), "r1");
  assert.equal(anchors.replays.length, 1);
  const html = renderToStaticMarkup(<Conversation client={{} as ApiClient} detail={{ id: "s1", messages } as never}
    loading={false} onDecidePermission={async () => {}} workspaceFiles={[]} run={idle} replays={[replay]}
    outputs={[output()]} terminalRuns={rows} />);
  assert.equal((html.match(/class="turn-artifacts"/g) ?? []).length, 1);
  assert.ok(html.indexOf("Saved reply") < html.indexOf("report.md"));
});

test("missing events only synthesize terminal anchors for this session's eligible outputs", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const records = [{ ...rows[0]!, assistantMessageId: undefined, status }];
    const anchors = artifactAnchors("s1", records, [], messages.slice(0, 1), summary, idle);
    assert.equal(anchors.replays[0]?.state.status, status);
    assert.equal(anchors.replays[0]?.userMessageId, "q1");
  }
  assert.equal(artifactAnchors("s2", rows, [], [], summary, idle).replays.length, 0);
  assert.equal(artifactAnchors("s1", rows, [], [], new Map(), idle).replays.length, 0);
  assert.equal(artifactAnchors("s1", [{ ...rows[0]!, status: "blocked" }], [], [], summary, idle).replays.length, 0);
});

test("a replayed answer and a terminal live answer each retain a single anchor", () => {
  const state = { ...idle, runId: "r1", terminal: true, status: "completed" as const, finalContent: "Saved reply" };
  for (const replays of [[], [{ runId: "r1", messageId: "a1", state }]]) {
    const anchors = artifactAnchors("s1", rows, replays, messages, summary, state);
    assert.equal(anchors.stored.size, 0);
    assert.equal(anchors.replays.length, 1);
    assert.equal(anchors.replays[0]?.messageId, "a1");
  }
});

test("inline expansion includes folded kinds and collapse restores the five-card selection", async () => {
  const files = Array.from({ length: 7 }, (_, i) => output(`file-${i}`));
  files[6]!.artifact.kind = "json";
  const artifacts = turnArtifactsByRun(files, turnLineage(["r1"], []), 5, true).get("r1");
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<TurnArtifactStrip artifacts={artifacts} onPreviewArtifact={() => {}} />); });
  const cards = () => tree.root.findAll(node => node.type === "button" && node.props.className === "turn-artifact");
  assert.equal(cards().length, 5);
  await act(async () => { tree.root.findByProps({ className: "turn-artifact turn-artifact-rest" }).props.onClick(); });
  assert.equal(cards().length, 7);
  assert.ok(JSON.stringify(tree.toJSON()).includes("file-6.md"));
  await act(async () => { tree.root.findAll(node => node.type === "button" && node.children.includes(TEXT.turnArtifacts.collapse))[0]!.props.onClick(); });
  assert.equal(cards().length, 5);
  await act(async () => tree.unmount());
});

test("catalog failures retry on refreshed same-child outputs and successful reads are reused", async () => {
  let calls = 0;
  const client = { request: async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary catalog outage");
    return [{ id: "child", parentTurnId: "r1" }];
  } } as unknown as ApiClient;
  let selected = new Map<string, TurnArtifacts>();
  function Harness({ outputs }: { outputs: SessionArtifactOutput[] }) {
    selected = useTurnArtifacts(client, "s1", outputs, rows, [], idle);
    return null;
  }
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Harness outputs={[output("first", "child")]} />); });
  assert.equal(calls, 1);
  assert.equal(selected.size, 0);
  await act(async () => tree.update(<Harness outputs={[output("first", "child"), output("second", "child")]} />));
  assert.equal(calls, 2);
  assert.equal(selected.get("r1")?.all?.length, 2);
  await act(async () => tree.update(<Harness outputs={[output("third", "child")]} />));
  assert.equal(calls, 2);
  assert.equal(selected.get("r1")?.all?.[0]?.artifact.id, "third");
  await act(async () => tree.unmount());
});

test("a late catalog response cannot leak across sessions or clients", async () => {
  let resolve!: (children: Subagent[]) => void;
  const client = { request: () => new Promise<Subagent[]>(done => { resolve = done; }) } as unknown as ApiClient;
  const other = { request: async () => [] } as unknown as ApiClient;
  let selected = new Map<string, TurnArtifacts>();
  function Harness({ sessionId, api = client }: { sessionId: string; api?: ApiClient }) {
    selected = useTurnArtifacts(api, sessionId, [output("child-file", "child")], rows, [], idle);
    return null;
  }
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Harness sessionId="s1" />); });
  await act(async () => tree.update(<Harness sessionId="s2" api={other} />));
  await act(async () => resolve([{ id: "child", parentTurnId: "r1" } as Subagent]));
  assert.equal(selected.size, 0);
  await act(async () => tree.update(<Harness sessionId="s1" api={other} />));
  assert.equal(selected.size, 0);
  await act(async () => tree.unmount());
});
