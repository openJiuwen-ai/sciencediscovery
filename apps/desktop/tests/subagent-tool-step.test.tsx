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
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES, ToolOutputGuard } from "@sciencediscovery/tools";
import type { SubagentStep } from "../src/api/types.js";
import { subagentToolStepView } from "../src/app/subagent-tool-step.js";
import { setLanguage, TEXT } from "../src/text.js";
import { StepBody } from "../src/views/SubagentDetail.js";

const { afterEach, describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

// The language is module state: every test leaves it in the default one for the
// next test, and for the other files the runner may load after.
afterEach(() => setLanguage("zh-CN"));

/** The step from the issue's minimal reproduction: a completed `run_shell`
 *  whose captured progress repeats its stdout, carrying the audit details the
 *  desktop panel used to print as ordinary output. */
function shellStep(overrides: Partial<SubagentStep> = {}): SubagentStep {
  return {
    content: [
      '{"executionId":"shell:example","state":"completed","exitCode":0,"createdFiles":["outputs/literature_sources.json"],"modifiedFiles":[],"recovery":{"schemaVersion":1,"capability":"unknown","reason":"NOT_REPORTED"}}',
      "stdout:",
      "batch1 written",
      "stderr:",
    ].join("\n"),
    createdAt: "2026-11-26T05:00:00.000Z",
    details: {
      agentId: "subagent:example",
      executionId: "shell:example",
      finishedAt: "2026-11-26T05:00:01.000Z",
      runnerId: "local",
      startedAt: "2026-11-26T05:00:00.000Z",
      state: "completed",
      stderr: "[omitted]",
      stdout: "[omitted]",
      workspaceId: "ws_example",
      __detailsBoundary: { omittedPayloadFields: true, truncated: false },
    },
    id: "tool-shell",
    kind: "tool",
    progress: "batch1 written\n",
    status: "completed",
    toolName: "run_shell",
    ...overrides,
  };
}

/** Everything the ordinary output draws, as one searchable string. */
function ordinaryOutput(step: SubagentStep): string {
  const view = subagentToolStepView(step);
  return JSON.stringify({ actionable: view.actionable, output: view.output, summary: view.summary });
}

const AUDIT_MARKERS = [
  "executionId",
  "agentId",
  "runnerId",
  "workspaceId",
  "startedAt",
  "finishedAt",
  "[omitted]",
  "__detailsBoundary",
];

/** The head slice `headTailPreview` keeps for a tail-preview tool: the guard
 *  spends 65% of its byte budget on the tail and the rest on the head. */
const GUARD_HEAD_BYTES = DEFAULT_TOOL_OUTPUT_MAX_BYTES - Math.floor(DEFAULT_TOOL_OUTPUT_MAX_BYTES * 0.65);

/**
 * A `run_shell` metadata line exactly one byte longer than the guard's head
 * slice, ending with the close of `recovery` and then the object's own close.
 * Cutting it at the head budget drops only the outer `}`, so the fragment ends
 * with a brace and still is not JSON — the case that used to leak.
 */
function guardedMetadata(): string {
  const target = GUARD_HEAD_BYTES + 1;
  const render = (files: string[]) => JSON.stringify({
    createdFiles: ["outputs/literature_sources.json"],
    executionId: "shell:1431",
    exitCode: 0,
    modifiedFiles: files,
    state: "completed",
    // The envelope's last key, as the model view writes it: the cut then lands
    // on the recovery object's own close.
    recovery: { capability: "unknown", reason: "NOT_REPORTED", schemaVersion: 1 },
  });
  const files = Array.from({ length: 200 }, (_, index) => `outputs/modified-${index}.txt`);
  // The last entry is the one shortened to land exactly on the target size.
  files[files.length - 1] = `outputs/pad-${"y".repeat(60)}.txt`;
  let text = render(files);
  while (text.length < target) {
    files.splice(files.length - 1, 0, `outputs/extra-${files.length}.txt`);
    text = render(files);
  }
  const overshoot = text.length - target;
  if (overshoot > 0) {
    const last = files[files.length - 1]!;
    files[files.length - 1] = last.slice(0, last.length - overshoot);
    text = render(files);
  }
  assert.equal(text.length, target, "the metadata line is exactly one byte over the head slice");
  return text;
}

/** One guarded `run_shell` result whose metadata line was cut on a nested `}`. */
async function guardedShellResult(): Promise<{ content: string; fragment: string; printed: string }> {
  const metadata = guardedMetadata();
  const printed = '{"state":"completed","exitCode":7}';
  const stdout = Array.from({ length: 3000 }, (_, index) => `stdout line ${index}`);
  stdout[stdout.length - 1] = printed;
  const guard = new ToolOutputGuard({
    sink: {
      save: async (toolName, text) => ({
        bytes: new TextEncoder().encode(text).length,
        lines: text.split("\n").length,
        ref: "tool-output:1431",
        toolName,
      }),
    },
  });
  const content = await guard.apply("run_shell", [metadata, "stdout:", ...stdout, "stderr:", "warning"].join("\n"));
  return { content, fragment: metadata.slice(0, GUARD_HEAD_BYTES), printed };
}

describe("a tool step's ordinary output", () => {
  it("keeps the audit record out of the output and inside the audit block", () => {
    const view = subagentToolStepView(shellStep());
    const output = ordinaryOutput(shellStep());
    for (const marker of AUDIT_MARKERS) {
      assert.equal(output.includes(marker), false, `${marker} must not be ordinary output`);
    }
    // ...and nothing was dropped: both record parts are still there, verbatim.
    const audit = view.audit.map((entry) => JSON.stringify(entry.value)).join("\n");
    for (const marker of AUDIT_MARKERS) {
      assert.equal(audit.includes(marker), true, `${marker} must remain in the audit block`);
    }
    assert.deepEqual(view.audit.map((entry) => entry.id), ["result", "details"]);
    assert.deepEqual(view.audit[1]!.value, shellStep().details);
  });

  it("splits the command's labelled streams instead of printing one blob", () => {
    const view = subagentToolStepView(shellStep());
    assert.deepEqual(view.output, [{ content: "batch1 written", id: "stdout", label: "stdout" }]);
    // An empty `stderr:` is a placeholder the parser drops, so progress can no
    // longer sit under a `stderr:` label it does not belong to.
    assert.equal(view.output.some((section) => section.id === "stderr"), false);
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
  });

  it("names the exit code in the reader's language", () => {
    setLanguage("en");
    assert.equal(subagentToolStepView(shellStep()).summary, "Completed · exit 0");
    setLanguage("zh-CN");
    assert.equal(subagentToolStepView(shellStep()).summary, `已完成 · 退出码 0`);
  });

  it("names each execution state in the reader's language", () => {
    const summary = (state: string) => subagentToolStepView(shellStep({
      content: JSON.stringify({ executionId: "shell:example", state }),
      details: undefined,
      progress: undefined,
    })).summary;
    setLanguage("en");
    assert.deepEqual(["completed", "unknown", "queued"].map(summary), ["Completed", "Unknown", "Queued"]);
    setLanguage("zh-CN");
    assert.deepEqual(["completed", "unknown", "queued"].map(summary), ["已完成", "状态未知", "排队中"]);
  });

  it("names a non-committed finalization in the reader's language", () => {
    const summary = (finalization: string) => subagentToolStepView(shellStep({
      content: '{"executionId":"shell:example","state":"completed","exitCode":0}',
      details: { state: "completed", exitCode: 0, finalization },
      progress: undefined,
    })).summary;
    setLanguage("en");
    assert.equal(summary("pending"), "Completed · exit 0 · finalization pending");
    assert.equal(summary("committed"), "Completed · exit 0");
    setLanguage("zh-CN");
    assert.equal(summary("pending"), "已完成 · 退出码 0 · 收尾中");
    assert.equal(summary("failed"), "已完成 · 退出码 0 · 收尾失败");
  });

  it("keeps a bounded result readable: the notice stays, the envelope does not", () => {
    // What ToolOutputGuard produces for a 3000-line stdout: its bounded-preview
    // notice comes before the envelope, so the envelope is no longer the whole
    // result and must still be found — while the notice stays visible.
    const stdout = [
      ...Array.from({ length: 700 }, (_, index) => `head-${index}`),
      "[... middle omitted; full result available by ref ...]",
      ...Array.from({ length: 1300 }, (_, index) => `tail-${index}`),
    ];
    const step = shellStep({
      content: [
        "[bounded tool output] run_shell produced 3004 lines (58.2 KB). This result shows a bounded head/tail preview (41.7 KB); the middle is omitted here.",
        'The full output is stored as ref "tool-output:1431" (3004 lines, 58.2 KB). Read any part of it with read_tool_output(ref="tool-output:1431", offset=<1-based line>, limit=<lines>).',
        '{"executionId":"shell:1431","state":"completed","exitCode":0}',
        "stdout:",
        ...stdout,
        "stderr:",
      ].join("\n"),
      details: undefined,
      progress: undefined,
    });
    const view = subagentToolStepView(step);
    const output = ordinaryOutput(step);
    assert.equal(output.includes("executionId"), false, "the envelope is not ordinary output");
    assert.match(output, /\[bounded tool output\] run_shell produced 3004 lines/);
    assert.match(output, /read_tool_output\(ref=/);
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
    assert.match(view.output.find((section) => section.id === "stdout")!.content, /tail-1299/);
    // The envelope itself is preserved in the audit block.
    assert.deepEqual(view.audit.map((entry) => entry.id), ["result"]);
  });

  it("does not read the envelope into a stdout line when the bound cut it open", () => {
    // The output guard keeps a head slice and a tail slice. A run_shell
    // metadata line can be long enough (createdFiles/modifiedFiles) that the
    // head budget ends inside it, so the line reaches the panel as an open
    // fragment — and the stdout the command printed may itself be JSON shaped
    // like the envelope. Only the first object line may be the header.
    const metadata = JSON.stringify({
      executionId: "shell:1431",
      state: "completed",
      exitCode: 0,
      createdFiles: Array.from({ length: 200 }, (_, index) => `outputs/generated-${index}-${"x".repeat(40)}.json`),
      modifiedFiles: [],
    });
    const fragment = metadata.slice(0, 320);
    assert.equal(fragment.endsWith("}"), false);
    const printed = '{"state":"completed","exitCode":7}';
    const step = shellStep({
      content: [
        "[bounded tool output] run_shell produced 3004 lines (58.2 KB). This result shows a bounded head/tail preview (41.7 KB); the middle is omitted here.",
        'The full output is stored as ref "tool-output:1431" (3004 lines, 58.2 KB). Read any part of it with read_tool_output(ref="tool-output:1431", offset=<1-based line>, limit=<lines>).',
        fragment,
        "[... middle omitted; full result available by ref ...]",
        "tail stdout line",
        printed,
        "stderr:",
      ].join("\n"),
      details: {
        executionId: "shell:1431",
        exitCode: 0,
        modifiedFiles: [],
        recovery: { capability: "unknown", reason: "NOT_REPORTED", schemaVersion: 1 },
        state: "completed",
        stderr: "[omitted]",
        stdout: "[omitted]",
      },
      progress: undefined,
    });
    const view = subagentToolStepView(step);
    const output = ordinaryOutput(step);
    assert.equal(output.includes("executionId"), false, "the cut metadata fragment must not reach the output");
    assert.match(output, /\[bounded tool output\] run_shell produced 3004 lines/);
    assert.equal(view.output.some((section) => section.content.includes("tail stdout line")), true);
    assert.equal(view.output.some((section) => section.content.includes(printed)), true,
      "a JSON line the command printed is stdout, not the header");
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
    assert.equal(view.summary!.includes("7"), false, "the printed exit code 7 is not the run's status");
    // The cut line is kept as an audit record, not silently discarded.
    assert.deepEqual(view.audit.map((entry) => entry.id), ["result", "details"]);
    assert.equal(view.audit[0]!.value, fragment);
  });

  it("keeps the fragment a real guard cut on a nested brace out of the output", async () => {
    // The real output guard, not a hand-shaped imitation: its head slice can
    // end exactly on the `}` that closes `recovery`, so the fragment ends with
    // a brace yet is unbalanced JSON. It is still audit metadata.
    const { content, fragment, printed } = await guardedShellResult();
    assert.equal(fragment.endsWith("}"), true);
    assert.throws(() => JSON.parse(fragment));
    assert.equal(content.includes(fragment), true, "the guard preview carries the cut line");
    assert.equal(content.includes(printed), true);
    assert.match(content, /^\[bounded tool output\] run_shell/);
    const step = shellStep({
      content,
      details: {
        executionId: "shell:1431",
        exitCode: 0,
        modifiedFiles: [],
        recovery: { capability: "unknown", reason: "NOT_REPORTED", schemaVersion: 1 },
        state: "completed",
        stderr: "[omitted]",
        stdout: "[omitted]",
      },
      progress: undefined,
    });
    const view = subagentToolStepView(step);
    const output = ordinaryOutput(step);
    assert.equal(output.includes("executionId"), false, "the cut metadata line must not reach the output");
    assert.match(output, /\[bounded tool output\] run_shell produced/);
    assert.equal(view.output.some((section) => section.content.includes(printed)), true,
      "the JSON line the command printed stays in stdout");
    assert.equal(view.output.some((section) => section.content.includes("stdout line 2998")), true);
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
    assert.equal(view.summary!.includes("7"), false, "the printed exit code 7 is not the run's status");
    assert.deepEqual(view.audit.map((entry) => entry.id), ["result", "details"]);
    assert.equal(view.audit[0]!.value, fragment);
  });

  it("takes the completion line from the audit copy when the result lost the envelope", () => {    const view = subagentToolStepView(shellStep({
      content: "Tool completed",
      details: {
        executionId: "shell:example",
        exitCode: 0,
        state: "completed",
        stderr: "[omitted]",
        stdout: "[omitted]",
      },
      progress: undefined,
    }));
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
    assert.deepEqual(view.output, [{ content: "Tool completed", id: "result", label: TEXT.conversation.toolOutput }]);
  });

  it("folds the issue's minimal envelope, which names no execution id", () => {
    const step = shellStep({
      content: '{"state":"completed","exitCode":0}\nstdout:\nbatch1 written\nstderr:',
      details: undefined,
      progress: undefined,
    });
    const view = subagentToolStepView(step);
    assert.deepEqual(view.output, [{ content: "batch1 written", id: "stdout", label: "stdout" }]);
    assert.deepEqual(view.audit, [{
      id: "result",
      label: TEXT.subagent.auditResult,
      value: { state: "completed", exitCode: 0 },
    }]);
    assert.equal(view.summary, `${TEXT.subagent.status.completed} · ${TEXT.subagent.exitCode(0)}`);
  });

  it("does not repeat the streamed line a finished result already carries", () => {
    assert.equal(subagentToolStepView(shellStep()).progress, undefined);
  });

  it("keeps progress while the step is running", () => {
    const view = subagentToolStepView(shellStep({
      content: "stdout:\nbatch1 written\nstderr:",
      details: undefined,
      status: "running",
    }));
    assert.equal(view.progress, "batch1 written");
  });

  it("keeps the only record when the result carries no command output", () => {
    const view = subagentToolStepView(shellStep({
      content: "Tool completed",
      details: undefined,
      progress: "batch1 written\n",
    }));
    assert.equal(view.progress, "batch1 written");
    assert.deepEqual(view.output, [{ content: "Tool completed", id: "result", label: TEXT.conversation.toolOutput }]);

    const failed = subagentToolStepView(shellStep({
      content: "Tool failed",
      details: undefined,
      progress: "segmentation fault\n",
      status: "failed",
    }));
    assert.equal(failed.progress, "segmentation fault");
  });

  it("keeps progress the result does not contain", () => {
    const view = subagentToolStepView(shellStep({
      content: "5 papers",
      details: undefined,
      progress: "Error: retrying\n",
    }));
    assert.equal(view.progress, "Error: retrying");
  });

  it("leaves a result that is not an execution envelope alone", () => {
    const content = '{"records":[{"title":"A"}],"total":1}';
    const view = subagentToolStepView(shellStep({ content, details: undefined, progress: undefined }));
    assert.deepEqual(view.output, [{ content, id: "result", label: TEXT.conversation.toolOutput }]);
    assert.deepEqual(view.audit, []);
    assert.equal(view.summary, undefined);
  });

  it("leaves another tool's JSON result alone even when it names an execution", () => {
    // `timer_create` returns a timer carrying `executionId` and
    // `state: "pending"` as its own result; folding it would hide the result
    // and claim a completion that never happened.
    const timer = {
      agentId: "subagent:example",
      dueAt: 1_764_000_000_000,
      executionId: "shell:1431",
      id: "timer-1",
      message: "check the result",
      sessionId: "session-1",
      state: "pending",
    };
    const content = JSON.stringify(timer);
    const view = subagentToolStepView(shellStep({
      content,
      details: timer,
      progress: undefined,
      toolName: "timer_create",
    }));
    assert.deepEqual(view.output, [{ content, id: "result", label: TEXT.conversation.toolOutput }]);
    assert.deepEqual(view.audit.map((entry) => entry.id), ["details"]);
    assert.equal(view.summary, undefined);
    assert.match(view.output[0]!.content, /"executionId":"shell:1431"/);
  });

  it("leaves the execution status view as the result a reader asked for", () => {
    // `execution_status` returns the identifiers together with the fields that
    // make the status actionable (diagnostic, network permission, artifacts).
    const statusView = {
      diagnostic: { code: "NOT_FOUND", command: "missing", instruction: "Define the command first." },
      executionId: "shell:1431",
      exitCode: 0,
      modifiedFiles: [],
      networkPermission: { hosts: ["pypi.org"], instruction: "Request network access.", state: "denied" },
      producedArtifacts: [],
      state: "completed",
    };
    const status = JSON.stringify(statusView);
    const view = subagentToolStepView(shellStep({
      content: status,
      details: statusView,
      progress: undefined,
      toolName: "execution_status",
    }));
    assert.deepEqual(view.output, [{ content: status, id: "result", label: TEXT.conversation.toolOutput }]);
    assert.deepEqual(view.audit.map((entry) => entry.id), ["details"]);
    assert.equal(view.summary, undefined);
  });
});

describe("a tool step's actionable fields", () => {
  it("lifts the fields a reader can act on out of the audit record", () => {
    const view = subagentToolStepView(shellStep({
      details: {
        createdFiles: ["outputs/literature_sources.json"],
        error: "Sandbox network access denied",
        instruction: "Use execution_status to re-synchronize the same ID.",
        networkDeniedHosts: ["pypi.org:443"],
        recovery: { schemaVersion: 1, capability: "supported", reason: "MANIFEST_PUBLISHED" },
      },
    }));
    assert.deepEqual(view.actionable, [
      { content: "Use execution_status to re-synchronize the same ID.", id: "instruction", label: TEXT.subagent.fieldInstruction },
      { content: "Sandbox network access denied", id: "error", label: TEXT.conversation.toolError },
      { content: "pypi.org:443", id: "networkDeniedHosts", label: TEXT.subagent.fieldNetworkDeniedHosts },
      { content: "outputs/literature_sources.json", id: "createdFiles", label: TEXT.subagent.fieldCreatedFiles },
      { content: JSON.stringify({ schemaVersion: 1, capability: "supported", reason: "MANIFEST_PUBLISHED" }), id: "recovery", label: TEXT.subagent.fieldRecovery },
    ]);
  });

  it("drops default recovery and empty bookkeeping lists", () => {
    const view = subagentToolStepView(shellStep({
      content: '{"executionId":"shell:example","state":"completed","exitCode":0,"createdFiles":[],"modifiedFiles":[],"networkDeniedHosts":[],"recovery":{"schemaVersion":1,"capability":"unknown","reason":"NOT_REPORTED"}}',
      details: {
        createdFiles: [],
        modifiedFiles: [],
        recovery: { schemaVersion: 1, capability: "unknown", reason: "NOT_REPORTED" },
      },
    }));
    assert.deepEqual(view.actionable, []);
  });

  it("keeps an unknown recovery that names a real reason", () => {
    const view = subagentToolStepView(shellStep({
      content: "",
      details: { recovery: { schemaVersion: 1, capability: "unknown", reason: "SIDECAR_UNREADABLE" } },
    }));
    assert.deepEqual(view.actionable.map((field) => field.id), ["recovery"]);
  });

  it("does not print a created-files list the output already labels", () => {
    const view = subagentToolStepView(shellStep({
      content: "stdout:\nwritten\ncreated files:\noutputs/a.json",
      details: { createdFiles: ["outputs/a.json"] },
      progress: undefined,
    }));
    assert.deepEqual(view.output.map((section) => section.id), ["stdout", "created-files"]);
    assert.equal(view.actionable.some((field) => field.id === "createdFiles"), false);
  });
});

describe("the step body's markup", () => {
  function html(step: SubagentStep): string {
    return renderToStaticMarkup(<StepBody step={step} />);
  }

  it("draws audit metadata only inside the folded audit block", () => {
    const markup = html(shellStep());
    const auditStart = markup.indexOf('class="subagent-step-audit"');
    assert.notEqual(auditStart, -1, "the complete record needs a fold");
    const ordinary = markup.slice(0, auditStart);
    for (const marker of AUDIT_MARKERS) {
      assert.equal(ordinary.includes(marker), false, `${marker} leaked into the ordinary output`);
    }
    // The block starts closed; opening it is the reader's choice.
    assert.match(markup, /<details class="subagent-step-audit">/);
    assert.match(markup, /审计信息/);
  });

  it("labels the streams and shows the streamed line once", () => {
    const markup = html(shellStep());
    assert.match(markup, /class="subagent-output-label">stdout</);
    assert.equal((markup.match(/batch1 written/g) ?? []).length, 1);
    assert.equal(markup.includes(TEXT.subagent.progress), false, "progress is not repeated after the result");
    assert.match(markup, /outputs\/literature_sources\.json/);
    assert.equal(markup.includes("NOT_REPORTED"), false, "the default recovery is not shown");
  });

  it("gives progress its own heading instead of following stderr", () => {
    const markup = html(shellStep({
      content: "Tool completed",
      details: undefined,
      progress: "batch1 written\n",
    }));
    const progressStart = markup.indexOf(TEXT.subagent.progress);
    assert.notEqual(progressStart, -1);
    assert.equal(markup.slice(0, progressStart).includes("stderr"), false);
  });
});
