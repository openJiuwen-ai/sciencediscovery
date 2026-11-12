// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createResearchPackage, importResearchPackage, estimateResearchPackageBytes, sha256, type ResearchPackageExportProfile } from "@sciencediscovery/research-package";
import { createApiServer, closeApiServer } from "./http/index.js";
import { ApiStatusError } from "./http/api-status-error.js";
import { ResearchExportPreviews } from "./research-export-previews.js";
import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import { createServer } from "node:http";
import { researchHistoryFixture, researchTrajectoryFixture } from "../../../test/support/research-package.fixture.js";
import type { TrajectoryIndex, TrajectoryDetail } from "@sciencediscovery/trajectory";
import type { ServerConfig } from "./bootstrap/config.js";
import type { ArtifactVersionProvenance, WorkspaceFileProvenance, SessionRun, AgentShellExecution, SessionRunEvent, ArtifactReviewRun, Claim, EvidenceItem, EvidenceLink } from "@sciencediscovery/schema";
import type { SessionDetail, ResearchContinuationOperation } from "@sciencediscovery/schema";

async function fixture(context: TestContext, graphAvailable = false, sampleSession = false) {
  const root = await mkdtemp(resolve(tmpdir(), "research-package-http-"));
  const snapshots: ReturnType<typeof researchHistoryFixture>["records"]["memoryGraph"][] = [];
  let graphExports = 0;
  const graphEvents = new EventEmitter();
  const graph = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    response.setHeader("content-type", "application/json");
    if (!graphAvailable) { response.writeHead(503); response.end('{}'); return; }
    if (request.url === "/internal/research-package/import") snapshots.push(body);
    if (request.url === "/internal/research-package/export") {
      graphExports++;
      graphEvents.emit("export");
      const selected = snapshots.map((snapshot) => {
        const nodes = snapshot.nodes.filter((node) => body.session_ids.includes(node.properties.session_id));
        const keys = new Set(nodes.map((node) => node.id));
        return { nodes, edges: snapshot.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target)) };
      });
      response.end(JSON.stringify({ nodes: selected.flatMap((snapshot) => snapshot.nodes), edges: selected.flatMap((snapshot) => snapshot.edges) }));
    } else response.end(JSON.stringify({ ok: true, status: "healthy", reason: "not_available" }));
  });
  await new Promise<void>((done) => graph.listen(0, "127.0.0.1", done));
  const config: ServerConfig = {
    sampleSession, authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`, internalToken: "test" }, evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  let server = createApiServer(config, { mcpTransport: offlineMcpTransport });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => { await closeApiServer(server); await new Promise<void>((done) => graph.close(() => done())); await rm(root, { force: true, recursive: true }); });
  let origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const restart = async () => {
    await closeApiServer(server);
    server = createApiServer(config, { mcpTransport: offlineMcpTransport });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const rawRequest = async (path: string, init: RequestInit = {}) => {
    return await fetch(`${origin}${path}`, { ...init, headers: { authorization: "Bearer test-token", ...(init.headers ?? {}) } });
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await rawRequest(path, init);
    assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
    return response;
  };
  let projectSequence = 0;
  const project = async () => await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `科研恢复验证 ${++projectSequence}` }) })).json() as { id: string; firstSession: { id: string } };
  const waitForGraphExports = async (count: number) => {
    const signal = AbortSignal.timeout(30_000);
    while (graphExports < count) await once(graphEvents, "export", { signal });
  };
  return { rawRequest, request, project, snapshots, restart, root, graphExports: () => graphExports, waitForGraphExports };
}

const date = "2026-10-20T10:00:00.000Z";

test("incremental previews match exported evidence and profile sizes", async (context) => {
  const { request, project } = await fixture(context, true);
  const target = await project();
  const historical = researchTrajectoryFixture();
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(historical.bytes) });
  for (const level of ["necessary", "complete"]) for (const trajectory of [false, true]) for (const memory of [false, true]) {
    const query = `sessionId=${target.firstSession.id}&level=${level}&includeFullTrajectory=${Number(trajectory)}&includeFullMemoryGraph=${Number(memory)}`;
    const base = `/api/projects/${target.id}/research-package`;
    const preview = await (await request(`${base}/preview?${query}`)).json() as { estimatedBytes: number };
    const exported = importResearchPackage(new Uint8Array(await (await request(`${base}?${query}`)).arrayBuffer()));
    assert.equal(preview.estimatedBytes, estimateResearchPackageBytes({
      source: exported.manifest.source, records: exported.records, readme: Buffer.from(exported.readme).toString(),
      omissions: exported.manifest.omissions, exportProfile: exported.manifest.exportProfile,
      objects: [...exported.objects].map(([path, bytes]) => ({ path, bytes })),
    }), query);
  }
});

test("pending export previews return HTTP 409 for single and default profiles", async (context) => {
  const { rawRequest, project } = await fixture(context);
  const target = await project();
  context.mock.method(ResearchExportPreviews.prototype, "get", async () => {
    throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
  });
  const endpoint = `/api/projects/${target.id}/research-package/preview?sessionId=${target.firstSession.id}`;
  for (const query of ["&level=complete", "&defaults=1"]) {
    const response = await rawRequest(`${endpoint}${query}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "EXPORT_PREVIEW_PENDING");
  }
});

