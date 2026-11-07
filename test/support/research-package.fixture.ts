// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createResearchPackage, importResearchPackage, sha256 } from "../../packages/research-package/src/index.js";
import { contextBlocks, type TrajectoryDetail } from "../../packages/trajectory/src/index.js";
import type { RunStreamEvent } from "../../packages/schema/src/index.js";

/** Historical research, with independently linked execution, file and graph records. */
export function researchHistoryFixture(extraFiles: Array<{ path: string; bytes: Buffer }> = []) {
  const date = "2026-10-20T10:00:00.000Z";
  const file = Buffer.from("value\n42\n");
  const code = Buffer.from("printf 'research-output-42\\n' > results/verified.csv");
  const stdout = Buffer.from("research-output-42\n");
  const stderr = Buffer.from("historical-warning\n");
  const env = Buffer.from('{"LANG":"C.UTF-8"}');
  const prompt = Buffer.from("Imported evidence prompt visible in history");
  const object = (bytes: Buffer) => ({ hash: sha256(bytes), size: bytes.length });
  const revision = (id: string, artifactVersionIds: string[], parentRevisionId?: string) => ({
    id, fileId: "file-source", sessionId: "fixture-session", projectId: "fixture-project", path: "results/verified.csv",
    artifactVersionIds, parentRevisionId, runId: "run-source", executionRunId: "exec-source", toolCallId: "tool-source",
    origin: "tool", toolName: "run_shell", createdAt: date, modifiedAt: date, size: file.length, contentHash: sha256(file),
  });
  const previous = revision("revision-old", []);
  const current = revision("revision-current", ["version-source"], previous.id);
  const records = {
    sessions: [{ session: { id: "fixture-session", title: "Imported history" }, messages: [
      { id: "fixture-prompt", role: "user", content: prompt.toString(), createdAt: date },
      { id: "fixture-answer", role: "assistant", content: "Imported evidence result visible in history", createdAt: date },
    ], runs: [{ id: "run-source", sessionId: "fixture-session", prompt: prompt.toString(), createdAt: date, finishedAt: date, status: "completed", queueOrder: 1, annotationIds: [], references: [], settingsSnapshot: {}, userMessageId: "fixture-prompt", assistantMessageId: "fixture-answer" }],
    runEvents: [{ runId: "run-source", streams: [
      { streamId: "main", events: [
        { sequence: 3, createdAt: date, event: { type: "tool.started", trace: { id: "tool-source", name: "run_shell", input: JSON.stringify({ code: code.toString() }), status: "running" } } satisfies RunStreamEvent },
        { sequence: 4, createdAt: date, event: { type: "tool.completed", trace: { id: "tool-source", name: "run_shell", status: "completed", outputStream: "tool-tool-source", preview: stdout.toString() } } satisfies RunStreamEvent },
      ] },
      { streamId: "tool-tool-source", events: [{ sequence: 1, createdAt: date, event: { type: "tool.output", toolCallId: "tool-source", chunk: stdout.toString() } satisfies RunStreamEvent }] },
    ] }],
    executionRuns: [{ id: "exec-source", sessionId: "fixture-session", turnId: "run-source", toolCallId: "tool-source", code: object(code), stdout: object(stdout), stderr: object(stderr), envSnapshot: object(env), environmentRevisionId: null, startedAt: date, finishedAt: date, status: "succeeded", exitCode: 0, createdFiles: ["results/verified.csv"], modifiedFiles: [], language: "shell", tool: "run_shell", toolVersion: "1", runnerVersion: "fixture", kernelId: "historical", kernelMode: null, networkPolicy: "none", permissionEpochId: "historical", sandbox: "none", cgroupMode: "none", workingDirectory: "/workspace" }],
    promptManifests: [{ id: "manifest-source", sessionId: "fixture-session", turnId: "run-source", inputs: [{ ...object(prompt), messageId: "fixture-prompt", role: "user" }], systemPrompt: { ...object(prompt), version: "1" }, createdAt: date, finishedAt: date, status: "succeeded", runtimeSettings: {}, skillRefs: [] }],
    artifactDerivations: [{ id: "derivation-source", sessionId: "fixture-session", turnId: "run-source", content: object(file), path: "results/verified.csv", createdAt: date, executionRunIds: ["exec-source"], sourceType: "generated" }],
    shellExecutions: [{ id: "shell-source", sessionId: "fixture-session", agentId: "main", runnerId: "original-unreachable-runner", workspaceId: "historical-workspace", turnId: "run-source", queuedAt: date, startedAt: date, finishedAt: date, state: "completed", accepted: true, provenance: "committed", result: {
      executionId: "exec-source", environmentRevisionId: "old-shell-env", language: "shell", stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0, createdFiles: ["results/verified.csv"], modifiedFiles: [], environmentVariables: { LANG: "C.UTF-8" }, kernelId: "historical", kernelMode: "ephemeral", startedAt: date, finishedAt: date, networkPolicy: "none", runnerVersion: "fixture", sandbox: "none", cgroupMode: "none", workingDirectory: "/workspace",
    } }],
    workspace: [{ path: "results/verified.csv", objectPath: sha256(file), size: file.length, modifiedAt: date },
      ...extraFiles.map(({ path, bytes }) => ({ path, objectPath: sha256(bytes), size: bytes.length, modifiedAt: date }))],
    workspaceProvenance: [{ file: { id: "file-source", path: current.path, currentRevisionId: current.id, sessionId: "fixture-session", projectId: "fixture-project", sessionTitle: "Imported history", createdAt: date, updatedAt: date }, currentRevision: current, revisions: [previous, current], artifacts: [], lineage: [], sourceSession: { id: "fixture-session", title: "Imported history", deleted: false } }],
    }],
    artifacts: [{ id: "artifact-source", projectId: "fixture-project", createdInSessionId: "fixture-session", name: current.path, logicalName: current.path, kind: "dataset", origin: "generated", currentVersion: 4, createdAt: date, updatedAt: date, versions: [{ id: "version-source", artifactId: "artifact-source", sessionId: "fixture-session", projectId: "fixture-project", version: 4, createdAt: date, content: object(file), mediaType: "text/csv", sourcePath: current.path, executionRunIds: ["exec-source"], inputArtifactVersionIds: [] as string[], turnId: "run-source", objectPath: sha256(file) }] }],
    memoryGraph: { nodes: [
      { id: "goal", labels: ["ResearchGoal"], properties: { goal_id: "goal:session:fixture-session", session_id: "fixture-session", project_id: "fixture-project", title: prompt.toString() } },
      { id: "tool", labels: ["ToolCall"], properties: { task_id: "subtask:exec-source", session_id: "fixture-session", turn_id: "run-source", title: "Historical calculation" } },
      { id: "code", labels: ["Code"], properties: { code_id: "exec-source", session_id: "fixture-session", code_hash: sha256(code), stdout_hash: sha256(stdout), stderr_hash: sha256(stderr), language: "shell", status: "succeeded" } },
      { id: "artifact", labels: ["Artifact"], properties: { artifact_id: "artifact-source", version: 4, session_id: "fixture-session", project_id: "fixture-project", turn_id: "run-source", name: current.path, path: current.path, kind: "dataset", content_hash: sha256(file) } },
    ], edges: [
      { source: "goal", target: "tool", type: "next", properties: {} },
      { source: "tool", target: "code", type: "produces", properties: {} },
      { source: "code", target: "artifact", type: "produces", properties: {} },
    ] },
  };
  const bytes = createResearchPackage({ source: { projectId: "fixture-project", title: "Complete import fixture", sessionIds: ["fixture-session"] }, records,
    objects: [file, code, stdout, stderr, env, prompt, ...extraFiles.map(({ bytes }) => bytes)].map((bytes) => ({ path: sha256(bytes), bytes })) }).bytes;
  return { bytes, records, date };
}

