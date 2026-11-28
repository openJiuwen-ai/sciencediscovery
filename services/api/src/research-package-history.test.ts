// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { ResearchPackageIds, remapRunEvent } from "./research-package-history.js";

test("a tool record's citation list under `references` is left as it is, while a composer reference is still remapped (#1520)", () => {
  const ids = new ResearchPackageIds();
  // The shape a tool call keeps in its own record: no `kind`, no `id`. Treating it as a
  // ComposerReference called `ids.id(undefined)`, threw inside `source.match`, and the
  // API answered 400 with that raw TypeError (#1520).
  const citation = { refsource: "Water Res. 2015 Nov 1;84():378", reftype: "Erratum in", pmid: "", note: "" };
  const event = { type: "tool-call", step: { details: { records: [{ structuredData: { references: [citation] } }] } } };
  assert.deepEqual(remapRunEvent(event, ids), event);

  // The composer's own references still get the new namespace; the guard is about shape,
  // not about switching the rewrite off.
  const composer = { references: [{ kind: "artifact", id: "version-one", sessionId: "session-one", projectId: "project-one" }] };
  const remapped = remapRunEvent(composer, ids);
  assert.equal(remapped.references[0]!.id, ids.id("version-one"));
  assert.notEqual(remapped.references[0]!.id, "version-one");
  assert.equal(remapped.references[0]!.sessionId, ids.id("session-one"));
});