test("a preview poll of a deleted project ends as gone instead of a 404", async (context) => {
  const { rawRequest, request, project } = await fixture(context);
  const target = await project();
  const endpoint = `/api/projects/${target.id}/research-package/preview?sessionId=${target.firstSession.id}`;
  assert.equal((await rawRequest(`${endpoint}&defaults=1`)).status, 200);
  await request(`/api/projects/${target.id}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationId: target.id }),
  });
  // The panel still has the Session on screen; its poll must end quietly, not
  // raise a browser resource error the mocked journey records (#1072).
  const gone = await rawRequest(`${endpoint}&defaults=1`);
  assert.equal(gone.status, 200);
  assert.deepEqual(await gone.json(), { state: "deleted" });
  // A one-shot preview read keeps reporting that its scope is gone.
  const single = await rawRequest(`${endpoint}&level=complete`);
  assert.equal(single.status, 404);
  // A download of a package that is gone is still a mistake worth reporting.
  const missingPackage = await rawRequest(`/api/projects/${target.id}/research-package?sessionId=${target.firstSession.id}`);
  assert.equal(missingPackage.status, 404);
});

test("async preview clients receive accepted pending state and recover for single and default profiles", async (context) => {
  const { rawRequest, project } = await fixture(context);
  const target = await project();
  let pending = true;
  let unavailable = false;
  context.mock.method(ResearchExportPreviews.prototype, "get", async () => {
    if (unavailable) throw new ApiStatusError(503, "Export storage unavailable", "EXPORT_STORAGE_UNAVAILABLE");
    if (pending) throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
    return { revision: "settled", estimatedBytes: 42, files: [], omissions: [] };
  });
  const endpoint = `/api/projects/${target.id}/research-package/preview?sessionId=${target.firstSession.id}`;
  for (const query of ["&level=complete", "&defaults=1"]) {
    pending = true;
    const response = await rawRequest(`${endpoint}${query}`, { headers: { Prefer: "respond-async" } });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("preference-applied"), "respond-async");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { code: string }).code, "EXPORT_PREVIEW_PENDING");
    pending = false;
    const ready = await rawRequest(`${endpoint}${query}`, { headers: { Prefer: "respond-async" } });
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { revision: string }).revision, "settled");
  }
  unavailable = true;
  const failed = await rawRequest(`${endpoint}&level=complete`, { headers: { Prefer: "respond-async" } });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as { code: string }).code, "EXPORT_STORAGE_UNAVAILABLE");
});

test("preview deletion ends the poll quietly while shutdown and the one-shot read keep their status", async (context) => {
  const { rawRequest, project } = await fixture(context);
  const target = await project();
  let failure: ApiStatusError;
  context.mock.method(ResearchExportPreviews.prototype, "get", async () => { throw failure; });
  const endpoint = `/api/projects/${target.id}/research-package/preview?sessionId=${target.firstSession.id}`;
  for (const [status, code] of [[404, "EXPORT_PREVIEW_RESOURCE_DELETED"], [503, "EXPORT_PREVIEW_SERVICE_CLOSED"]] as const) {
    failure = new ApiStatusError(status, "Preview intentionally stopped", code);
    // The one-shot read keeps its status; the polling shape ends as `gone`
    // because that is what a mounted panel asks and repeats (#1072).
    const single = await rawRequest(`${endpoint}&level=complete`, { headers: { Prefer: "respond-async" } });
    assert.equal(single.status, status);
    assert.equal((await single.json() as { code: string }).code, code);
    const polled = await rawRequest(`${endpoint}&defaults=1`, { headers: { Prefer: "respond-async" } });
    if (code === "EXPORT_PREVIEW_RESOURCE_DELETED") {
      assert.equal(polled.status, 200);
      assert.deepEqual(await polled.json(), { state: "deleted" });
    } else {
      assert.equal(polled.status, status);
      assert.equal((await polled.json() as { code: string }).code, code);
    }
  }
});

test("the first-install sample supports all five preview profiles without unshipped state objects", async (context) => {
  const f = await fixture(context, false, true);
  const projects = await (await f.request("/api/projects")).json() as { id: string }[];
  const projectId = projects[0]!.id;
  const sessions = await (await f.request(`/api/projects/${projectId}/sessions`)).json() as { id: string }[];
  const response = await f.rawRequest(`/api/projects/${projectId}/research-package/preview?sessionId=${sessions[0]!.id}&defaults=1`, { headers: { Prefer: "respond-async" } });
  assert.equal(response.status, 200);
  const previews = await response.json() as { revision: string; complete: { estimatedBytes: number }; completeWithTrajectory: { estimatedBytes: number } };
  assert.ok(previews.revision);
  assert.ok(previews.complete.estimatedBytes > 0);
  assert.ok(previews.completeWithTrajectory.estimatedBytes > previews.complete.estimatedBytes, "the recorded trajectory remains in the complete preview");
});

test("viewing a conversation does not warm previews; the export dialog computes the five profiles on demand", async (context) => {
  const f = await fixture(context, true);
  const target = await f.project();
  const sessionId = target.firstSession.id;
  await f.request(`/api/sessions/${sessionId}`);
  assert.equal(f.graphExports(), 0, "viewing a session must not start any export build");
  const endpoint = `/api/projects/${target.id}/research-package/preview?sessionId=${sessionId}`;
  const defaults = async () => await (await f.request(`${endpoint}&defaults=1`)).json() as { revision: string; complete: { estimatedBytes: number; files: { path: string; selected: boolean }[] } };
  const warmed = await defaults();
  const exports = f.graphExports();
  assert.ok(exports >= 5, "the export dialog computes the profiles it shows");
  await f.request(`${endpoint}&level=necessary&includeFullTrajectory=0`);
  await f.request(`${endpoint}&level=complete&includeFullTrajectory=0`);
  await f.request(`${endpoint}&level=complete&includeFullTrajectory=1`);
  assert.deepEqual(await defaults(), warmed);
  assert.equal(f.graphExports(), exports, "switching profiles and polling unchanged evidence reuse the background calculations");
  const workspace = resolve(f.root, "projects", target.id, "sessions", sessionId, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "scratch.json"), JSON.stringify({ values: Array(100).fill(42) }));
  const changed = await defaults();
  assert.notEqual(changed.revision, warmed.revision);
  assert.ok(changed.complete.estimatedBytes > warmed.complete.estimatedBytes);
  assert.ok(changed.complete.files.some((file) => file.path === "scratch.json" && file.selected));
  const settled = f.graphExports();
  assert.deepEqual(await defaults(), changed);
  assert.equal(f.graphExports(), settled);
});

test("complete preview and download avoid aggregate record strings and retain imported trajectory details", async (context) => {
  const { request, project } = await fixture(context, true);
  const target = await project();
  const historical = researchTrajectoryFixture();
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(historical.bytes) });
  const stringify = JSON.stringify;
  JSON.stringify = ((value: unknown, replacer: never, space: never) => {
    if (value && typeof value === "object" && "sessions" in value && "artifacts" in value) throw new RangeError("Invalid string length");
    return stringify(value, replacer, space);
  }) as typeof JSON.stringify;
  let downloaded: Buffer;
  try {
    const preview = await (await request(`/api/projects/${target.id}/research-package/preview?sessionId=${target.firstSession.id}&level=complete`)).json() as { estimatedBytes: number; estimateKind: string };
    assert.equal(preview.estimateKind, "uncompressed");
    assert.ok(preview.estimatedBytes > 0);
    downloaded = Buffer.from(await (await request(`/api/projects/${target.id}/research-package?sessionId=${target.firstSession.id}&level=complete`)).arrayBuffer());
  } finally { JSON.stringify = stringify; }
  const exported = importResearchPackage(downloaded!);
  const records = exported.records as { sessions: Array<{ trajectory: { details: TrajectoryDetail[] } }> };
  assert.deepEqual(records.sessions[0]!.trajectory.details.map((detail) => detail.context?.input), historical.records.sessions[0]!.trajectory.details.map((detail) => detail.context?.input));
  const destination = await project();
  await request(`/api/projects/${destination.id}/research-package/import?sessionId=${destination.firstSession.id}`, { method: "POST", body: downloaded! });
  const trajectory = await (await request(`/api/sessions/${destination.firstSession.id}/trajectory`)).json() as TrajectoryIndex;
  for (const entry of trajectory.entries) {
    const detail = await (await request(`/api/sessions/${destination.firstSession.id}/trajectory/detail?id=${encodeURIComponent(entry.id)}`)).json() as TrajectoryDetail;
    assert.deepEqual(detail.context?.input, historical.records.sessions[0]!.trajectory.details[0]!.context?.input);
  }
});

function evidencePackage(legacy = false, withEvolve = false, withEvolveRuns = false, withEvolveCandidateSource = false) {
  const first = Buffer.from("value\n1\n");
  const latest = Buffer.from("value\n2\n");
  const notebook = Buffer.from('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}');
  const evolveSource = Buffer.from("print(1)\n");
  const evolveCandidateSource = Buffer.from("print('candidate source')\n");
  const version = (id: string, index: number, object: Buffer) => ({
    id, artifactId: "artifact-source", sessionId: "source-one", projectId: "source-project", version: index,
    createdAt: date, content: { hash: sha256(object), size: object.length }, mediaType: "text/csv", sourcePath: "results/result.csv",
    inputArtifactVersionIds: index === 2 ? ["version-one"] : [], executionRunIds: [], turnId: "run-source", ...(legacy ? {} : { objectPath: sha256(object) }),
  });
  return createResearchPackage({ source: { projectId: "source-project", title: "科研项目", sessionIds: ["source-one", "source-two"] }, records: {
    sessions: [{ session: { id: "source-one", title: "原始研究", specialistId: "unavailable-specialist" },
      messages: [{ id: "prompt-one", role: "user", content: "第一轮科研问题", createdAt: date }, { id: "answer-one", role: "assistant", content: "第一轮结论", createdAt: date }, { id: "prompt-two", role: "user", content: "第二轮科研问题", createdAt: date }, { id: "answer-two", role: "assistant", content: "第二轮结论", createdAt: date }],
      runs: [{ id: "run-source", sessionId: "source-one", prompt: "第一轮科研问题", createdAt: date, status: "running", queueOrder: 1, annotationIds: [], references: [], settingsSnapshot: {}, userMessageId: "prompt-one", assistantMessageId: "answer-one" }],
      workspace: [{ path: "results/result.csv", objectPath: sha256(latest), size: latest.length, modifiedAt: date }, { path: "analysis.ipynb", objectPath: sha256(notebook), size: notebook.length, modifiedAt: date }],
      validations: { reviews: [{ id: "review-source", sessionId: "source-one", kind: "integrity", status: "passed", turnId: "run-source", createdAt: date, finishedAt: date, findings: [] }], artifactReviews: [{ id: "artifact-review-source", sessionId: "source-one", artifactId: "artifact-source", artifactVersionId: "version-two", artifactContentHash: sha256(latest), artifactLogicalName: "results/result.csv", checkpointId: "checkpoint-source", decision: "ACCEPT_AND_PROCEED", createdAt: date, finishedAt: date, findings: [], reviewerSpecialistVersion: "1", status: "completed" }] },
    }, { session: { id: "source-two", title: "分支会话", specialistId: "unavailable-specialist" }, messages: [{ id: "branch-prompt", role: "user", content: "分支研究", createdAt: date }], workspace: [] }],
    // A package that really ran a search carries both the `evolve/<run>/` artifact
    // and the run records with their event log; only then is the "searches were not
    // carried" loss absent from the receipt.
    ...(withEvolveRuns ? { evolve: { runs: [{
      run: {
        id: "evolve-run-source", sessionId: "source-one", algorithm: "puct",
        goal: {
          algorithm: "puct",
          baselineProgramCas: "sha256:baseline",
          budget: { candidateTimeoutSeconds: 60, expansions: 6, maxCostCents: 500, maxSeconds: 1_800, maxTokens: 200_000, maxTokensPerCall: 16_000, workers: 1 },
          frozen: ["score.py"],
          modelId: "model-1",
          scorecard: { aggregate: "weighted_sum", confirmedAt: date, confirmedBy: "tester", constraints: [], criteria: [], derivedFrom: { draftRunId: "draft-1", statement: "Search for candidate genes" }, hash: "sha256:card", schemaVersion: 1, solvedThreshold: 0.999 },
          schemaVersion: 2,
          statement: "Search for candidate genes",
          target: { entrypoint: "classify.py", kind: "program", programId: "p1" },
        },
        status: "succeeded", startedAt: date, finishedAt: date, candidates: 2, costCents: 0, tokens: 0, createdAt: date,
      },
      events: [{ sequence: 1, createdAt: date, event: { type: "log", level: "info", message: "started" } }],
    }], ...(withEvolveCandidateSource ? { candidates: [{ runId: "evolve-run-source", hash: sha256(evolveCandidateSource), objectPath: sha256(evolveCandidateSource) }] } : {}) } } : {}),
    artifacts: [
      { id: "artifact-source", projectId: "source-project", createdInSessionId: "source-one", createdInSessionTitle: "原始研究", sessionId: "source-one", name: "results/result.csv", logicalName: "results/result.csv", kind: "dataset", origin: "user_upload", currentVersion: 2, createdAt: date, updatedAt: date, versions: [version("version-one", 1, first), version("version-two", 2, latest)] },
      // A run's result is published as `evolve/<run>/<entrypoint>` with
      // `kind: "other"` and `origin: "llm_declared"` (see `evolveArtifactName`
      // and the publisher in `bootstrap/platform.ts`); mirror that exactly or the
      // import rejects the kind as unsupported.
      ...(withEvolve ? [{
        id: "artifact-evolve", projectId: "source-project", createdInSessionId: "source-one",
        createdInSessionTitle: "原始研究", sessionId: "source-one", name: "evolve/83cbb6de/main.py",
        logicalName: "evolve/83cbb6de/main.py", kind: "other", origin: "llm_declared", currentVersion: 1,
        createdAt: date, updatedAt: date,
        versions: [{
          id: "version-evolve", artifactId: "artifact-evolve", sessionId: "source-one",
          projectId: "source-project", version: 1, createdAt: date,
          content: { hash: sha256(evolveSource), size: evolveSource.length },
          mediaType: "text/plain; charset=utf-8",
          sourcePath: "evolve/83cbb6de/main.py", inputArtifactVersionIds: [], executionRunIds: [],
          turnId: "run-source", ...(legacy ? {} : { objectPath: sha256(evolveSource) }),
        }],
      }] : []),
    ],
  }, objects: [first, latest, notebook, ...(withEvolve ? [evolveSource] : []), ...(withEvolveCandidateSource ? [evolveCandidateSource] : [])].map((bytes) => ({ path: sha256(bytes), bytes })) }).bytes;
}

test("complete package restores conversations, files, versions and reviews across projects without leaking into sibling sessions", async (context) => {
  const { rawRequest, request, project } = await fixture(context);
  const source = await project();
  const targetId = source.firstSession.id;
  assert.deepEqual(await (await request(`/api/sessions/${targetId}/research-package-import-eligibility`)).json(), { canImport: true });
  const receipt = await (await request(`/api/projects/${source.id}/research-package/import?sessionId=${targetId}`, { method: "POST", body: Buffer.from(evidencePackage()) })).json() as { importedSessionIds: string[]; artifactCount: number; omissions: string[] };
  assert.equal(receipt.artifactCount, 1);
  assert.equal(receipt.importedSessionIds.length, 2);
  assert.ok(receipt.omissions.some((item) => item.includes("no scientific memory snapshot")));
  const detail = await (await request(`/api/sessions/${targetId}`)).json() as { title: string; messages: { id: string; content: string }[] };
  assert.equal(detail.title, "原始研究");
  assert.deepEqual(detail.messages.map((item) => item.content), ["第一轮科研问题", "第一轮结论", "第二轮科研问题", "第二轮结论"]);
  assert.equal(await (await request(`/api/sessions/${targetId}/file?path=results%2Fresult.csv`)).text(), "value\n2\n");
  const runs = await (await request(`/api/sessions/${targetId}/runs`)).json() as { id: string; status: string; createdAt: string }[];
  assert.equal(runs[0]?.status, "cancelled"); assert.equal(runs[0]?.createdAt, date);
  const artifacts = await (await request(`/api/sessions/${targetId}/artifacts`)).json() as { id: string }[];
  const versions = await (await request(`/api/sessions/${targetId}/artifacts/${artifacts[0]!.id}/versions`)).json() as { id: string; inputArtifactVersionIds: string[] }[];
  assert.equal(versions.length, 2);
  assert.ok(versions.some((item) => item.inputArtifactVersionIds.length === 1));
  // The imported second session and a subsequently created empty session stay isolated.
  const sibling = receipt.importedSessionIds[1]!;
  assert.deepEqual(await (await request(`/api/sessions/${sibling}/artifacts`)).json(), []);
  assert.deepEqual(await (await request(`/api/sessions/${sibling}/files`)).json(), []);
  const empty = await (await request(`/api/projects/${source.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新建空会话" }) })).json() as { id: string };
  assert.deepEqual(await (await request(`/api/sessions/${empty.id}/artifacts`)).json(), []);
  assert.deepEqual(await (await request(`/api/sessions/${empty.id}/files`)).json(), []);
  const sameName = await (await request(`/api/projects/${source.id}/research-package/import?sessionId=${empty.id}`, { method: "POST", body: Buffer.from(evidencePackage()) })).json() as { artifactCount: number };
  assert.equal(sameName.artifactCount, 1);
  const renamedEmpty = await (await request(`/api/sessions/${empty.id}`)).json() as { title: string };
  assert.equal(renamedEmpty.title, "原始研究");
  const separateArtifacts = await (await request(`/api/sessions/${empty.id}/artifacts`)).json() as { id: string }[];
  assert.equal(separateArtifacts.length, 1);
  assert.notEqual(separateArtifacts[0]!.id, artifacts[0]!.id);
  // Export the live data, then import it into an entirely new project.
  const exported = Buffer.from(await (await request(`/api/projects/${source.id}/research-package?sessionId=${targetId}&level=complete`)).arrayBuffer());
  const exportedRecords = importResearchPackage(exported).records as { sessions: { validations: { artifactReviews: { artifactVersionId: string }[] } }[] };
  assert.ok(versions.some((item) => item.id === exportedRecords.sessions[0]?.validations.artifactReviews[0]?.artifactVersionId));
  const other = await project();
  const roundtrip = await (await request(`/api/projects/${other.id}/research-package/import?sessionId=${other.firstSession.id}`, { method: "POST", body: exported })).json() as { artifactCount: number };
  assert.equal(roundtrip.artifactCount, 1);
  const restored = await (await request(`/api/sessions/${other.firstSession.id}`)).json() as { messages: unknown[] };
  assert.equal(restored.messages.length, 4);
  assert.equal(await (await request(`/api/sessions/${other.firstSession.id}/file?path=results%2Fresult.csv`)).text(), "value\n2\n");
  const files = await (await request(`/api/sessions/${other.firstSession.id}/files`)).json() as { path: string }[];
  assert.ok(files.some((item) => item.path === "analysis.ipynb"));
  assert.deepEqual(await (await request(`/api/sessions/${targetId}/research-package-import-eligibility`)).json(), { canImport: false });
  const rejected = await rawRequest(`/api/projects/${source.id}/research-package/import?sessionId=${targetId}`, { method: "POST", body: Buffer.from(evidencePackage()) });
  assert.equal(rejected.status, 409);
  const custom = importResearchPackage(Buffer.from(await (await request(`/api/projects/${source.id}/research-package?sessionId=${targetId}&level=complete&customFiles=1&filePath=analysis.ipynb`)).arrayBuffer()));
  const customRecords = custom.records as { sessions: { workspace: { path: string }[] }[] };
  assert.deepEqual(customRecords.sessions[0]?.workspace.map((item) => item.path), ["analysis.ipynb"]);
  const preview = await (await request(`/api/projects/${source.id}/research-package/preview?sessionId=${targetId}&level=complete`)).json() as { estimatedBytes: number; files: unknown[] };
  assert.ok(preview.estimatedBytes > 0); assert.equal(preview.files.length, 2);
  const secondPrompt = detail.messages.find((message) => message.content === "第二轮科研问题")!;
  const markdown = await (await request(`/api/sessions/${targetId}/conversation-export?format=markdown&scope=custom&messageId=${encodeURIComponent(secondPrompt.id)}`)).text();
  assert.ok(markdown.includes("第二轮结论")); assert.ok(!markdown.includes("第一轮结论"));
});

test("a package carrying an evolve result reports that the searches themselves were not carried", async (context) => {
  // #1019: the gate is evidence-based, so this is the only shape that may report
  // the loss — and the receipt must actually receive the line, not just the
  // predicate returning true.
  const { request, project } = await fixture(context);
  const target = await project();
  const receipt = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(evidencePackage(false, true)),
  })).json() as { artifactCount: number; omissions: string[] };
  assert.equal(receipt.artifactCount, 2);
  assert.ok(receipt.omissions.some((item) => item.includes("does not carry evolution (evolve) search runs")),
    "the receipt names the searches it could not carry");
});

