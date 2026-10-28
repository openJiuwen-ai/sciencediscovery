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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConfirmRequest, Toast } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { ConfirmDialog } from "../src/views/ConfirmDialog.js";
import { PromptDialog } from "../src/views/PromptDialog.js";
import { Toasts } from "../src/views/Toasts.js";

const noop = () => {};

describe("toasts", () => {
  it("draws nothing when there is nothing to say", () => {
    assert.equal(renderToStaticMarkup(<Toasts onDismiss={noop} toasts={[]} />), "");
  });

  it("keeps the order it was given and marks the tone on each row", () => {
    const toasts: Toast[] = [
      { id: 1, message: "上传成功", tone: "info" },
      { id: 2, message: "上传失败", tone: "error" },
    ];
    const markup = renderToStaticMarkup(<Toasts onDismiss={noop} toasts={toasts} />);

    assert.ok(markup.includes("上传成功"));
    assert.ok(markup.includes("上传失败"));
    assert.ok(markup.indexOf("上传成功") < markup.indexOf("上传失败"));
    assert.ok(markup.includes("toast-info"));
    assert.ok(markup.includes("toast-error"));
    // Each row can be dismissed on its own, not just collectively.
    assert.equal(markup.split(`aria-label="${TEXT.menu.cancel}"`).length - 1, 2);
  });
});

describe("the confirmation dialog", () => {
  const request: ConfirmRequest = {
    accept: TEXT.menu.delete,
    body: "删除后无法恢复，工作区里的文件也会一起删除。",
    onAccept: noop,
    title: "删除会话？",
  };

  it("prints the consequence, not a bare are-you-sure", () => {
    const markup = renderToStaticMarkup(<ConfirmDialog onDismiss={noop} request={request} />);

    assert.match(markup, /role="dialog"/);
    assert.ok(markup.includes("删除会话？"));
    assert.ok(markup.includes("删除后无法恢复"));
    assert.ok(markup.includes(request.accept));
    // Both the footer and the close button cancel the same way.
    assert.ok(markup.split(TEXT.menu.cancel).length - 1 >= 2);
    assert.ok(markup.includes(TEXT.menu.confirm));
  });

  it("lets a caller name the eyebrow", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        onDismiss={noop}
        request={{ ...request, eyebrow: "归档" }}
      />,
    );

    assert.ok(markup.includes("归档"));
    assert.ok(!markup.includes(`>${TEXT.menu.confirm}</span>`));
  });
});

describe("the one-field prompt", () => {
  it("starts from the current value and can be submitted", () => {
    const markup = renderToStaticMarkup(
      <PromptDialog
        accept={TEXT.menu.confirm}
        eyebrow={TEXT.menu.rename}
        fieldLabel={TEXT.sessionBar.sessionTitle}
        onCancel={noop}
        onSubmit={noop}
        title={TEXT.menu.rename}
        value="旧名字"
      />,
    );

    assert.match(markup, /role="dialog"/);
    assert.ok(markup.includes('value="旧名字"'));
    assert.ok(markup.includes(TEXT.sessionBar.sessionTitle));
    assert.doesNotMatch(markup, /disabled=""/);
  });

  it("refuses an empty name and shows the placeholder", () => {
    const markup = renderToStaticMarkup(
      <PromptDialog
        accept={TEXT.menu.confirm}
        eyebrow={TEXT.menu.rename}
        fieldLabel={TEXT.sessionBar.sessionTitle}
        onCancel={noop}
        onSubmit={noop}
        placeholder="给会话起个名字"
        title={TEXT.menu.rename}
      />,
    );

    assert.ok(markup.includes('value=""'));
    assert.ok(markup.includes('placeholder="给会话起个名字"'));
    assert.match(markup, /disabled=""/);
  });
});
