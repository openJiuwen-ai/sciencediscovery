// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer, SessionSettingsMenu } from "../src/views/Composer.js";

/** The dropdown only exists while open, and a static render never runs effects,
 *  so these cover the closed state: the triggers themselves. */
function render(running = false, options: { blocked?: string; limit?: string; uploading?: boolean } = {}): string {
  return renderToStaticMarkup(
    <Composer
      attachBlocked={options.blocked}
      attachLimit={options.limit}
      models={[{ id: "m1", name: "测试模型" } as never]}
      onApprovalMode={() => {}}
      onOpenSettings={() => {}}
      onOpenSpecialists={() => {}}
      onSelectModel={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      onUpload={() => {}}
      running={running}
      selectedModelId="m1"
      uploading={options.uploading ?? false}
    />,
  );
}

/** 会话设置's rows are rendered directly, since the menu they belong to is
 *  only mounted while open. */
function settingsMenu(approvalMode?: "ask_for_dangerous" | "always_allow", running = false): string {
  return renderToStaticMarkup(
    <SessionSettingsMenu
      approvalMode={approvalMode}
      onApprovalMode={() => {}}
      onClose={() => {}}
      onOpenSpecialists={() => {}}
      running={running}
    />,
  );
}

test("the composer offers the model pill, upload and session settings", () => {
  const markup = render();
  assert.match(markup, /class="composer-model-pill"/);
  assert.match(markup, /aria-label="上传文件"/);
  assert.match(markup, /aria-label="会话设置"/);
  // The approval pill moved into 会话设置; a second copy in the footer would
  // give the same choice two homes.
  assert.doesNotMatch(markup, /composer-permission-pill/);
  assert.doesNotMatch(markup, /class="composer-options"/);
});

test("the plus uploads and states the per-file ceiling in its tooltip", () => {
  const markup = render(false, { limit: "1 GiB" });
  assert.match(markup, /单个文件最大 1 GiB/);
});

test("a blocked upload disables the plus and gives the reason on it", () => {
  const markup = render(false, { blocked: "这个会话已经归档，不能再写入。取消归档后才能上传。" });
  assert.match(
    markup,
    /<button[^>]*disabled=""[^>]*title="这个会话已经归档，不能再写入。取消归档后才能上传。"/,
  );
});

test("an upload in flight replaces the plus with a spinner rather than allowing a second", () => {
  const markup = render(false, { uploading: true });
  assert.match(markup, /<button[^>]*aria-label="上传文件"[^>]*disabled=""/);
  assert.match(markup, /class="spinner"/);
});

test("会话设置 carries 权限模式 and 专家, and nothing under 专家", () => {
  const markup = settingsMenu("ask_for_dangerous");
  assert.match(markup, />权限模式</);
  assert.match(markup, />请求批准</);
  assert.match(markup, />专家</);
  assert.match(markup, />无</);
  // The line the user removed; the row names the section and stops there.
  assert.doesNotMatch(markup, /当前版本没有独立的专家目录/);
  assert.doesNotMatch(markup, /expertsEmpty/);
});

test("the permission row reads the mode the session is in", () => {
  assert.match(settingsMenu("always_allow"), />完全访问</);
  assert.match(settingsMenu("ask_for_dangerous"), />请求批准</);
});

test("permission cannot be switched mid-run", () => {
  assert.match(settingsMenu(undefined, true), /<button[^>]*aria-expanded="false"[^>]*disabled=""/);
});