test("a package carrying the evolve runs and their artifact reports no search loss", async (context) => {
  // The import layer must agree with the predicate: a package that ran a search
  // AND carries the run records is restored, so the "searches were not carried"
  // omission is absent — this is the path #1019 review F1 found was never tested
  // at the import boundary.
  const { request, project, root } = await fixture(context);
  const target = await project();
  const receipt = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(evidencePackage(false, true, true)),
  })).json() as { artifactCount: number; omissions: string[] };
  assert.equal(receipt.artifactCount, 2);
  assert.equal(receipt.omissions.some((item) => item.includes("does not carry evolution (evolve) search runs")), false,
    "the carried run records make the search loss untrue");
  // The runs travel, but their candidate *sources* (`evolve-candidates/<run>/
  // <sha256>.py`) never enter the package, so a run that has candidates must
  // still be told it came back without their code.
  assert.ok(receipt.omissions.some((item) => item.includes("candidate source")),
    "the receipt names the candidate sources it could not carry");
  // The /api/evolve/runs route is gated on the external evolve service being
  // ready, which this fixture never provisions, so the restoration is read back
  // from the local EvolutionStore the import wrote it into.
  const restoredRun = JSON.parse(await readFile(resolve(root, "evolution", "runs", "evolve-run-source", "run.json"), "utf8")) as { sessionId: string };
  assert.equal(restoredRun.sessionId, target.firstSession.id, "the carried run is restored under the imported session");
});

