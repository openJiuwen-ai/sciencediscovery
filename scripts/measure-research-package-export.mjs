// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// Measure the `necessary` research-package preview and export on a synthetic
// Session, and count the work that changed in #1365: full run-stream reads, CAS
// payload streams, and evidence-revision walks. The same script runs on the
// baseline and the candidate worktree (it only uses APIs both have; baseline
// simply has no storedSize, so its preview falls back to cas.stream).
//
// Usage (workspace built first, because the API sources import package dist):
//   node --import tsx scripts/measure-research-package-export.mjs \
//     --events 200000 --cas-bytes 117440512 --rounds 5 [--workspace-files 0]
//
// It writes packages to a temporary directory and removes the whole fixture at
// the end. Timings are medians; counts are medians of the per-round snapshots.
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CasStore } from "../packages/cas/dist/index.js";
import { writeResearchPackage } from "../packages/research-package/dist/index.js";
import { createResearchSnapshots } from "../services/api/src/research-snapshots.ts";
import { ResearchExportPreviews } from "../services/api/src/research-export-previews.ts";
import { SessionStore } from "../services/api/src/store.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

const eventCount = argument("events", 200_000);
const casBytes = argument("cas-bytes", 112 * 1024 * 1024);
const rounds = Math.max(1, argument("rounds", 5));
const workspaceFiles = argument("workspace-files", 0);
const median = (values) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)];

function previewSizing() {
  return {
    objectSizes: new Map(), additionalRecordBytes: 0, unpinnedObjectBytes: [],
    hashes: new Set(), refs: new Map(), jsonSizes: new WeakMap(),
    casVisited: new WeakSet(), refsVisited: new WeakSet(), workspaceListings: new Map(),
  };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "research-package-measure-"));
  const store = new SessionStore(root);
  store.setAvailableSkillIds([]);
  await store.load();
  const project = await store.createProject("Research package measurement");
  const session = await store.createSession(project.id, "Measured export", {}, {}, { allowUnconfiguredModel: true });
  const run = await store.createSessionRun({
    sessionId: session.id, prompt: "Synthetic measured run", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  const finishedAt = new Date().toISOString();
  await store.updateSessionRunStatus(session.id, run.id, "completed", { startedAt: finishedAt, finishedAt });

  const streamDir = resolve(root, "run-events", session.id, run.id);
  await mkdir(streamDir, { recursive: true });
  const lines = [];
  for (let index = 0; index < eventCount; index++) {
    lines.push(JSON.stringify({
      createdAt: new Date(Date.parse(finishedAt) + index).toISOString(), sequence: index + 1,
      event: { delta: `measured token ${index} `.repeat(3), responseId: "measured-response", turn: 1, type: "assistant.thinking.delta" },
    }));
  }
  await writeFile(resolve(streamDir, "main.jsonl"), `${lines.join("\n")}\n`);

  for (let index = 0; index < workspaceFiles; index++) {
    const directory = resolve(store.workspacePath(session.id), "measured");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `file-${index}.txt`), `measured workspace file ${index}\n`);
  }

  const base = new CasStore(root);
  const payload = Math.max(1, Math.round(casBytes / 2));
  const code = await base.put(Buffer.alloc(payload, 7));
  const stdout = await base.put(Buffer.alloc(Math.max(1, Math.round(casBytes / 4)), 8));
  const stderr = await base.put(Buffer.alloc(Math.max(1, Math.round(casBytes / 4)), 9));
  await store.appendExecutionRun({
    id: "measured-execution", sessionId: session.id, turnId: run.id, code, stdout, stderr,
    cgroupMode: "none", createdFiles: [], modifiedFiles: [], environmentRevisionId: null, exitCode: 0,
    startedAt: finishedAt, finishedAt, kernelId: "measured", kernelMode: null, language: null,
    networkPolicy: "none", permissionEpochId: session.permissionEpochId, runnerVersion: "measured",
    sandbox: "bubblewrap", status: "succeeded", tool: "run_shell", toolVersion: "measured", workingDirectory: "/workspace",
  });

  const counters = { exportRunStreams: 0, streamCalls: 0, streamBytes: 0, readCalls: 0, storedSizeCalls: 0 };
  const cas = {
    exists: (hash) => base.exists(hash),
    read: async (hash) => { counters.readCalls++; return await base.read(hash); },
    stream: async function* (hash) {
      counters.streamCalls++;
      for await (const chunk of base.stream(hash)) { counters.streamBytes += chunk.byteLength; yield chunk; }
    },
  };
  if (typeof base.storedSize === "function") cas.storedSize = async (hash) => { counters.storedSizeCalls++; return await base.storedSize(hash); };
  const original = store.exportRunStreams.bind(store);
  store.exportRunStreams = async (sessionId, runId) => { counters.exportRunStreams++; return await original(sessionId, runId); };
  const snapshots = createResearchSnapshots({
    store, evolutionStore: {}, evolveCandidates: {}, memoryGraphClient: { snapshotRevision: async () => "" },
    memoryGraphEnabled: () => false, provenanceRecorder: { cas },
  }, async () => true);
  return { root, store, project, session, run, counters, snapshots };
}

