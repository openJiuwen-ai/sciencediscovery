// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { collectFinalDelivery } from "./real-delivery.ts";
import { finalReportArtifact, requiredArtifacts } from "./real-delivery.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

function api(status = "completed", text = "[report](/artifact-versions/older/content)", content = "report", httpStatus = 200,
  options: { runs?: any[]; outputs?: any[]; subagents?: any[]; messages?: any[];
    contentByVersion?: Record<string, { content: string; status?: number }> } = {}) {
  const paths: string[] = [];
  const data: Record<string, unknown> = {
    "/api/sessions/s/runs": options.runs ?? [{ id: "r", assistantMessageId: "m", status }],
    "/api/sessions/s": { messages: options.messages ?? [{ id: "m", role: "assistant", content: text }] },
    "/api/sessions/s/subagents": options.subagents ?? [],
    "/api/sessions/s/artifact-outputs": options.outputs ?? [
      { artifact: { id: "a", name: "nested/report.md" }, version: { id: "older", version: 1, turnId: "r" } },
      { artifact: { id: "a", name: "nested/report.md" }, version: { id: "newer", version: 2, turnId: "r" } },
    ],
  };
  const page = { request: { get: async (url: string) => {
    const path = new URL(url).pathname; paths.push(path);
    const versionId = path.match(/\/artifact-versions\/([^/]+)\/content$/)?.[1];
    const version = versionId ? options.contentByVersion?.[versionId] : undefined;
    const responseStatus = version?.status ?? httpStatus;
    return { ok: () => path.endsWith("/content") ? responseStatus === 200 : true, status: () => responseStatus,
      json: async () => data[path], body: async () => Buffer.from(version?.content ?? content) };
  } } };
  return { page: page as never, paths };
}

test("delivery uses the newest declared Session version even when the final reply cites an older one", async () => {
  const fake = api();
  const result = await collectFinalDelivery(fake.page, "s", "r");
  assert.equal(result.status, "passed");
  assert.equal(result.artifacts[0]?.version, "newer");
  assert.ok(fake.paths.some(p => p.includes("newer/content")));
  assert.ok(!fake.paths.some(p => p.includes("older/content")));
});
test("a declared report is delivered even when the final wake reply only acknowledges completion", async () => {
  const fake = api("completed", "Background work finished.");
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "passed");
});
test("missing, empty or unreadable latest output is a failed delivery", async () => {
  const missing = api("completed", "No output", "report", 200, { outputs: [] });
  assert.equal((await collectFinalDelivery(missing.page, "s", "r")).status, "failed");
  for (const [content, status] of [["   ", 200], ["report", 404]] as const) {
    const fake = api("completed", "nested/report.md", content, status);
    const result = await collectFinalDelivery(fake.page, "s", "r");
    assert.equal(result.status, "failed");
    assert.equal(result.errors.length, 1);
  }
});
test("a failed agent with a real final artifact is recorded as partial, never passed", async () => {
  const fake = api("failed");
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "partial");
});