test("a package carrying evolve candidate source restores it beside the imported run", async (context) => {
  const { request, project, root } = await fixture(context);
  const target = await project();
  const receipt = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(evidencePackage(false, true, true, true)),
  })).json() as { omissions: string[] };
  assert.equal(receipt.omissions.some((item) => item.includes("candidate source files are not carried")), false);
  const digest = sha256(Buffer.from("print('candidate source')\n")).replace(/^sha256:/, "");
  assert.equal(await readFile(resolve(root, "evolve-candidates", "evolve-run-source", `${digest}.py`), "utf8"), "print('candidate source')\n");
  const exported = importResearchPackage(new Uint8Array(await (await request(`/api/projects/${target.id}/research-package?sessionId=${target.firstSession.id}&level=complete`)).arrayBuffer()));
  const evolve = (exported.records as { evolve?: { candidates?: Array<{ hash: string; objectPath: string; runId: string }> } }).evolve;
  assert.deepEqual(evolve?.candidates, [{ hash: `sha256:${digest}`, objectPath: digest, runId: "evolve-run-source" }]);
  assert.equal(Buffer.from(exported.objects.get(digest)!).toString("utf8"), "print('candidate source')\n");
});

test("a package without an evolve artifact reports no such loss", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const receipt = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(evidencePackage()),
  })).json() as { omissions: string[] };
  assert.equal(receipt.omissions.some((item) => item.includes("does not carry evolution (evolve) search runs")), false,
    "a session that never ran a search must not report a loss that never happened");
});

