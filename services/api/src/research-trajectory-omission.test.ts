// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { TrajectoryDetail } from "@sciencediscovery/trajectory";
import { filterTrajectoryIndex, readTrajectoryDetail } from "./research-trajectory-detail.js";
import { validatePackageTrajectory, type PackageTrajectory } from "./research-package-trajectory.js";

const readable = (id: string) => ({ entry: { id }, value: { ok: true } }) as unknown as TrajectoryDetail;

test("an unreadable trajectory record becomes an omission instead of failing the export", async () => {
  const omitted: string[] = [];
  const view = {
    detail: async (id: string) => {
      if (id === "pruned") {
        const error = new Error("ENOENT: no such file or directory, open 'state/pruned'") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      // The reader also reports "no such entry" by returning nothing, which used
      // to raise a plain Error and surface as 500 rather than 404.
      if (id === "absent") return undefined;
      return readable(id);
    },
  };
  const omit = (message: string) => { omitted.push(message); };

  // The reported case: the per-entry read throws ENOENT. It must not escape.
  assert.equal(await readTrajectoryDetail(view, { id: "pruned" }, "session-1", omit), undefined);
  assert.deepEqual(omitted, ["trajectory:session-1:pruned:ENOENT: no such file or directory, open 'state/pruned'"]);

  omitted.length = 0;
  assert.equal(await readTrajectoryDetail(view, { id: "absent" }, "session-1", omit), undefined);
  assert.deepEqual(omitted, ["trajectory:session-1:absent:trajectory detail is not available"]);

  // A readable entry still comes back, and records nothing.
  omitted.length = 0;
  assert.equal((await readTrajectoryDetail(view, { id: "kept" }, "session-1", omit))?.entry.id, "kept");
  assert.deepEqual(omitted, []);
});

test("a cancelled export still propagates instead of turning into an omission", async () => {
  const controller = new AbortController();
  controller.abort();
  const omitted: string[] = [];
  const view = { detail: async () => { throw new Error("read after abort"); } };
  await assert.rejects(() => readTrajectoryDetail(view, { id: "entry" }, "session-1", (message) => { omitted.push(message); }, controller.signal));
  assert.deepEqual(omitted, [], "an aborted request is not an unreadable record");
});

const SESSION = "session-1";
const AGENT = "main:session-1";

const entry = (id: string) => ({
  id, agentId: AGENT, kind: "input", label: "context.captured", eventType: "context.captured",
  timestamp: "2026-11-11T12:00:00.000Z", runId: "run-1", contextId: "context-1",
}) as never;

const detail = (id: string) => ({ entry: entry(id), value: { type: "context.captured" } }) as never;

function packageWith(kept: string[], dropped: string[]): PackageTrajectory {
  return {
    index: {
      schemaVersion: 1, sessionId: SESSION, capturedAt: "2026-11-11T12:00:00.000Z",
      agents: [{ id: AGENT, label: "Main Agent" }],
      // The dropped ids stay in the index on purpose: that is the state the
      // reviewer found, where the export succeeded and the import was rejected.
      entries: [...kept, ...dropped].map(entry),
      untimedEntries: dropped.map(entry),
      historicalEntries: dropped.map(entry),
      warnings: [],
    },
    details: kept.map(detail),
    runIds: ["run-1"],
  } as unknown as PackageTrajectory;
}

const validate = (source: PackageTrajectory) =>
  validatePackageTrajectory(source, SESSION, new Set(["run-1"]), new Set([AGENT]));

test("skipping a detail without its index entry produces a package the importer rejects", () => {
  // Pins the defect: 2 index entries, 1 detail. This is what `hydrateTrajectory`
  // used to emit when one record was unreadable (#1083).
  assert.throws(() => validate(packageWith(["kept"], ["pruned"])), /Invalid research package trajectory/u);
});

test("filtering the index to the retained details gives an importable package", () => {
  const dropped = ["pruned", "absent"];
  const filtered = packageWith(["kept"], dropped);
  filtered.index = filterTrajectoryIndex(filtered.index, new Set(["kept"]));

  // 1:1 on every list, and the validator — the real import gate — accepts it.
  assert.deepEqual(filtered.index.entries.map((row) => row.id), ["kept"]);
  assert.deepEqual((filtered.index.untimedEntries ?? []).map((row) => row.id), []);
  assert.deepEqual((filtered.index.historicalEntries ?? []).map((row) => row.id), []);
  assert.equal(filtered.details.length, filtered.index.entries.length);
  validate(filtered);

  // Nothing to drop is a no-op, so a healthy export is unchanged.
  const healthy = packageWith(["kept"], []);
  healthy.index = filterTrajectoryIndex(healthy.index, new Set(["kept"]));
  assert.deepEqual(healthy.index.entries.map((row) => row.id), ["kept"]);
  validate(healthy);
});
