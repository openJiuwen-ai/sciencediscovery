// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createArtifactViewers } from "../src/plugins/artifact-viewers.js";
test("bundled JSON plugin renders existing markup and can be removed from the slot", () => {
  const input = { kind: "json" as const, parsed: false, source: "<script>unsafe</script>", truncated: true,
    labels: { invalidJson: "Invalid JSON", truncated: "Preview truncated" } };
  const html = renderToStaticMarkup(createArtifactViewers().resolve(input)!.render(input));
  assert.match(html, /json-source-preview/);
  assert.match(html, /Invalid JSON/);
  assert.match(html, /Preview truncated/);
  assert.ok(!html.includes("<script>"));
  assert.equal(createArtifactViewers(["artifact-json"]).resolve(input), undefined);
});