test("legacy v1 packages restore CAS-backed artifact content without explicit objectPath", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const result = await (await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(evidencePackage(true)) })).json() as { artifactCount: number; omissions: string[] };
  assert.equal(result.artifactCount, 1); assert.ok(result.omissions.some((item) => item.includes("no scientific memory snapshot")));
});

test("invalid workspace destinations are rejected before a target session is changed", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const malicious = createResearchPackage({ source: { projectId: "bad", title: "Invalid paths" }, records: {
    sessions: [{ session: { id: "source" }, messages: [{ id: "bad-message", role: "user", content: "must not import", createdAt: date }], workspace: [{ path: "../../outside.txt", objectPath: sha256(Buffer.from("bad")), size: 3 }] }],
  }, objects: [{ path: sha256(Buffer.from("bad")), bytes: Buffer.from("bad") }] }).bytes;
  await assert.rejects(request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, {
    method: "POST", body: Buffer.from(malicious),
  }), /400/);
  const detail = await (await request(`/api/sessions/${target.firstSession.id}`)).json() as { messages: unknown[] };
  assert.deepEqual(detail.messages, []);
});

test("import restores provenance, task logs and graph routing through repeat export and API restart", async (context) => {
  const { request, project, snapshots, restart } = await fixture(context, true);
  const source = researchHistoryFixture();
  const target = await project();
  const importInto = async (projectId: string, sessionId: string, bytes: Uint8Array) => {
    const receipt = await (await request(`/api/projects/${projectId}/research-package/import?sessionId=${sessionId}`, { method: "POST", body: Buffer.from(bytes) })).json() as { omissions: string[] };
    assert.deepEqual(receipt.omissions, []);
  };
  const inspect = async (sessionId: string) => {
    // Listing reconciles physical mtime; it must not erase restored attribution.
    await request(`/api/sessions/${sessionId}/files`);
    const provenance = await (await request(`/api/sessions/${sessionId}/workspace/provenance?path=results%2Fverified.csv`)).json() as WorkspaceFileProvenance;
    assert.equal(provenance.revisions.length, 2);
    assert.equal(provenance.currentRevision.origin, "tool");
    assert.ok(provenance.currentRevision.executionRunId);
    assert.ok(provenance.revisions.some((row) => row.id === provenance.currentRevision.parentRevisionId));
    const versionId = provenance.currentRevision.artifactVersionIds[0]!;
    const artifacts = await (await request(`/api/sessions/${sessionId}/artifacts`)).json() as { id: string }[];
    const artifactId = artifacts[0]!.id;
    const artifact = await (await request(`/api/sessions/${sessionId}/artifact-versions/${versionId}/provenance`)).json() as ArtifactVersionProvenance;
    assert.equal(artifact.version.version, 4);
    assert.equal(artifact.code[0]?.code, "printf 'research-output-42\\n' > results/verified.csv");
    assert.equal(artifact.executionLog[0]?.stdout, "research-output-42\n");
    assert.equal(artifact.executionLog[0]?.stderr, "historical-warning\n");
    assert.deepEqual(artifact.executionLog[0]?.processEnvironment, { LANG: "C.UTF-8" });
    assert.equal(artifact.messages[0]?.content, "Imported evidence prompt visible in history");
    const activity = await (await request(`/api/sessions/${sessionId}/agent-activity`)).json() as { executions: AgentShellExecution[] };
    assert.equal(activity.executions.length, 1);
    assert.equal(activity.executions[0]?.state, "completed");
    const executionId = activity.executions[0]!.id;
    const logs = await (await request(`/api/sessions/${sessionId}/agent-activity/executions/${executionId}/logs`)).json() as { chunks: { text: string }[] };
    assert.equal(logs.chunks.map((chunk) => chunk.text).join(""), "research-output-42\nhistorical-warning\n");
    const runs = await (await request(`/api/sessions/${sessionId}/runs`)).json() as SessionRun[];
    const events = await (await request(`/api/sessions/${sessionId}/runs/${runs[0]!.id}/events`)).json() as SessionRunEvent[];
    assert.equal(events[0]?.createdAt, source.date); assert.equal(events[0]?.sequence, 3);
    const completed = events.find((row) => row.event.type === "tool.completed")!;
    assert.equal(completed.event.type, "tool.completed");
    if (completed.event.type !== "tool.completed") throw new Error("Missing completed tool trace");
    assert.equal(completed.event.trace.outputStream, `tool-${completed.event.trace.id}`);
    const output = await (await request(`/api/sessions/${sessionId}/runs/${runs[0]!.id}/streams/${completed.event.trace.outputStream}/events`)).json() as SessionRunEvent[];
    assert.equal(output[0]?.event.type, "tool.output");
    if (output[0]?.event.type !== "tool.output") throw new Error("Missing tool output");
    assert.equal(output[0].event.toolCallId, completed.event.trace.id);
    assert.equal(output[0].event.chunk, "research-output-42\n");
    const graph = snapshots.find((snapshot) => snapshot.nodes.some((node) => node.properties.session_id === sessionId))!;
    const code = graph.nodes.find((node) => node.labels.includes("Code"))!;
    assert.equal(code.properties.code_id, provenance.currentRevision.executionRunId);
    const node = graph.nodes.find((node) => node.labels.includes("Artifact"))!;
    assert.equal(node.properties.artifact_id, artifactId); assert.equal(node.properties.version, 4);
    const goal = graph.nodes.find((node) => node.labels.includes("ResearchGoal"))!;
    assert.equal(goal.properties.goal_id, `goal:session:${sessionId}`);
    return { artifactId, executionId, runId: runs[0]!.id };
  };
  await importInto(target.id, target.firstSession.id, source.bytes);
  const initial = await inspect(target.firstSession.id);
  await restart();
  assert.deepEqual(await inspect(target.firstSession.id), initial);
  for (const level of ["complete"]) {
    const exported = Buffer.from(await (await request(`/api/projects/${target.id}/research-package?sessionId=${target.firstSession.id}&level=${level}`)).arrayBuffer());
    const records = importResearchPackage(exported).records as { sessions: { runEvents: { streams: { streamId: string; events: unknown[] }[] }[] }[] };
    assert.equal(records.sessions[0]?.runEvents[0]?.streams.length, 2);
    const next = await project();
    const receipt = await (await request(`/api/projects/${next.id}/research-package/import?sessionId=${next.firstSession.id}`, { method: "POST", body: exported })).json() as { omissions: string[] };
    assert.ok(receipt.omissions.every((item) => item.includes("revision payloads") || item.includes("Notebook execution")), receipt.omissions.join("\n"));
    const restored = await inspect(next.firstSession.id);
    assert.notEqual(restored.artifactId, initial.artifactId);
    assert.notEqual(restored.executionId, initial.executionId);
    assert.notEqual(restored.runId, initial.runId);
  }
});

