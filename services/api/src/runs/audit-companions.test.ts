// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { auditCompanionIds } from "./audit-companions.js";

const catalogWith = (...ids: string[]) => ({
  get: (id: string) => (ids.includes(id) ? { id } : undefined),
});

test("declaring skills get their audit companions when the catalog has them", () => {
  const active = [
    { id: "hypothesis-tournament", preFinishAudit: true },
    { id: "tree-search", preFinishAudit: true },
    { id: "literature-searcher" },
  ];
  const catalog = catalogWith("audit-hypothesis-tournament", "audit-tree-search");
  assert.deepEqual(auditCompanionIds(active, catalog), ["audit-hypothesis-tournament", "audit-tree-search"]);
});

test("missing companions are skipped; non-declaring skills get none", () => {
  const active = [
    { id: "hypothesis-tournament", preFinishAudit: true },
    { id: "systematic-review", preFinishAudit: true },
    { id: "literature-searcher" },
  ];
  // The catalog only has the systematic-review audit skill.
  assert.deepEqual(
    auditCompanionIds(active, catalogWith("audit-systematic-review")),
    ["audit-systematic-review"],
  );
  assert.deepEqual(auditCompanionIds([{ id: "literature-searcher" }], catalogWith("audit-literature-searcher")), []);
});

test("an already-selected audit skill is never duplicated", () => {
  const active = [
    { id: "tree-search", preFinishAudit: true },
    { id: "audit-tree-search" },
  ];
  assert.deepEqual(auditCompanionIds(active, catalogWith("audit-tree-search")), []);
});
