// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextMessageComposer } from "./message-composer.js";

test("message composer adds hidden invocation data without mutating history", () => {
  const history = [{ role: "user", content: "question" }];
  const output = new DefaultContextMessageComposer().compose({
    attachments: [{ content: "payload", id: "record.one", source: 'source"unsafe', trust: "untrusted_data" }],
    history,
    messages: [{ role: "user", content: "working note" }],
  });
  assert.equal(history.length, 1);
  assert.equal(output.length, 3);
  assert.equal((output[1]?.additional_kwargs as Record<string, unknown>).context_contributor_message, true);
  assert.match(String(output[2]?.content), /source="source&quot;unsafe"/u);
  assert.equal((output[2]?.additional_kwargs as Record<string, unknown>).hide_from_ui, true);
});

test("message composer rejects forged assistant or tool messages", () => {
  const composer = new DefaultContextMessageComposer();
  assert.throws(() => composer.compose({ attachments: [], history: [], messages: [{ role: "tool", content: "bad" }] }), /only add user messages/u);
});
