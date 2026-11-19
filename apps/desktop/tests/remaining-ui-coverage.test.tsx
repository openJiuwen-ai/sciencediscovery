// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import type { ComposerReference } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { ArtifactDialog } from "../src/views/ArtifactDialog.js";
import { FileBadge } from "../src/views/FileBadge.js";
import { Rail } from "../src/views/Rail.js";
import { SidebarToggle } from "../src/views/SidebarToggle.js";
import { collapseHint } from "../src/views/collapse-hint.js";
import { EvolveGlyph, EvolveTreeGlyph, CrownGlyph, TrophyGlyph, ChildrenGlyph, ExpandGlyph, SearchGlyph } from "../src/views/evolve/glyphs.js";
import { enterDialog, isTopDialog, leaveDialog, claimsEscape } from "../src/views/dialog-escape.js";
import { MemoryCardDialog } from "../src/views/MemoryCardDialog.js";
import { MemoryStatus } from "../src/views/MemoryStatus.js";
import { RunFailureCard } from "../src/views/RunFailureCard.js";
import { SettingsModal } from "../src/views/settings/SettingsModal.js";
import { DirectionInput } from "../src/views/evolve/DirectionInput.js";
import { ToolIoBlock } from "../src/views/ToolIoBlock.js";
import { UploadCards } from "../src/views/UploadCards.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

const client = { request: () => new Promise(() => {}) } as unknown as ApiClient;
const reference: ComposerReference = { id: "artifact-1", kind: "artifact", label: "artifact1" };
const noop = () => {};

function markup(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("desktop component coverage for failure and attachment surfaces", () => {
  it("renders a run failure with user guidance and expandable diagnostics", () => {
    const html = markup(<RunFailureCard code="timeout" message="gateway stalled" />);
    assert.match(html, /run-failure/);
    assert.ok(html.includes(TEXT.runFailure.technicalDetails));
    assert.ok(html.includes("timeout"));
    assert.ok(html.includes("gateway stalled"));
  });

  it("keeps upload cards compact while exposing the remaining files", () => {
    const html = markup(<UploadCards files={[
      { kind: "pdf", name: "paper.pdf", path: "paper.pdf" },
      { kind: "sheet", name: "table.csv", path: "table.csv" },
      { kind: "code", name: "analysis.py", path: "analysis.py" },
    ]} />);
    assert.ok(html.includes('class="upload-cards is-two has-more"'));
    assert.ok(html.includes("paper"));
    assert.ok(html.includes("csv"));
    assert.ok(html.includes(TEXT.conversation.uploads.more(1)));
    assert.ok(html.includes('aria-label="另外 1 个文件"'));
  });

  it("renders tool IO as a keyboard reachable panel link when a handler exists", () => {
    const html = markup(<ToolIoBlock content='{"ok":true}' label="Input" onOpen={noop} />);
    assert.match(html, /role="button"/);
    assert.match(html, /tabindex="0"/);
    assert.ok(html.includes("Input"));
    assert.ok(html.includes("{&quot;ok&quot;:true}"));
  });

  it("renders the memory status line only when memory is enabled", () => {
    assert.equal(markup(<MemoryStatus client={client} enabled={false} />), "");
    const html = markup(<MemoryStatus client={client} enabled />);
    assert.match(html, /class="memory-status is-checking"/);
    assert.match(html, /role="status"/);
  });

  it("keeps attachment badges tied to their file family", () => {
    const html = markup(<FileBadge kind="pdf" />);
    assert.match(html, /class="file-badge"/);
    assert.ok(html.includes("#e02128"));
    assert.ok(html.includes(">A</text>"));
  });

  it("renders the task and settings rail with one active surface", () => {
    const html = markup(<Rail onOpenSettings={noop} onSelectTask={noop} settingsOpen />);
    assert.match(html, /aria-label=/);
    assert.match(html, /data-guide="settings"/);
    assert.ok(html.includes("is-active"));
  });

  it("changes sidebar toggle label with its open state", () => {
    const open = markup(<SidebarToggle onClick={noop} open />);
    const closed = markup(<SidebarToggle onClick={noop} open={false} />);
    assert.match(open, /aria-expanded="true"/);
    assert.match(closed, /aria-expanded="false"/);
    assert.notEqual(open, closed);
  });

  it("exposes localized collapse hints and all evolve glyphs", () => {
    const hint = collapseHint();
    assert.ok(hint["data-collapse"]);
    assert.ok(hint["data-expand"]);
    for (const icon of [<EvolveGlyph />, <EvolveTreeGlyph />, <CrownGlyph />, <TrophyGlyph />, <ChildrenGlyph />, <ExpandGlyph />, <SearchGlyph />]) {
      assert.match(markup(icon), /aria-hidden="true"/);
      assert.match(markup(icon), /<svg/);
    }
  });

  it("orders dialog escape ownership by the most recently opened dialog", () => {
    const first = enterDialog();
    const second = enterDialog();
    assert.equal(isTopDialog(first), false);
    assert.equal(isTopDialog(second), true);
    assert.equal(claimsEscape({ key: "Escape", defaultPrevented: false }), true);
    assert.equal(claimsEscape({ key: "Escape", defaultPrevented: true }), false);
    leaveDialog(second);
    assert.equal(isTopDialog(first), true);
    leaveDialog(first);
  });
});

describe("desktop dialog and editor entry states", () => {
  it("shows the artifact dialog loading contract before API data arrives", () => {
    const html = markup(<ArtifactDialog client={client} onClose={noop} reference={reference} />);
    assert.match(html, /role="dialog"/);
    assert.match(html, /artifact-dialog/);
    assert.ok(html.includes(TEXT.memory.artifactDialog.loading));
    assert.ok(html.includes("溯源"));
  });

  it("shows the memory card loading contract and settings escape hatch", () => {
    const html = markup(<MemoryCardDialog client={client} onClose={noop} onOpenSettings={noop}
      reference={{ id: "evidence-1", kind: "evidence", label: "evidence1" }} />);
    assert.match(html, /role="dialog"/);
    assert.match(html, /memory-dialog/);
    assert.ok(html.includes(TEXT.memory.loading));
    assert.ok(html.includes("正在读取科学记忆"));
  });

  it("keeps settings modal semantics and wide layout observable in markup", () => {
    const html = markup(<SettingsModal label="新增专家" onClose={noop} wide><p>form</p></SettingsModal>);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /settings-modal is-wide/);
    assert.ok(html.includes("新增专家"));
  });

  it("renders the evolve direction empty state and disabled draft action", () => {
    const html = markup(<DirectionInput chinese onChange={noop} />);
    assert.ok(html.includes("参数"));
    assert.ok(html.includes("无法自动生成"));
    assert.match(html, /disabled=""/);
    assert.ok(html.includes("添加参数"));
  });

});