test("public chat branching preserves the selected prefix, evidence and immediate source across retries and restart", async (context) => {
  const { rawRequest, request, project, restart } = await fixture(context, true);
  const target = await project();
  const historical = researchTrajectoryFixture();
  const records = structuredClone(historical.records);
  const sourceRecord = records.sessions[0]!;
  const later = "2026-10-20T11:00:00.000Z";
  sourceRecord.messages.push({ id: "later-user", role: "user", content: "Later question", createdAt: later },
    { id: "later-assistant", role: "assistant", content: "Later response", createdAt: later });
  sourceRecord.runs.push({ ...sourceRecord.runs[0]!, id: "later-run", createdAt: later, finishedAt: later,
    userMessageId: "later-user", assistantMessageId: "later-assistant", queueOrder: 2 });
  sourceRecord.trajectory.runIds.push("later-run");
  const original = importResearchPackage(historical.bytes);
  const bytes = createResearchPackage({ source: original.manifest.source, records,
    objects: [...original.objects].map(([path, bytes]) => ({ path, bytes })) }).bytes;
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(bytes) });
  const snapshotId = target.firstSession.id;
  const continuation = await (await request(`/api/sessions/${snapshotId}/research-continuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "branch-from-writable-research-copy" }) })).json() as ResearchContinuationOperation;
  let writable = continuation;
  for (let attempt = 0; attempt < 100 && writable.state === "copying"; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    writable = await (await request(`/api/sessions/${snapshotId}/research-continuations/${continuation.id}`)).json() as ResearchContinuationOperation;
  }
  assert.equal(writable.state, "ready", writable.error ?? "Research continuation did not finish");
  const sourceId = writable.entrySessionId!;
  const detail = async (id: string) => await (await request(`/api/sessions/${id}`)).json() as SessionDetail;
  const source = await detail(sourceId);
  const messageId = source.messages[1]!.id;
  const start = async (sessionId: string, selected: string, requestId: string) => await (await request(`/api/sessions/${sessionId}/conversation-branches`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: selected, requestId }),
  })).json() as ResearchContinuationOperation;
  const wait = async (sourceId: string, operation: ResearchContinuationOperation) => {
    for (let attempt = 0; attempt < 100 && operation.state === "copying"; attempt++) {
      await new Promise((done) => setTimeout(done, 50));
      operation = await (await request(`/api/sessions/${sourceId}/research-continuations/${operation.id}`)).json() as ResearchContinuationOperation;
    }
    assert.equal(operation.state, "ready", operation.error ?? "Chat branch did not finish");
    assert.ok(operation.entrySessionId);
    return operation;
  };
  const rejected = await rawRequest(`/api/sessions/${sourceId}/conversation-branches`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: source.messages[0]!.id, requestId: "invalid-user-branch-request" }) });
  assert.equal(rejected.status, 409);
  const locked = await rawRequest(`/api/sessions/${snapshotId}/conversation-branches`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, requestId: "imported-snapshot-branch-rejected" }) });
  assert.equal(locked.status, 409);
  const [first, retry] = await Promise.all([start(sourceId, messageId, "chat-branch-retry-request"), start(sourceId, messageId, "chat-branch-retry-request")]);
  assert.equal(first.id, retry.id);
  const ready = await wait(sourceId, first);
  const branchId = ready.entrySessionId!;
  const branch = await detail(branchId);
  assert.deepEqual(branch.messages.map((row) => row.content), source.messages.slice(0, 2).map((row) => row.content));
  assert.notEqual(branch.messages[1]!.id, messageId);
  assert.equal(branch.conversationBranch?.sourceSessionId, sourceId);
  assert.equal(branch.conversationBranch?.sourceMessageId, messageId);
  assert.equal(branch.conversationBranch?.inheritedMessageId, branch.messages[1]!.id);
  assert.equal(branch.researchSnapshot?.role, "research_copy");
  assert.equal(branch.researchSnapshot?.state, "ready");
  assert.equal((await detail(sourceId)).messages.length, 4);
  assert.equal(await (await request(`/api/sessions/${branchId}/file?path=results%2Fverified.csv`)).text(), "value\n42\n");
  const artifacts = await (await request(`/api/sessions/${branchId}/artifacts`)).json() as { id: string }[];
  assert.equal(artifacts.length, 1);
  const trajectory = await (await request(`/api/sessions/${branchId}/trajectory`)).json() as TrajectoryIndex;
  assert.ok(trajectory.entries.some((entry) => entry.eventType === "context.captured"));
  await request(`/api/sessions/${branchId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Writable branch" }) });
  const next = await wait(branchId, await start(branchId, branch.messages[1]!.id, "chat-branch-of-branch-request"));
  assert.equal((await detail(next.entrySessionId!)).conversationBranch?.sourceSessionId, branchId);
  await restart();
  assert.deepEqual((await detail(branchId)).conversationBranch, branch.conversationBranch);
  const recovered = await start(sourceId, messageId, "chat-branch-retry-request");
  assert.equal(recovered.entrySessionId, branchId);
});

test("memory service failure retains a locked imported snapshot and disables continuation", async (context) => {
  const { request, rawRequest, project } = await fixture(context);
  const target = await project();
  const response = await rawRequest(`/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, { method: "POST", body: Buffer.from(researchHistoryFixture().bytes) });
  assert.equal(response.status, 201);
  const receipt = await response.json() as { continuationAvailable: boolean; omissions: string[] };
  assert.equal(receipt.continuationAvailable, false);
  assert.ok(receipt.omissions.some((item) => item.startsWith("Scientific memory restore failed")));
  const detail = await (await request(`/api/sessions/${target.firstSession.id}`)).json() as { messages: unknown[] };
  assert.equal(detail.messages.length, 2);
  const blocked = await rawRequest(`/api/sessions/${target.firstSession.id}/research-continuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "unrestored-memory-copy-denied" }) });
  assert.equal(blocked.status, 409);
});