async function measureRevisionWalks() {
  let reads = 0;
  const previews = new ResearchExportPreviews(
    async () => { reads++; return "measured-revision"; },
    async (_options, revision) => ({ revision, estimatedBytes: 1, estimateKind: "uncompressed", files: [], omissions: [] }),
  );
  try {
    await previews.defaults("measured-project", "measured-session");
    return reads;
  } finally { await previews.close(); }
}

const f = await fixture();
const previewMs = [], exportMs = [], previewCounts = [], exportCounts = [], packageBytes = [];
let lastPreview, lastExport;
try {
  // Warm page cache and JIT without counting the warm-up.
  await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary", undefined, undefined, previewSizing(), false, false);
  const warmExport = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary", undefined, undefined, undefined, false, false, new AbortController().signal, { streamObjects: true });
  await writeResearchPackage(warmExport, createWriteStream(resolve(f.root, "warm.sdresearch"), { flags: "wx" }));

  for (let round = 0; round < rounds; round++) {
    f.counters.exportRunStreams = f.counters.streamCalls = f.counters.streamBytes = 0;
    f.counters.readCalls = f.counters.storedSizeCalls = 0;
    let started = performance.now();
    lastPreview = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary", undefined, undefined, previewSizing(), false, false);
    previewMs.push(performance.now() - started);
    previewCounts.push({ ...f.counters });

    f.counters.exportRunStreams = f.counters.streamCalls = f.counters.streamBytes = 0;
    f.counters.readCalls = f.counters.storedSizeCalls = 0;
    const output = resolve(f.root, `measured-${round}.sdresearch`);
    started = performance.now();
    lastExport = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary", undefined, undefined, undefined, false, false, new AbortController().signal, { streamObjects: true });
    await writeResearchPackage(lastExport, createWriteStream(output, { flags: "wx" }));
    exportMs.push(performance.now() - started);
    exportCounts.push({ ...f.counters });
    packageBytes.push((await stat(output)).size);
    await rm(output, { force: true });
  }

  const complete = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined, undefined, false, false);
  const parity = {
    necessaryOmittedRunEvents: lastPreview.exportProfile?.omitted.runEvents,
    completeIncludedRunEvents: complete.exportProfile?.included.runEvents,
    equal: lastPreview.exportProfile?.omitted.runEvents === complete.exportProfile?.included.runEvents,
  };

  console.log(JSON.stringify({
    fixture: { sessions: 1, runs: 1, events: eventCount, casBytes, workspaceFiles },
    method: { rounds, statistic: "median", warmup: 1 },
    timingsMs: {
      preview: { median: median(previewMs), samples: previewMs },
      exportBuildAndWrite: { median: median(exportMs), samples: exportMs },
    },
    countsPerRound: {
      preview: Object.fromEntries(Object.keys(previewCounts[0]).map((key) => [key, median(previewCounts.map((row) => row[key]))])),
      export: Object.fromEntries(Object.keys(exportCounts[0]).map((key) => [key, median(exportCounts.map((row) => row[key]))])),
    },
    packageBytes: median(packageBytes),
    revisionWalks: { defaultsProfiles: 5, invocationCount: await measureRevisionWalks() },
    parity,
  }, null, 2));
} finally {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}
