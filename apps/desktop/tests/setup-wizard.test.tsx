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

// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import { setLanguage, getLanguage, TEXT } from "../src/text.js";
import { BOOT_CHECK_ITEMS, SetupWizard } from "../src/views/SetupWizard.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

// Static rendering runs no effect and no handler, so nothing in the wizard
// reaches the service; the steps only need the prop to satisfy the type.
const client = {} as unknown as ApiClient;
const noop = () => undefined;

/**
 * The wizard walks three steps in the shell's order. Each step is rendered on
 * its own through `initialStep`, because there is no DOM here to click forward
 * with — the transitions themselves are exercised in the browser E2E journeys.
 */
describe("the first-run setup wizard", () => {
  it("opens on the workspace directory, which is recorded rather than applied", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.workspace.title));
    assert.ok(markup.includes(TEXT.wizard.workspace.sub));
    assert.ok(markup.includes(TEXT.wizard.workspace.label));
    assert.ok(markup.includes(TEXT.wizard.workspace.note));
    assert.ok(markup.includes(TEXT.wizard.workspace.skip));
    assert.ok(markup.includes(TEXT.wizard.workspace.next));
    // The right panel is the same on every step.
    assert.ok(markup.includes(TEXT.wizard.art.title));
    assert.ok(markup.includes('data-step="workspace"'));
    // The provider form belongs to the next step, not this one.
    assert.ok(!markup.includes(TEXT.wizard.testAndContinue));
  });

  it("keeps the shell's environment check as its own step", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        initialStep="boot"
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.boot.title));
    assert.ok(markup.includes(TEXT.wizard.boot.starting));
    assert.ok(markup.includes(TEXT.wizard.boot.hint));
    assert.ok(markup.includes('data-step="boot"'));
    // 返回上一步 is the only way back, and the form belongs to the step after
    // this one.
    assert.ok(markup.includes(TEXT.wizard.back));
    assert.ok(!markup.includes(TEXT.wizard.testAndContinue));
  });

  it("[U5c] lists the environment check WITHOUT the Seatbelt row", () => {
    // Static rendering runs no effect, so the list itself only appears after
    // the starting phase; the items registry still drives what CAN appear.
    // [U5c, owner decision 2026-11-23] The Seatbelt row is retired with the
    // gate: the boot neither blocks nor mentions the sandbox, and 设置 ›
    // 通用's status row is the one surface for sandbox health. The wizard's
    // list is the backend stack alone.
    // Review: pin the RENDER source (BOOT_CHECK_ITEMS drives the list the
    // component maps over), not the TEXT registry's key order.
    assert.deepEqual([...BOOT_CHECK_ITEMS], ["api", "runner", "model"],
      "U5c: the Seatbelt row is gone; api/runner/model remain");
    // zh + en both define every rendered row (the shell renders whichever
    // locale the SPA loaded; a missing key would render "undefined" in one
    // language).
    const original = getLanguage();
    for (const lang of ["zh-CN", "en"] as const) {
      setLanguage(lang);
      for (const key of BOOT_CHECK_ITEMS) {
        assert.ok(TEXT.wizard.boot.items[key], `missing TEXT.wizard.boot.items.${key} in ${lang}`);
      }
    }
    setLanguage(original);
  });

  it("[U5c] the wizard copy carries no Seatbelt banner keys anymore", () => {
    // The ready-page banner and its copy are retired with the gate (owner
    // decision 2026-11-23: 初始化不拦截不提示，沙箱监测只在设置). The keys
    // must NOT come back: a settings-only posture with a wizard banner is a
    // contradiction the next reader would have to unwind.
    const original = getLanguage();
    for (const lang of ["zh-CN", "en"] as const) {
      setLanguage(lang);
      const boot = TEXT.wizard.boot as Record<string, unknown>;
      for (const gone of ["seatbeltOptInTitle", "seatbeltFailedTitle", "seatbeltRetryHint", "seatbeltNotApplicable"]) {
        assert.equal(boot[gone], undefined, `${gone} must stay retired in ${lang}`);
      }
      assert.equal((boot.items as Record<string, unknown>).seatbelt, undefined,
        `items.seatbelt must stay retired in ${lang}`);
    }
    setLanguage(original);
  });

  it("[U5c] pins the sandbox status row's copy — the settings-only surface", () => {
    // The settings row is now the ONE place sandbox health is shown, so its
    // copy is the contract. [F16] The row derives from the switch AND the
    // probe: ok/failed speak only when the switch is OFF; optedOut is the
    // honest line when it is ON, and it names the switch (not
    // "restore + restart") as the way back. [F14] notApplicable is gone —
    // the IPC normalizes non-darwin verdicts to null.
    const original = getLanguage();
    for (const lang of ["zh-CN", "en"] as const) {
      setLanguage(lang);
      const status = TEXT.settings.network.sandbox.status;
      assert.ok(status.field, `missing sandboxStatus.field in ${lang}`);
      assert.ok(status.ok, `missing sandboxStatus.ok in ${lang}`);
      assert.ok(status.failed, `missing sandboxStatus.failed in ${lang}`);
      assert.ok(status.optedOut, `missing sandboxStatus.optedOut in ${lang}`);
      assert.ok(status.optedOutSwitchOff, `missing sandboxStatus.optedOutSwitchOff in ${lang}`);
      assert.ok(status.attached, `missing sandboxStatus.attached in ${lang}`);
      assert.ok(status.failCause["spawn-error"], `missing failCause.spawn-error in ${lang}`);
      assert.ok(status.failCause.signal, `missing failCause.signal in ${lang}`);
      assert.ok(status.failCause["exit-code"], `missing failCause.exit-code in ${lang}`);
    }
    setLanguage("zh-CN");
    assert.ok(TEXT.settings.network.sandbox.status.failed.includes("无沙箱"),
      "the failed line names the mode the session is in");
    assert.ok(TEXT.settings.network.sandbox.status.failed.includes("单独确认"),
      "the failed line keeps the per-run confirmation promise");
    assert.ok(TEXT.settings.network.sandbox.status.optedOut.includes("开关"),
      "the opted-out line names the switch as the way back");
    assert.ok(TEXT.settings.network.sandbox.status.optedOut.includes("重启"),
      "the opted-out line says a restart applies the change");
    setLanguage("en");
    assert.ok(TEXT.settings.network.sandbox.status.failed.includes("unsandboxed"),
      "the English failed line names the mode");
    assert.ok(TEXT.settings.network.sandbox.status.failed.includes("confirm"),
      "the English failed line keeps the per-run confirmation promise");
    assert.ok(TEXT.settings.network.sandbox.status.optedOut.includes("switch"),
      "the English opted-out line names the switch");
    setLanguage(original);
  });

  it("[U5c] pins the settings hint's full blast radius (review 2026-11-23)", () => {
    // The reviewers' ask: the copy must state what the switch actually does
    // — the runner-wide provider takes the Agent's own ephemeral Shell/
    // Python out of the sandbox too, persistent sessions/kernels need a
    // sandbox so they are unavailable, and R execution is refused outright
    // by the direct channel (executor: "supports Python only" — review
    // F17). Never narrowed to "candidates only".
    // [hint-split] The lead sentence and the blast radius are two text
    // fields now (hint + hintDetails); the red line is asserted over the
    // COMBINED text, so a future edit cannot quietly drop a point by
    // moving it out of the lead sentence. `direct` is re-read AFTER each
    // setLanguage: TEXT is a per-access proxy over the active dictionary,
    // so a single const captured up here would pin one language's object
    // and the second block would assert the wrong dictionary.
    const combined = (fields: { hint: string; hintDetails: string[] }) => [fields.hint, ...fields.hintDetails].join("\n");
    const original = getLanguage();
    setLanguage("zh-CN");
    const zhDirect = TEXT.settings.network.sandbox.directExecution;
    const zhHint = combined(zhDirect);
    assert.ok(zhHint.includes("Shell"), "the hint mentions the Agent's Shell execution");
    assert.ok(zhHint.includes("持久"), "the hint mentions the persistent sessions/kernels cost");
    assert.ok(zhHint.includes("R 语言执行"), "the hint mentions the R execution cost (F17)");
    assert.ok(zhHint.includes("单独确认"), "the hint keeps the per-run confirmation promise");
    assert.ok(zhHint.includes("重启应用后生效"), "the hint keeps the restart-applies clause");
    assert.ok(zhDirect.showDetails && zhDirect.hideDetails, "the details block carries both toggle labels");
    setLanguage("en");
    const enDirect = TEXT.settings.network.sandbox.directExecution;
    const enHint = combined(enDirect);
    assert.ok(enHint.includes("Shell"), "the English hint mentions the Agent's Shell execution");
    assert.ok(enHint.includes("persistent"), "the English hint mentions the persistent sessions/kernels cost");
    assert.ok(enHint.includes("R execution"), "the English hint mentions the R execution cost (F17)");
    assert.ok(enHint.includes("confirm"), "the English hint keeps the per-run confirmation promise");
    assert.ok(enHint.includes("Applies after a restart"), "the English hint keeps the restart-applies clause");
    assert.ok(enDirect.showDetails && enDirect.hideDetails, "the details block carries both toggle labels");
    setLanguage(original);
  });

  it("is a model step whose final action waits for a successful test", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        initialStep="model"
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.title));
    assert.ok(markup.includes(TEXT.wizard.sub));
    assert.ok(markup.includes(TEXT.wizard.art.title));
    assert.ok(markup.includes(TEXT.wizard.testAndContinue));
    assert.ok(markup.includes('data-step="model"'));
    assert.ok(markup.includes(TEXT.wizard.back));
    // 返回上一步 belongs to the action row, in the demoted group ahead of the
    // continue button — not on a line of its own below the form.
    const actions = markup.slice(markup.indexOf('class="form-actions"'));
    assert.ok(actions.indexOf(TEXT.wizard.back) < actions.indexOf(TEXT.wizard.testAndContinue));
    assert.ok(actions.indexOf(TEXT.wizard.back) < actions.indexOf("</div>"));
    // 开始使用 is the continuation, not a second save: it must stay hidden until
    // the connectivity test in this form passes.
    assert.ok(!markup.includes(`>${TEXT.wizard.finish}</button>`));
  });
});