test("necessary export keeps current evidence dependencies, reports omissions and preserves scope through continuation", async (context) => {
  const { request, project, restart } = await fixture(context, true);
  const source = researchTrajectoryFixture([{ path: "scratch.json", bytes: Buffer.from('{"obsolete":true}') }]);
  const records = structuredClone({ ...source.records, sessions: source.records.sessions.map((session) => ({ ...session,
    claims: [] as Claim[], evidenceItems: [] as EvidenceItem[], evidenceLinks: [] as EvidenceLink[],
    validations: { artifactReviews: [] as ArtifactReviewRun[] },
  })) });
  const session = records.sessions[0]!;
  const artifact = records.artifacts[0]!;
  const originalVersion = artifact.versions[0]!;
  const obsolete = Buffer.from("obsolete version\n");
  const input = Buffer.from("required input\n");
  const reviewEvidence = Buffer.from("validation evidence\n");
  const oldDate = "2026-10-01T00:00:00.000Z";
  artifact.versions = [
    { ...originalVersion, id: "obsolete-version", version: 1, executionRunIds: ["obsolete-exec"], inputArtifactVersionIds: [], turnId: "obsolete-turn", content: { hash: sha256(obsolete), size: obsolete.length }, objectPath: sha256(obsolete) },
    { ...originalVersion, id: "input-version", version: 2, inputArtifactVersionIds: [], content: { hash: sha256(input), size: input.length }, objectPath: sha256(input) },
    { ...originalVersion, id: "review-evidence-version", version: 3, inputArtifactVersionIds: [], content: { hash: sha256(reviewEvidence), size: reviewEvidence.length }, objectPath: sha256(reviewEvidence) },
    { ...originalVersion, inputArtifactVersionIds: ["input-version"] },
  ];
  session.validations.artifactReviews.push({ id: "latest-review", sessionId: "fixture-session", artifactId: artifact.id,
    artifactVersionId: originalVersion.id, artifactContentHash: originalVersion.content.hash, artifactLogicalName: artifact.logicalName,
    checkpointId: "review-checkpoint", decision: "ACCEPT_AND_PROCEED", createdAt: originalVersion.createdAt,
    finishedAt: originalVersion.createdAt, findings: [], reviewerSpecialistVersion: "1", status: "completed" });
  session.claims.push({ id: "review-claim", reviewRunId: "latest-review", sessionId: "fixture-session", turnId: "run-source", text: "The current result is supported by an earlier validation artifact." });
  session.evidenceLinks.push({ id: "review-evidence-link", claimId: "review-claim", evidenceItemId: "review-evidence", relation: "supports" });
  session.evidenceItems.push({ id: "review-evidence", sessionId: "fixture-session", turnId: "run-source", createdAt: originalVersion.createdAt,
    title: "Version referenced only by validation", origin: { kind: "artifact", artifactId: artifact.id, artifactVersion: 3 } });
  session.runs.unshift({ ...session.runs[0]!, id: "obsolete-turn", createdAt: oldDate, finishedAt: oldDate, queueOrder: 0 });
  session.trajectory.runIds.unshift("obsolete-turn");
  session.executionRuns.unshift({ ...session.executionRuns[0]!, id: "obsolete-exec", turnId: "obsolete-turn", startedAt: oldDate, finishedAt: oldDate });
  const importedSource = importResearchPackage(source.bytes);
  const bytes = createResearchPackage({ source: importedSource.manifest.source, records,
    objects: [...importedSource.objects].map(([path, bytes]) => ({ path, bytes })).concat([obsolete, input, reviewEvidence].map((bytes) => ({ path: sha256(bytes), bytes }))) }).bytes;
  const target = await project();
  const id = target.firstSession.id;
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${id}`, { method: "POST", body: Buffer.from(bytes) });
  const exportPath = `/api/projects/${target.id}/research-package`;
  const readPackage = async (level: string, selection = "") => importResearchPackage(Buffer.from(await (await request(`${exportPath}?sessionId=${id}&level=${level}${selection}`)).arrayBuffer()));
  const complete = await readPackage("complete");
  const necessary = await readPackage("necessary");
  const completeRecords = complete.records as typeof records;
  const selected = necessary.records as typeof records;
  assert.equal(completeRecords.artifacts[0]!.versions.length, 4);
  assert.deepEqual(selected.artifacts[0]!.versions.map((version) => version.version), [2, 3, 4]);
  assert.equal(selected.sessions[0]!.validations.artifactReviews.length, 1);
  assert.equal(selected.sessions[0]!.evidenceItems[0]!.origin.kind, "artifact");
  assert.deepEqual(necessary.objects.get(sha256(reviewEvidence)), new Uint8Array(reviewEvidence));
  assert.equal(necessary.objects.has(sha256(obsolete)), false, "unused artifact bytes must not leak into necessary exports");
  assert.deepEqual(selected.sessions[0]!.messages, completeRecords.sessions[0]!.messages);
  assert.equal(selected.sessions[0]!.executionRuns.length, 1);
  assert.equal(selected.sessions[0]!.workspaceProvenance[0]!.revisions.length, 1);
  assert.deepEqual(selected.sessions[0]!.runEvents, []);
  assert.deepEqual(selected.sessions[0]!.workspace.map((file) => file.path), ["results/verified.csv"]);
  assert.deepEqual(selected.sessions[0]!.trajectory.details[0]!.context?.input, source.input);
  assert.ok(selected.sessions[0]!.trajectory.details.every((detail) => detail.entry.kind !== "thinking"));
  assert.ok(completeRecords.sessions[0]!.trajectory.details.some((detail) => detail.entry.kind === "thinking"));
  const execution = selected.sessions[0]!.executionRuns[0]!;
  assert.deepEqual(necessary.objects.get(execution.code.hash), complete.objects.get(execution.code.hash));
  assert.deepEqual(necessary.objects.get(execution.stdout.hash), complete.objects.get(execution.stdout.hash));
  assert.equal(selected.memoryGraph.nodes.length, 4);
  assert.equal(necessary.manifest.exportProfile?.omitted.artifactVersions, 1);
  assert.equal(necessary.manifest.exportProfile?.omitted.workspaceFiles, 1);
  const preview = await (await request(`${exportPath}/preview?sessionId=${id}&level=necessary`)).json() as { files: Array<{ path: string; selected: boolean }>; exportProfile: ResearchPackageExportProfile };
  assert.deepEqual(preview.files.filter((file) => file.selected).map((file) => file.path), ["results/verified.csv"]);
  assert.deepEqual(preview.exportProfile, necessary.manifest.exportProfile);
  const emptySelection = (await readPackage("necessary", "&customFiles=1")).records as typeof records;
  assert.deepEqual(emptySelection.sessions[0]!.workspace, []);
  const custom = (await readPackage("necessary", "&customFiles=1&filePath=scratch.json")).records as typeof records;
  assert.deepEqual(custom.sessions[0]!.workspace.map((file) => file.path), ["scratch.json"]);
  const next = await project();
  const necessaryBytes = Buffer.from(await (await request(`${exportPath}?sessionId=${id}&level=necessary`)).arrayBuffer());
  const receipt = await (await request(`/api/projects/${next.id}/research-package/import?sessionId=${next.firstSession.id}`, { method: "POST", body: necessaryBytes })).json() as { continuationAvailable: boolean; exportProfile: ResearchPackageExportProfile };
  assert.equal(receipt.continuationAvailable, true);
  assert.equal(receipt.exportProfile.level, "necessary");
  await restart();
  const operation = await (await request(`/api/sessions/${next.firstSession.id}/research-continuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "necessary-scope-copy" }) })).json() as { id: string; state: string; entrySessionId?: string; error?: string };
  let completed = operation;
  for (let attempt = 0; attempt < 100 && completed.state === "copying"; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    completed = await (await request(`/api/sessions/${next.firstSession.id}/research-continuations/${operation.id}`)).json() as typeof operation;
  }
  assert.equal(completed.state, "ready", completed.error ?? "Research continuation did not finish");
  const copied = await (await request(`/api/sessions/${completed.entrySessionId}`)).json() as { researchSnapshot: { exportLevel: string; historyLimited: boolean }; messages: unknown[] };
  assert.equal(copied.researchSnapshot.exportLevel, "necessary");
  assert.equal(copied.researchSnapshot.historyLimited, true);
  assert.equal(copied.messages.length, session.messages.length);
});

