// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import type { ComposerReference, SessionArtifactOutput } from "../src/api/types.js";
import { turnArtifactsByRun, turnLineage } from "../src/app/turn-artifacts.js";
import { emptyRunStream, type RunStreamState } from "../src/run-stream/model.js";
import { TEXT } from "../src/text.js";
import { AssistantTurns } from "../src/views/AssistantTurn.js";
import { TurnArtifactStrip } from "../src/views/TurnArtifactStrip.js";

const client = new Proxy({} as ApiClient, {
  get: () => () => Promise.reject(new Error("no request is expected from a static render")),
});

let seq = 0;
function output(over: {
  artifactId?: string;
  kind?: SessionArtifactOutput["artifact"]["kind"];
  name?: string;
  /** The run (or subagent) the version names in `turnId`. */
  turnId?: string;
  version?: number;
  baseVersionId?: string;
} = {}): SessionArtifactOutput {
  seq += 1;
  const artifactId = over.artifactId ?? `artifact-${seq}`;
  const version = over.version ?? 1;
  return {
    artifact: {
      createdAt: "2026-11-19T10:00:00.000Z",
      createdInSessionId: "s1",
      createdInSessionTitle: "Session",
      currentVersion: version,
      id: artifactId,
      kind: over.kind ?? "report",
      logicalName: artifactId,
      name: over.name ?? `${artifactId}.md`,
      origin: "llm_declared",
      projectId: "p1",
      sessionId: "s1",
      updatedAt: "2026-11-19T10:00:00.000Z",
    },
    version: {
      artifactId,
      content: { hash: `hash-${artifactId}-${version}`, size: 2048 },
      createdAt: "2026-11-19T10:00:00.000Z",
      // The execution that wrote the bytes, distinct from the run — the shape
      // the backend writes. Joining on this is the bug the review caught.
      executionRunIds: [`exec-${artifactId}-${version}`],
      id: `${artifactId}-v${version}`,
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "p1",
      sessionId: "s1",
      turnId: over.turnId ?? "run-1",
      version,
      ...(over.baseVersionId ? { baseVersionId: over.baseVersionId } : {}),
    },
  };
}

const LINEAGE = turnLineage(["run-1", "run-2"], []);

function turns(run: Partial<RunStreamState>, outputs: SessionArtifactOutput[]): string {
  const byRun = turnArtifactsByRun(outputs, LINEAGE);
  const state = { ...emptyRunStream(), finalContent: "done", modelName: "m", runId: "run-1", ...run };
  return renderToStaticMarkup(
    <AssistantTurns
      artifacts={byRun.get(state.runId ?? "")}
      client={client}
      onDecide={() => Promise.resolve()}
      run={state}
      sessionId="s1"
    />,
  );
}

describe("the strip under a turn (#1252)", () => {
  it("draws nothing for a turn that wrote no artifact", () => {
    const html = turns({ terminal: true, status: "completed" }, [output({ turnId: "run-2" })]);
    assert.equal(html.includes("turn-artifacts"), false);
    assert.equal(html.includes(TEXT.turnArtifacts.title), false);
  });

  it("waits for the run to end before it lists anything", () => {
    const files = [output({ name: "report.md" })];
    const live = turns({ terminal: false, status: "running" }, files);
    assert.equal(live.includes("report.md"), false, "a streaming run has no strip yet");
    const done = turns({ terminal: true, status: "completed" }, files);
    assert.ok(done.includes(TEXT.turnArtifacts.title));
    assert.ok(done.includes("report.md"));
  });

  it("opens the version the row shows, not the newest one", async () => {
    const older = output({ artifactId: "figure", kind: "figure", name: "plot.png", turnId: "run-1", version: 3, baseVersionId: "figure-v2" });
    // A later run wrote v4; the strip of run-1 still points at v3.
    const newer = output({ artifactId: "figure", kind: "figure", name: "plot.png", turnId: "run-2", version: 4, baseVersionId: "figure-v3" });
    const opened: ComposerReference[] = [];
    let strip!: ReactTestRenderer;
    await act(async () => {
      strip = create(
        <TurnArtifactStrip
          artifacts={turnArtifactsByRun([older, newer], LINEAGE).get("run-1")}
          onOpenArtifact={(reference) => opened.push(reference)}
        />,
      );
    });
    const rows = strip.root.findAll((node) => node.type === "button" && node.props.className === "turn-artifact");
    assert.equal(rows.length, 1);
    const text = JSON.stringify(strip.toJSON());
    assert.ok(text.includes(TEXT.turnArtifacts.updated), "a version derived from an earlier one says so");
    await act(async () => { rows[0]!.props.onClick(); });
    assert.deepEqual(opened, [{ id: "figure", kind: "artifact", label: "plot.png", sessionId: "s1", version: 3 }]);
    strip.unmount();
  });

  it("stops at five rows and sends the rest to the panel", async () => {
    const files = Array.from({ length: 7 }, (_, index) => output({ name: `report-${index}.md` }));
    let panel = 0;
    let strip!: ReactTestRenderer;
    await act(async () => {
      strip = create(
        <TurnArtifactStrip
          artifacts={turnArtifactsByRun(files, LINEAGE).get("run-1")}
          onOpenArtifact={() => undefined}
          onOpenArtifactPanel={() => { panel += 1; }}
        />,
      );
    });
    const rows = strip.root.findAll((node) => node.type === "button" && node.props.className === "turn-artifact");
    assert.equal(rows.length, 5);
    const more = strip.root.findAll((node) => node.type === "button" && node.props.className === "turn-artifacts-more");
    assert.equal(more.length, 1);
    assert.ok(JSON.stringify(strip.toJSON()).includes(TEXT.turnArtifacts.more(2)));
    await act(async () => { more[0]!.props.onClick(); });
    assert.equal(panel, 1);
    strip.unmount();
  });
});
