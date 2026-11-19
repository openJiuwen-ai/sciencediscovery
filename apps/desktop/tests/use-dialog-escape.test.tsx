// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { useTopmostEscape } from "../src/views/use-dialog-escape.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("topmost Escape hook claims only unhandled Escape events and cleans up", () => {
  const listeners = new Set<(event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => void>();
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    addEventListener: (_type: string, listener: (event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => void) => listeners.delete(listener),
  };
  let calls = 0;
  function Probe() {
    useTopmostEscape(() => { calls += 1; });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  try {
    act(() => { renderer = create(<Probe />); });
    const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of listeners) listener(event);
    assert.equal(calls, 1);
    assert.equal(event.defaultPrevented, true);
    const enter = { key: "Enter", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of listeners) listener(enter);
    assert.equal(calls, 1);
    act(() => renderer?.unmount());
    assert.equal(listeners.size, 0);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});