test("a differently named declared report is still a valid delivery", async () => {
  const output = { artifact: { id: "renamed", name: "results-v2.md" },
    version: { id: "renamed-version", version: 1, turnId: "r" } };
  const fake = api("completed", "Done.", "report", 200, { outputs: [output] });
  const result = await collectFinalDelivery(fake.page, "s", "r");
  assert.equal(result.status, "passed");
  assert.equal(result.artifacts[0]?.logicalName, "results-v2.md");
});
test("an acknowledgement-only main wake uses the earlier Run's declared output", async () => {
  const fake = api("completed", "Background work finished.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
  });
  assert.equal((await collectFinalDelivery(fake.page, "s", "wake", "r")).status, "passed");
});
test("an earlier unrelated Run cannot supply the current Run's delivery", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "old", status: "completed", queueOrder: 1 },
      { id: "r", assistantMessageId: "m", status: "completed", queueOrder: 2 }],
    outputs: [{ artifact: { id: "old-artifact", name: "old.md" },
      version: { id: "old-version", version: 1, turnId: "old" } }],
  });
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "failed");
});
test("a child output belongs to its parent main Run", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    outputs: [{ artifact: { id: "child-artifact", name: "child-report.md" },
      version: { id: "child-version", version: 1, turnId: "child" } }],
    subagents: [{ id: "child", parentTurnId: "r" }],
  });
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "passed");
});
test("required handoff prefers main workspace files over child copies", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    outputs: [
      { artifact: { id: "child-brief", name: "subagents/child/evidence_brief.md" },
        version: { id: "child-brief-v1", version: 1, turnId: "child" } },
      { artifact: { id: "main-brief", name: "reports/evidence_brief.md" },
        version: { id: "main-brief-v1", version: 1, turnId: "r" } },
      { artifact: { id: "child-answer", name: "subagents/child/answer.txt" },
        version: { id: "child-answer-v1", version: 1, turnId: "child" } },
      { artifact: { id: "main-answer", name: "answer.txt" },
        version: { id: "main-answer-v1", version: 1, turnId: "r" } },
    ],
    subagents: [{ id: "child", parentTurnId: "wake" }],
  });
  const delivery = await collectFinalDelivery(fake.page, "s", "wake", "r");
  const required = requiredArtifacts(delivery.artifacts, ["evidence_brief.md", "answer.txt"]);
  assert.deepEqual(required.missing, []);
  assert.equal(required.found.get("evidence_brief.md")?.id, "main-brief");
  assert.equal(required.found.get("answer.txt")?.id, "main-answer");
});

test("required handoff uses the latest child Run when no main copy exists", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    outputs: [
      { artifact: { id: "first", name: "subagents/child-a/evidence_brief.md" },
        version: { id: "first-v1", version: 1, turnId: "child-a" } },
      { artifact: { id: "later", name: "subagents/child-b/evidence_brief.md" },
        version: { id: "later-v1", version: 1, turnId: "child-b" } },
    ],
    subagents: [{ id: "child-a", parentTurnId: "r" }, { id: "child-b", parentTurnId: "wake" }],
  });
  const delivery = await collectFinalDelivery(fake.page, "s", "wake", "r");
  const required = requiredArtifacts(delivery.artifacts, ["evidence_brief.md"]);
  assert.deepEqual(required.missing, []);
  assert.equal(required.found.get("evidence_brief.md")?.id, "later");
});

test("a later notes declaration preserves required outputs from the root Run", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    outputs: [
      { artifact: { id: "trace", name: "trace.md" }, version: { id: "trace-v1", version: 1, turnId: "r" } },
      { artifact: { id: "answer", name: "answer.txt" }, version: { id: "answer-v1", version: 1, turnId: "r" } },
      { artifact: { id: "notes", name: "notes.md" }, version: { id: "notes-v1", version: 1, turnId: "wake" } },
    ],
  });
  const result = await collectFinalDelivery(fake.page, "s", "wake", "r");
  assert.equal(result.status, "passed");
  assert.deepEqual(requiredArtifacts(result.artifacts, ["trace.md", "answer.txt"]).missing, []);
  assert.deepEqual(result.artifacts.map(a => a.logicalName), ["trace.md", "answer.txt", "notes.md"]);
});

test("a wake revision replaces only the same named output", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    outputs: [
      { artifact: { id: "trace", name: "trace.md" }, version: { id: "trace-v1", version: 1, turnId: "r" } },
      { artifact: { id: "answer", name: "answer.txt" }, version: { id: "answer-v1", version: 1, turnId: "r" } },
      { artifact: { id: "answer", name: "answer.txt" }, version: { id: "answer-v2", version: 2, turnId: "wake" } },
    ],
  });
  const result = await collectFinalDelivery(fake.page, "s", "wake", "r");
  assert.equal(result.status, "passed");
  assert.deepEqual(requiredArtifacts(result.artifacts, ["trace.md", "answer.txt"]).missing, []);
  assert.equal(result.artifacts.find(a => a.logicalName === "answer.txt")?.version, "answer-v2");
  assert.ok(!fake.paths.some(p => p.includes("answer-v1/content")));
});

