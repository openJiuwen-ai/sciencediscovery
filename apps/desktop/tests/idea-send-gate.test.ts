// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { defersIdeaSend } from "../src/idea/send-gate.js";
import { composeIdeaMessage, IDEA_TREE_TEAM_COMMAND, ideaCommandOf, ideaTaskOf, isIdeaTreeCommand } from "../src/idea/command.js";

test("the token 会话设置 seeds is the command the rest of the surface knows", () => {
  // The card seeds this token and never sends it, so the token has to be the
  // command the gate defers on, the composer composes and the panel opens for.
  assert.equal(IDEA_TREE_TEAM_COMMAND, "/idea-tree-team");
  assert.equal(isIdeaTreeCommand(IDEA_TREE_TEAM_COMMAND), true);
  // Typed by hand it still opens the card once; the seeded send is the pass that
  // does not come back into it.
  assert.equal(defersIdeaSend(IDEA_TREE_TEAM_COMMAND), true);
});

test("a draft keeps the command it started with, and the task under it", () => {
  // The token carries the command the reader typed: `/idea-tree` stays
  // `/idea-tree`, and the settings row seeds the team variant.
  assert.equal(ideaCommandOf("/idea-tree 分析钙钛矿"), "/idea-tree");
  assert.equal(ideaCommandOf("/idea-tree-team 分析钙钛矿"), "/idea-tree-team");
  assert.equal(ideaCommandOf("分析钙钛矿"), undefined);
  assert.equal(ideaCommandOf("/idea-tree-teams 分析"), undefined);

  assert.equal(ideaTaskOf("/idea-tree-team 研究钙钛矿带隙"), "研究钙钛矿带隙");
  assert.equal(ideaTaskOf("  /idea-tree   compare two catalysts  "), "compare two catalysts");
  assert.equal(ideaTaskOf("compare two catalysts"), "compare two catalysts");
  assert.equal(ideaTaskOf(""), "");
});

test("a draft that is only the command contributes no task", () => {
  // Typing the command and then opening 会话设置 instead of pressing Enter used
  // to send `/idea-tree-team /idea-tree-team …`: the token became its own
  // objective. The task of such a draft is empty.
  assert.equal(ideaTaskOf("/idea-tree-team"), "");
  assert.equal(ideaTaskOf("  /idea-tree  "), "");
  // And what the token sends carries no second command.
  assert.equal(composeIdeaMessage("/idea-tree-team", ideaTaskOf("/idea-tree-team")), "/idea-tree-team");
});

test("the token and the task are one message, and an empty task cannot be sent at all", () => {
  assert.equal(composeIdeaMessage("/idea-tree-team", "研究钙钛矿带隙"), "/idea-tree-team 研究钙钛矿带隙");
  assert.equal(composeIdeaMessage("/idea-tree-team", "  研究钙钛矿带隙  "), "/idea-tree-team 研究钙钛矿带隙");
  // The helper is total — it composes a bare command if it is ever handed an
  // empty task — but the composer never hands it one: the send button and Enter
  // both require a non-empty task (see `composer.test.tsx`), so an empty task
  // never leaves the box. Keeping the helper total is what lets the caller
  // stay a one-liner.
  assert.equal(composeIdeaMessage("/idea-tree-team", ""), "/idea-tree-team");
  assert.equal(composeIdeaMessage("/idea-tree-team", "   "), "/idea-tree-team");
  assert.equal(isIdeaTreeCommand(composeIdeaMessage("/idea-tree-team", "研究钙钛矿带隙")), true);
});

test("an Idea Tree command opens the card before it leaves", () => {
  assert.equal(defersIdeaSend("/idea-tree-team"), true);
  assert.equal(defersIdeaSend("/idea-tree"), true);
  assert.equal(defersIdeaSend("/idea-tree-team 分析钙钛矿带隙"), true);
});

test("every other draft leaves without the card", () => {
  assert.equal(defersIdeaSend("分析一下这个结构"), false);
  // A command that merely starts with the letters is not the command.
  assert.equal(defersIdeaSend("/idea-tree-teams"), false);
  assert.equal(defersIdeaSend("/evolve-design 优化"), false);
});