test("imported trajectory retains exact input and complete reasoning after restart, export and continuation", async (context) => {
  const { request, project, restart } = await fixture(context, true);
  const source = researchTrajectoryFixture();
  const target = await project();
  const sessionId = target.firstSession.id;
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${sessionId}`, { method: "POST", body: Buffer.from(source.bytes) });
  const inspect = async (id: string) => {
    const index = await (await request(`/api/sessions/${id}/trajectory`)).json() as TrajectoryIndex;
    assert.equal(index.entries.length, 2, "restored run streams must not duplicate the archived evidence");
    assert.deepEqual(index.warnings, []);
    for (const entry of index.entries) {
      assert.equal(entry.agentId, `main:${id}`);
      const detail = await (await request(`/api/sessions/${id}/trajectory/detail?id=${encodeURIComponent(entry.id)}`)).json() as TrajectoryDetail;
      assert.deepEqual(detail.context?.input, source.input);
      if (entry.kind === "thinking") {
        const value = detail.value as { packets: { event: { delta: string } }[] };
        assert.equal(value.packets.map((packet) => packet.event.delta).join(""), source.thinking);
      }
    }
    const exported = await (await request(`/api/sessions/${id}/trajectory/export`)).text();
    assert.ok(exported.includes("END_OF_IMPORTED_THINKING"));
    assert.equal(JSON.parse(exported.trim().split("\n").at(-1)!).type, "complete");
  };
  await inspect(sessionId);
  await restart();
  await inspect(sessionId);
  const exported = await (await request(`/api/projects/${target.id}/research-package?sessionId=${sessionId}&level=complete`)).arrayBuffer();
  const next = await project();
  await request(`/api/projects/${next.id}/research-package/import?sessionId=${next.firstSession.id}`, { method: "POST", body: Buffer.from(exported) });
  await inspect(next.firstSession.id);
  const operation = await (await request(`/api/sessions/${sessionId}/research-continuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "trajectory-copy-regression" }) })).json() as { entrySessionId?: string; state: string; id: string };
  let completed = operation;
  for (let attempt = 0; attempt < 100 && completed.state === "copying"; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    completed = await (await request(`/api/sessions/${sessionId}/research-continuations/${operation.id}`)).json() as typeof operation;
  }
  assert.equal(completed.state, "ready");
  await inspect(completed.entrySessionId!);
});

test("a finished continuation stays readable after its source session is deleted, and a mismatched source is 404", async (context) => {
  const { rawRequest, request, project } = await fixture(context, true);
  const target = await project();
  const source = researchTrajectoryFixture();
  const sourceId = target.firstSession.id;
  await request(`/api/projects/${target.id}/research-package/import?sessionId=${sourceId}`, { method: "POST", body: Buffer.from(source.bytes) });
  const operation = await (await request(`/api/sessions/${sourceId}/research-continuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "delete-source-after-copy" }) })).json() as ResearchContinuationOperation;
  let last = operation;
  for (let attempt = 0; attempt < 100 && last.state === "copying"; attempt++) {
    await new Promise((done) => setTimeout(done, 50));
    last = await (await request(`/api/sessions/${sourceId}/research-continuations/${operation.id}`)).json() as ResearchContinuationOperation;
  }
  assert.equal(last.state, "ready", last.error ?? "Research continuation did not finish");
  assert.ok(last.entrySessionId);
  // A mismatched source id is a 404: the status route checks the operation's own source id.
  const mismatched = await rawRequest(`/api/sessions/not-the-source/research-continuations/${operation.id}`);
  assert.equal(mismatched.status, 404);
  // The source session may be gone; the durable operation must stay readable.
  await request(`/api/sessions/${sourceId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationId: sourceId }) });
  const afterDelete = await (await request(`/api/sessions/${sourceId}/research-continuations/${operation.id}`)).json() as ResearchContinuationOperation;
  assert.equal(afterDelete.state, "ready");
  assert.equal(afterDelete.id, operation.id);
  assert.equal(afterDelete.entrySessionId, last.entrySessionId);
});