test("an empty supplementary draft is diagnostic without invalidating a valid required brief", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    outputs: [
      { artifact: { id: "brief", name: "evidence_brief.md" },
        version: { id: "brief-v1", version: 1, turnId: "r" } },
      { artifact: { id: "draft", name: "draft.md" },
        version: { id: "draft-v1", version: 1, turnId: "r" } },
    ],
    contentByVersion: { "brief-v1": { content: "Final brief" }, "draft-v1": { content: "  " } },
  });
  const result = await collectFinalDelivery(fake.page, "s", "r");
  assert.equal(result.status, "passed");
  assert.deepEqual(requiredArtifacts(result.artifacts, ["evidence_brief.md"]).missing, []);
  assert.match(result.errors.join("; "), /draft: Empty final artifact/);
});

test("a broken newer declaration of a required name never falls back to its older version", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "m", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    outputs: [
      { artifact: { id: "old", name: "answer.txt" }, version: { id: "old-version", version: 1, turnId: "r" } },
      { artifact: { id: "new", name: "answer.txt" }, version: { id: "broken-version", version: 1, turnId: "wake" } },
      { artifact: { id: "notes", name: "notes.md" }, version: { id: "notes-version", version: 1, turnId: "wake" } },
    ],
    contentByVersion: { "broken-version": { content: "", status: 404 } },
  });
  const result = await collectFinalDelivery(fake.page, "s", "wake", "r");
  assert.deepEqual(requiredArtifacts(result.artifacts, ["answer.txt"]).missing, ["answer.txt"]);
  assert.ok(fake.paths.some(p => p.includes("broken-version/content")));
  assert.ok(!fake.paths.some(p => p.includes("old-version/content")));
});

test("intermediate artifacts do not satisfy required benchmark outputs", () => {
  const notes = [{ id: "notes", logicalName: "work/notes.md", version: "v1", text: "Draft", bytes: 5 }];
  assert.deepEqual(requiredArtifacts(notes, ["trace.md", "answer.txt"]).missing, ["trace.md", "answer.txt"]);
  assert.equal(finalReportArtifact(notes, "deepresearchbench-59.md", "Done."), undefined);
});

test("nested required outputs and an explicitly handed off renamed report are accepted", () => {
  const artifacts = [
    { id: "trace", logicalName: "results/trace.md", version: "v1", text: "Trace", bytes: 5 },
    { id: "answer", logicalName: "results/answer.txt", version: "v2", text: "Answer", bytes: 6 },
    { id: "report", logicalName: "results/review-v2.md", version: "v3", text: "Report", bytes: 6 },
  ];
  assert.deepEqual(requiredArtifacts(artifacts, ["trace.md", "answer.txt"]).missing, []);
  assert.equal(finalReportArtifact(artifacts, "deepresearchbench-59.md", "Final report: results/review-v2.md"), artifacts[2]);
});

