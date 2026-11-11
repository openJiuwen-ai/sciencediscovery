// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { TrajectoryDetail } from "@sciencediscovery/trajectory";
import { readTrajectoryDetail } from "./research-trajectory-detail.js";

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
