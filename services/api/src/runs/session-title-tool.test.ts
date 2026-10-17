// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "../store.js";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { UNTITLED_SESSION_TITLE, type Session } from "@sciencediscovery/schema";
import { createSessionTitleTool } from "./session-title-tool.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function fixture(title = UNTITLED_SESSION_TITLE) {
  const session = { id: "owned", title } as Session;
  const events: Session[] = [];
  let conflict = false;
  const tool = createSessionTitleTool({
    getSession(id) { assert.equal(id, "owned"); return { ...session }; },
    async compareAndSetSessionTitle(id, expected, next) {
      assert.equal(id, "owned");
      if (conflict) session.title = "Concurrent manual title";
      if (session.title !== expected) return undefined;
      session.title = next;
      return { ...session };
    },
  }, "owned", async (updated) => { events.push(updated); });
  return { session, events, tool, race: () => { conflict = true; } };
}

test("agent names an Untitled session, then follows a clear topic change", async () => {
  const f = fixture();
  await f.tool.execute("first", { title: "  Iris statistics  ", expected_title: UNTITLED_SESSION_TITLE, reason: "initial_topic" });
  assert.equal(f.session.title, "Iris statistics");
  await f.tool.execute("later", { title: "Enzyme kinetics", expected_title: "Iris statistics", reason: "topic_change" });
  assert.equal(f.session.title, "Enzyme kinetics");
  assert.deepEqual(f.events.map((event) => event.title), ["Iris statistics", "Enzyme kinetics"]);
});

test("initial naming preserves manual titles; explicit user rename remains possible", async () => {
  const f = fixture("My chosen title");
  const result = await f.tool.execute("first", { title: "Suggested topic", expected_title: "My chosen title", reason: "initial_topic" });
  assert.deepEqual(result.details, { renamed: false, reason: "existing_title", title: "My chosen title" });
  assert.equal(f.events.length, 0);
  await f.tool.execute("requested", { title: "User requested title", expected_title: "My chosen title", reason: "user_request" });
  assert.equal(f.session.title, "User requested title");
});

test("stale context and a compare-and-set race both preserve concurrent manual renames", async () => {
  const f = fixture("Manual title");
  const stale = await f.tool.execute("stale", { title: "Topic", expected_title: UNTITLED_SESSION_TITLE, reason: "topic_change" });
  assert.deepEqual(stale.details, { renamed: false, reason: "title_changed", title: "Manual title" });
  f.race();
  const raced = await f.tool.execute("race", { title: "Topic", expected_title: "Manual title", reason: "user_request" });
  assert.deepEqual(raced.details, { renamed: false, reason: "title_changed", title: "Concurrent manual title" });
  assert.equal(f.events.length, 0);
});

test("short titles count Unicode code points; empty and overlong titles fail without mutation", async () => {
  const f = fixture();
  for (const title of [" \n ", "a".repeat(25)]) {
    await assert.rejects(f.tool.execute("invalid", { title, expected_title: UNTITLED_SESSION_TITLE, reason: "initial_topic" }), /1–24/);
  }
  const title = "🧪".repeat(24);
  await f.tool.execute("unicode", { title, expected_title: UNTITLED_SESSION_TITLE, reason: "initial_topic" });
  assert.equal(f.session.title, title);
  assert.equal(f.events.length, 1);
});

test("cancelled runs, archived sessions and no-op renames emit no update", async () => {
  const f = fixture("Existing");
  const args = { title: "Existing", expected_title: "Existing", reason: "user_request" as const };
  await f.tool.execute("same", args);
  await assert.rejects(f.tool.execute("cancelled", args, AbortSignal.abort()));
  f.session.archivedAt = new Date().toISOString();
  await assert.rejects(f.tool.execute("archived", args), /archived/);
  assert.equal(f.events.length, 0);
});

// Use the real store so refinement provenance and manual API edits are tested,
// rather than teaching the fixture the behavior that the regression expects.
for (const edit of ["none", "manual", "same-title", "away-and-back", "agent"] as const) {
  test(`explicit rename after background refinement preserves ${edit} intervening edit`, async (context) => {
    const root = await mkdtemp(join(process.cwd(), ".tmp/title-race-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const store = new SessionStore(root);
    await store.load();
    const project = await store.createProject("Title race");
    const session = await store.createSession(project.id, "Provisional", {}, {}, { allowUnconfiguredModel: true });
    const events: Session[] = [];
    const tool = createSessionTitleTool(store, session.id, async (updated) => { events.push(updated); });
    // The lead has already received the provisional title in its context.
    await store.compareAndSetSessionTitle(session.id, "Provisional", "Refined", "refinement");
    if (edit === "manual") await store.updateSession(session.id, { title: "Manual" });
    if (edit === "same-title") await store.updateSession(session.id, { title: "Refined" });
    if (edit === "away-and-back") {
      await store.updateSession(session.id, { title: "Manual" });
      await store.updateSession(session.id, { title: "Refined" });
    }
    if (edit === "agent") await store.compareAndSetSessionTitle(session.id, "Refined", "Agent title");
    const topicChange = await tool.execute("topic", { title: "New topic", expected_title: "Provisional", reason: "topic_change" });
    assert.equal((topicChange.details as { reason: string }).reason, "title_changed");
    const before = store.getSession(session.id)!.title;
    const result = await tool.execute("rename", { title: "Requested", expected_title: "Provisional", reason: "user_request" });
    assert.deepEqual(result.details, edit === "none"
      ? { renamed: true, title: "Requested" }
      : { renamed: false, reason: "title_changed", title: before });
    assert.equal(store.getSession(session.id)!.title, edit === "none" ? "Requested" : before);
    assert.equal(events.length, edit === "none" ? 1 : 0);
    // A late refinement must not overwrite the completed rename/edit either.
    assert.equal(await store.compareAndSetSessionTitle(session.id, "Provisional", "Late refinement", "refinement"), undefined);
  });
}

test("refinement landing between tool read and CAS still permits the explicit request", async (context) => {
  const root = await mkdtemp(join(process.cwd(), ".tmp/title-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("Title race");
  const session = await store.createSession(project.id, "Provisional", {}, {}, { allowUnconfiguredModel: true });
  const tool = createSessionTitleTool({
    getSession: store.getSession.bind(store),
    async compareAndSetSessionTitle(id, expected, title, source) {
      await store.compareAndSetSessionTitle(id, expected, "Refined", "refinement");
      return store.compareAndSetSessionTitle(id, expected, title, source);
    },
  }, session.id, async () => {});
  const result = await tool.execute("rename", { title: "Requested", expected_title: "Provisional", reason: "user_request" });
  assert.deepEqual(result.details, { renamed: true, title: "Requested" });
});