test("an unrelated wake output retains a renamed report's own handoff", async () => {
  const fake = api("completed", "Done.", "report", 200, {
    runs: [{ id: "r", assistantMessageId: "report-message", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "wake-message", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    messages: [
      { id: "report-message", role: "assistant", content: "Final report: results/review-v2.md" },
      { id: "wake-message", role: "assistant", content: "Supplementary notes.md attached." },
    ],
    outputs: [
      { artifact: { id: "report", name: "results/review-v2.md" },
        version: { id: "report-version", version: 1, turnId: "r" } },
      { artifact: { id: "notes", name: "notes.md" },
        version: { id: "notes-version", version: 1, turnId: "wake" } },
    ],
  });
  const delivery = await collectFinalDelivery(fake.page, "s", "wake", "r");
  assert.equal(delivery.status, "passed");
  assert.equal(finalReportArtifact(delivery.artifacts, "deepresearchbench-59.md", delivery.producer_answer)?.id, "report");
});

test("a later casual note mention cannot supersede the official report name", async () => {
  for (const wakeReply of ["Added notes.md", "Final report is ready. See notes.md for supplemental details."]) {
    const fake = api("completed", "Done.", "report", 200, {
      runs: [{ id: "r", assistantMessageId: "root-message", status: "completed", queueOrder: 1 },
        { id: "wake", assistantMessageId: "wake-message", status: "completed", queueOrder: 2,
          automaticWake: true, notificationDelivery: { agentId: "main" } }],
      messages: [
        { id: "root-message", role: "assistant", content: "Done." },
        { id: "wake-message", role: "assistant", content: wakeReply },
      ],
      outputs: [
        { artifact: { id: "official", name: "deepresearchbench-59.md" },
          version: { id: "official-v1", version: 1, turnId: "r" } },
        { artifact: { id: "notes", name: "notes.md" },
          version: { id: "notes-v1", version: 1, turnId: "wake" } },
      ],
    });
    const delivery = await collectFinalDelivery(fake.page, "s", "wake", "r");
    assert.equal(delivery.status, "passed");
    assert.equal(finalReportArtifact(delivery.artifacts, "deepresearchbench-59.md", delivery.producer_answer)?.id,
      "official", wakeReply);
  }
});

test("a casual note mention cannot substitute for an absent official report", () => {
  const notes = [{ id: "notes", logicalName: "notes.md", version: "v1", text: "draft", bytes: 5,
    producerAnswer: "See notes.md for supplemental details.", producerRunOrder: 1 }];
  assert.equal(finalReportArtifact(notes, "deepresearchbench-59.md", "Done."), undefined);
});

test("a later explicitly handed off report supersedes the earlier expected name", () => {
  const artifacts = [
    { id: "old", logicalName: "deepresearchbench-59.md", version: "v1", text: "old", bytes: 3,
      producerAnswer: "Final report: deepresearchbench-59.md", producerRunOrder: 0 },
    { id: "new", logicalName: "review-v2.md", version: "v2", text: "new", bytes: 3,
      producerAnswer: "Final report: review-v2.md", producerRunOrder: 1 },
  ];
  assert.equal(finalReportArtifact(artifacts, "deepresearchbench-59.md", "Done."), artifacts[1]);
});

test("renamed final reports accept sentence punctuation and relative paths", () => {
  const report = { id: "report", logicalName: "results/review-v2.md", version: "v2", text: "Report", bytes: 6 };
  for (const reply of [
    "Final report: results/review-v2.md",
    "最终报告：results/review-v2.md。",
    "Final report: results/review-v2.md.",
    "The final report is review-v2.md.",
    "Final report saved to ./results/review-v2.md",
  ]) {
    assert.equal(finalReportArtifact([report], "deepresearchbench-59.md", reply), report, reply);
  }
  assert.equal(finalReportArtifact([report], "deepresearchbench-59.md",
    "Final report: results/review-v2.md.bak"), undefined);
});

test("a wake acknowledgement uses the producing Run's report handoff", async () => {
  const fake = api("completed", "Done.", "Final report", 200, {
    runs: [{ id: "r", assistantMessageId: "report-message", status: "completed", queueOrder: 1 },
      { id: "wake", assistantMessageId: "wake-message", status: "completed", queueOrder: 2,
        automaticWake: true, notificationDelivery: { agentId: "main" } }],
    messages: [
      { id: "report-message", role: "assistant", content: "Final report: results/review-v2.md" },
      { id: "wake-message", role: "assistant", content: "Background work finished." },
    ],
    outputs: [{ artifact: { id: "report", name: "results/review-v2.md" },
      version: { id: "version", version: 1, turnId: "r" } }],
  });
  const delivery = await collectFinalDelivery(fake.page, "s", "wake", "r");
  assert.equal(delivery.answer, "Background work finished.");
  assert.equal(delivery.producer_answer, "Final report: results/review-v2.md");
  assert.equal(finalReportArtifact(delivery.artifacts, "deepresearchbench-59.md", delivery.producer_answer)?.id, "report");
});