/** Full resolved trajectory evidence, independent of the exporting machine's CAS. */
export function researchTrajectoryFixture(extraFiles: Array<{ path: string; bytes: Buffer }> = []) {
  const base = researchHistoryFixture(extraFiles);
  const input = { systemPrompt: "Exact imported system prompt", history: [{ role: "user", content: "Exact imported user input" }], tools: [{ name: "run_shell", parameters: { type: "object" } }] };
  const thinking = "Recorded reasoning line.\n".repeat(2000) + "END_OF_IMPORTED_THINKING";
  const context = { input, assembly: { turn: 1 }, state: { agentId: "main:fixture-session", phase: "before" }, blocks: contextBlocks(input, {}) };
  const details: TrajectoryDetail[] = [
    { entry: { id: "input-source", agentId: "main:fixture-session", kind: "input", label: "context.captured", eventType: "context.captured", timestamp: base.date, runId: "run-source", contextId: "context-source" }, value: { type: "context.captured" }, context },
    { entry: { id: "thinking-source", agentId: "main:fixture-session", kind: "thinking", label: "assistant.thinking.delta", eventType: "assistant.thinking.delta", timestamp: base.date, runId: "run-source", contextId: "context-source" }, value: { type: "assistant.thinking.delta", packets: [{ event: { delta: thinking.slice(0, 10000) } }, { event: { delta: thinking.slice(10000) } }] }, context },
  ];
  const trajectory = { index: { schemaVersion: 1 as const, sessionId: "fixture-session", capturedAt: base.date, agents: [{ id: "main:fixture-session", label: "Main Agent" }], entries: details.map((detail) => detail.entry), untimedEntries: [], historicalEntries: [], warnings: [] }, details, runIds: ["run-source"] };
  const records = { ...base.records, sessions: base.records.sessions.map((session) => ({ ...session, trajectory })) };
  const imported = importResearchPackage(base.bytes);
  const bytes = createResearchPackage({ source: imported.manifest.source, records, objects: [...imported.objects].map(([path, bytes]) => ({ path, bytes })) }).bytes;
  return { ...base, bytes, records, input, thinking };
}
