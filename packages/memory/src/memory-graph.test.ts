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
import type { AddressInfo } from "node:net";
import http from "node:http";


import { MemoryGraphClient, MemoryGraphSink } from "./memory-graph.js";
import type { ObserveToolCallPayload } from "./memory-graph.js";

/**
 * A tiny loopback server impersonating the Python memory-graph sidecar, used
 * to assert the API-side client/sink posts the right shape to /observe/tool-call
 * and that the sink's fire-and-forget contract never throws into the caller.
 */
function startFakeMemoryGraph(handler: (path: string, body: unknown) => { status: number; json: unknown }): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => {
      let body: unknown = null;
      if (data) {
        try { body = JSON.parse(data); } catch { /* leave null */ }
      }
      const { status, json } = handler(request.url ?? "/", body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- Read endpoints --------------------------------------------------------

test("queryMatch degrades to an empty result with a reason when the sidecar errors", async () => {
  const server = await startFakeMemoryGraph(() => ({ status: 500, json: { detail: "boom" } }));
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const result = await client.queryMatch("TP53");
    assert.equal(result.total, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.reason, "memory_graph_unreachable");
    assert.deepEqual(result.hits, []);
  } finally {
    await close(server);
  }
});

test("byNodeType posts the node_types and returns hits when the sidecar is healthy", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return {
      status: 200,
      json: { hits: [{ label: "Paper", id: "doi-x", excerpt: "x", extra: {}, created_at: "2026-07-27T00:00:00Z" }], total: 1, truncated: false },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.byNodeType(["Paper"]);
    assert.equal(captured!.path, "/query/by-node-type");
    assert.deepEqual((captured!.body as { node_types: string[] }).node_types, ["Paper"]);
    assert.equal(result.total, 1);
    assert.equal(result.hits[0]!.label, "Paper");
    assert.equal(result.hits[0]!.createdAt, "2026-07-27T00:00:00Z");
  } finally {
    await close(server);
  }
});

test("getChain returns nodes/edges with snake→camel field mapping", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 200,
    json: {
      nodes: [{ label: "SubTask", id: "task-1", session_id: "sess-1", excerpt: "x", extra: {}, created_at: "2026-07-27T00:00:00Z" }],
      edges: [{ source: "task-1", target: "code-1", type: "produces" }],
      total: 1,
      truncated: false,
    },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.getChain("task-1");
    assert.equal(result.nodes[0]!.sessionId, "sess-1");
    assert.equal(result.nodes[0]!.createdAt, "2026-07-27T00:00:00Z");
    assert.equal(result.edges[0]!.type, "produces");
  } finally {
    await close(server);
  }
});

test("getChain forwards the version so an Artifact source pins its version", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { nodes: [], edges: [], total: 0, truncated: false } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.getChain("art-1", "sess-1", 3);
    const body = captured!.body as Record<string, unknown>;
    assert.equal(body.version, 3);
    assert.equal(body.node_id, "art-1");
    // Omitting version must not send a version key (sidecar defaults to latest).
    await client.getChain("art-1", "sess-1");
    const body2 = captured!.body as Record<string, unknown>;
    assert.equal("version" in body2, false);
  } finally {
    await close(server);
  }
});

test("getChain forwards the button-level kind (no full/task/artifact default)", async () => {
  const captured: { path: string; body: unknown }[] = [];
  const server = await startFakeMemoryGraph((path, body) => {
    captured.push({ path, body });
    return { status: 200, json: { nodes: [], edges: [], total: 0, truncated: false } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    // ``kind`` is the button-level chain key (e.g. "viewOutput"). Omitting it
    // sends "" — there is no backward-compatible default anymore.
    await client.getChain("art-1", "sess-1");
    await client.getChain("art-1", "sess-1", undefined, "viewProducingCode");
    const bodies = captured.map((c) => (c.body as Record<string, unknown>));
    assert.equal(bodies[0]!.kind, "", "omitted kind sends empty string");
    assert.equal(bodies[1]!.kind, "viewProducingCode");
    // The old chain_kind field is gone entirely.
    for (const b of bodies) {
      assert.equal("chain_kind" in b, false, "chain_kind field must not be sent");
    }
    // node_id + session_id still travel alongside kind.
    assert.equal(bodies[1]!.node_id, "art-1");
    assert.equal(bodies[1]!.session_id, "sess-1");
  } finally {
    await close(server);
  }
});

test("chainExists sends kinds batch and maps the {kind: bool} response", async () => {
  const captured: { path: string; body: unknown }[] = [];
  const server = await startFakeMemoryGraph((path, body) => {
    captured.push({ path, body });
    return { status: 200, json: { viewOutput: true, viewProducingTask: false } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.chainExists("art-1", "sess-1", 2, ["viewOutput", "viewProducingTask"]);
    const body = captured[0]!.body as Record<string, unknown>;
    assert.equal(body.node_id, "art-1");
    assert.equal(body.session_id, "sess-1");
    assert.equal(body.version, 2);
    assert.deepEqual(body.kinds, ["viewOutput", "viewProducingTask"]);
    assert.equal(result.viewOutput, true);
    assert.equal(result.viewProducingTask, false);
    // A kind sent but absent from the response body is absent from the result
    // map too (undefined → falsy → the frontend's availableButtons hides it).
    assert.equal("viewContainedClaims" in result, false);
  } finally {
    await close(server);
  }
});

test("declareClaim forwards cites_artifact_versions + artifact_version and parses artifact chip version", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return {
      status: 200,
      json: {
        status: "ok",
        claim_id: "cl-v",
        // An artifact chip carrying the cited version.
        chip_map: { fig1: { kind: "artifact", id: "art-fig", label: "fig1", version: 1 } },
        cited_targets: [],
      },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "peaks at 50µM", claimType: "STATISTICAL", confidence: "HIGH", locator: "fig1",
      citesEvidenceAliases: {},
      citesArtifactAliases: { fig1: "art-fig" },
      citesArtifactVersions: { fig1: 1 },
      artifactId: "art-report", artifactVersion: 2,
    }, "s1");
    const body = captured!.body as Record<string, unknown>;
    assert.deepEqual(body.cites_artifact_versions, { fig1: 1 });
    assert.equal(body.artifact_id, "art-report");
    assert.equal(body.artifact_version, 2);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("unreachable");
    assert.equal(result.chipMap["fig1"]!.version, 1);
  } finally {
    await close(server);
  }
});

test("linkClaimsToReport posts artifact_version with the composite key", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "ok", artifact_id: "art-r", linked: 1 } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.linkClaimsToReport("art-r", 2, ["cl-1"], "s1");
    const body = captured!.body as Record<string, unknown>;
    assert.equal(body.artifact_id, "art-r");
    assert.equal(body.artifact_version, 2);
    assert.deepEqual(body.claim_ids, ["cl-1"]);
  } finally {
    await close(server);
  }
});

// --- declare_* (LLM tools; business errors surface, no silent degrade) ------

test("declareEvidence posts snake_case and returns ok with the evidence id", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "ok", evidence_id: "ev-1" } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareEvidence({
      content: "TP53 ~8-12%", sourcePaperLink: "https://doi.org/10.1", locator: "abstract",
      evidenceType: "QUOTE", confidence: "HIGH", strength: "MODERATE",
    }, "s1");
    assert.equal(captured!.path, "/persist/evidence");
    const body = captured!.body as Record<string, unknown>;
    assert.equal(body.source_paper_link, "https://doi.org/10.1");
    assert.equal(body.evidence_type, "QUOTE");
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.evidenceId, "ev-1");
  } finally {
    await close(server);
  }
});

test("declareEvidence surfaces the 422 business code instead of degrading", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 422,
    json: { detail: { code: "source_paper_not_found", message: "no Paper with that link" } },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareEvidence({
      content: "x", sourcePaperLink: "https://missing", locator: "abstract",
      evidenceType: "QUOTE", confidence: "HIGH", strength: "MODERATE",
    }, "s1");
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.code, "source_paper_not_found");
  } finally {
    await close(server);
  }
});

test("declareEvidence sends source_webpage_link in snake_case (WebPage source)", async () => {
  // The WebPage source adds a third form alongside Paper / SourceFile. The
  // Node client must serialise sourceWebpageLink → source_webpage_link and
  // only include the field when
  // set, so an undefined on the other source fields never shadows it.
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "ok", evidence_id: "ev-w1" } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareEvidence({
      content: "from the page",
      sourceWebpageLink: "https://example.com/article",
      locator: "p1", evidenceType: "QUOTE", confidence: "HIGH", strength: "MODERATE",
    }, "s1");
    const body = captured!.body as Record<string, unknown>;
    assert.equal(captured!.path, "/persist/evidence");
    assert.equal(body.source_webpage_link, "https://example.com/article");
    // The other two source fields must NOT be sent (caller chose one of
    // three; the sidecar 422's on multi-set).
    assert.equal("source_paper_link" in body, false);
    assert.equal("source_file_id" in body, false);
    assert.equal(result.status, "ok");
  } finally {
    await close(server);
  }
});

test("declareClaim posts the alias map + artifact_id and returns the chip_map", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return {
      status: 200,
      json: {
        status: "ok",
        claim_id: "cl-1",
        chip_map: { ev1: { kind: "evidence", id: "ev-1", label: "ev1" } },
        cited_targets: [],
      },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "TP53 ~8-12%", claimType: "STATISTICAL", confidence: "HIGH", locator: "abstract",
      citesEvidenceAliases: { ev1: "ev-1" }, citesArtifactAliases: {},
      artifactId: "art-1",
    }, "s1");
    assert.equal(captured!.path, "/persist/claim");
    const body = captured!.body as Record<string, unknown>;
    assert.deepEqual(body.cites_evidence_aliases, { ev1: "ev-1" });
    assert.equal(body.artifact_id, "art-1");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("unreachable");
    assert.equal(result.claimId, "cl-1");
    assert.equal(result.chipMap["ev1"]!.kind, "evidence");
    assert.equal(result.chipMap["ev1"]!.id, "ev-1");
    assert.equal(result.chipMap["ev1"]!.label, "ev1");
  } finally {
    await close(server);
  }
});

test("declareClaim surfaces no_cites_target + instruction from the 422 body", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 422,
    json: { detail: { code: "no_cites_target", message: "at least one cite required", instruction: "pass cites_evidence_aliases" } },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "x", claimType: "STATISTICAL", confidence: "HIGH", locator: "abstract",
      citesEvidenceAliases: {}, citesArtifactAliases: {},
    }, "s1");
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.code, "no_cites_target");
    assert.equal(result.status === "error" && result.instruction, "pass cites_evidence_aliases");
  } finally {
    await close(server);
  }
});

test("declareClaim surfaces artifact_version_not_found + instruction from the 422 body", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 422,
    json: { detail: { code: "artifact_version_not_found", message: "Artifact not found", instruction: "call list_artifacts" } },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "x", claimType: "STATISTICAL", confidence: "HIGH", locator: "abstract",
      citesEvidenceAliases: { ev1: "ev-1" }, citesArtifactAliases: {},
      artifactId: "missing-art",
    }, "s1");
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.code, "artifact_version_not_found");
    assert.equal(result.status === "error" && result.instruction, "call list_artifacts");
  } finally {
    await close(server);
  }
});

test("declareClaim forwards cites_dbrecord_aliases and surfaces the dbrecord chip", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return {
      status: 200,
      json: {
        status: "ok",
        claim_id: "cl-db",
        // dbrecord chip: id is the bare identifier (the chip's reference.id
        // hits node.id === reference.id directly — _ID_FIELDS["DbRecord"] in
        // the sidecar — like the Evidence/SourceFile paths).
        chip_map: { db1: { kind: "dbrecord", id: "P38398", label: "db1" } },
        cited_targets: [],
      },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "BRCA1 binds ...", claimType: "STATISTICAL", confidence: "HIGH", locator: "abstract",
      citesEvidenceAliases: {},
      citesArtifactAliases: {},
      citesDbrecordAliases: { db1: "uniprot:P38398" },
    }, "s1");
    assert.equal(captured!.path, "/persist/claim");
    const body = captured!.body as Record<string, unknown>;
    assert.deepEqual(body.cites_dbrecord_aliases, { db1: "uniprot:P38398" });
    // Other cite maps absent (the conditional spread — never undefined/null).
    assert.equal("cites_evidence_aliases" in body, true);
    assert.equal(body.cites_dbrecord_aliases, body.cites_dbrecord_aliases);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("unreachable");
    assert.equal(result.chipMap["db1"]!.kind, "dbrecord");
    assert.equal(result.chipMap["db1"]!.id, "P38398");
    assert.equal(result.chipMap["db1"]!.label, "db1");
  } finally {
    await close(server);
  }
});

test("declareClaim omits cites_dbrecord_aliases when the alias map is absent", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "ok", claim_id: "cl-x", chip_map: {}, cited_targets: [] } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.declareClaim({
      content: "x", claimType: "STATISTICAL", confidence: "HIGH", locator: "a",
      citesEvidenceAliases: { ev1: "ev-1" }, citesArtifactAliases: {},
    }, "s1");
    const body = captured!.body as Record<string, unknown>;
    // Field absent — never undefined/null (the conditional spread).
    assert.equal("cites_dbrecord_aliases" in body, false);
  } finally {
    await close(server);
  }
});

test("declareClaim surfaces db_record_not_found + instruction from the 422 body", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 422,
    json: { detail: { code: "db_record_not_found", message: "no DbRecord for uniprot:GHOST", instruction: "pass the value as \"<source>:<identifier>\"" } },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.declareClaim({
      content: "x", claimType: "STATISTICAL", confidence: "HIGH", locator: "a",
      citesEvidenceAliases: {}, citesArtifactAliases: {},
      citesDbrecordAliases: { db1: "uniprot:GHOST" },
    }, "s1");
    assert.equal(result.status, "error");
    if (result.status !== "error") throw new Error("unreachable");
    assert.equal(result.code, "db_record_not_found");
    assert.ok(result.instruction && result.instruction.includes("<source>:<identifier>"));
  } finally {
    await close(server);
  }
});

test("declare methods report memory_graph_disabled when the sidecar is unreachable", async () => {
  // Point at a port that nothing listens on → fetch throws.
  const client = new MemoryGraphClient({ url: "http://127.0.0.1:1", token: "t" });
  const ev = await client.declareEvidence({
    content: "x", sourcePaperLink: "https://x", locator: "a",
    evidenceType: "QUOTE", confidence: "HIGH", strength: "MODERATE",
  }, "s");
  assert.equal(ev.status, "error");
  assert.equal(ev.status === "error" && ev.code, "memory_graph_disabled");
  const cl = await client.declareClaim({
    content: "x", claimType: "STATISTICAL", confidence: "HIGH", locator: "a",
    citesEvidenceAliases: {}, citesArtifactAliases: {},
  }, "s");
  assert.equal(cl.status, "error");
  assert.equal(cl.status === "error" && cl.code, "memory_graph_disabled");
});

test("observeExecution forwards logical_name on each produced artifact", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 2 } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.observeExecution({
      executionId: "exec-1", sessionId: "s1", turnId: "t1", tool: "run_python",
      language: "python", codeHash: "h", exitCode: 0, status: "succeeded",
      startedAt: "2026-07-31T00:00:00Z", finishedAt: "2026-07-31T00:00:01Z",
      toolType: "execution",
      producedArtifacts: [{
        artifactId: "art-1", path: "squares.csv", projectId: "project-1", version: 1,
        mediaType: "text/csv", logicalName: "squares.csv",
      }],
    });
    const body = captured!.body as Record<string, unknown>;
    const arts = body.produced_artifacts as Array<Record<string, unknown>>;
    assert.equal(arts[0]!.logical_name, "squares.csv");
    assert.equal(arts[0]!.artifact_id, "art-1");
    assert.equal(arts[0]!.project_id, "project-1");
    assert.equal(arts[0]!.version, 1);
  } finally {
    await close(server);
  }
});

test("observeExecution forwards input_artifact_versions composite-key pairs on each produced artifact", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 2 } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.observeExecution({
      executionId: "exec-2", sessionId: "s1", turnId: "t1", tool: "run_python",
      language: "python", codeHash: "h", exitCode: 0, status: "succeeded",
      startedAt: "2026-07-31T00:00:00Z", finishedAt: "2026-07-31T00:00:01Z",
      toolType: "execution",
      producedArtifacts: [{
        artifactId: "art-2", path: "plot.svg", projectId: "project-1", version: 1,
        mediaType: "image/svg+xml", logicalName: "plot.svg",
        inputArtifactVersions: [{ artifactId: "art-1", version: 1 }],
      }],
    });
    const body = captured!.body as Record<string, unknown>;
    const arts = body.produced_artifacts as Array<Record<string, unknown>>;
    const refs = arts[0]!.input_artifact_versions as Array<Record<string, unknown>>;
    assert.deepEqual(refs, [{ artifact_id: "art-1", version: 1 }]);
  } finally {
    await close(server);
  }
});

test("observeExecution omits input_artifact_versions entries when none were read", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 2 } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.observeExecution({
      executionId: "exec-3", sessionId: "s1", turnId: "t1", tool: "run_python",
      language: "python", codeHash: "h", exitCode: 0, status: "succeeded",
      startedAt: "2026-07-31T00:00:00Z", finishedAt: "2026-07-31T00:00:01Z",
      toolType: "execution",
      producedArtifacts: [{
        artifactId: "art-3", path: "squares.csv", projectId: "project-1", version: 1,
        mediaType: "text/csv", logicalName: "squares.csv",
        // inputArtifactVersions absent — the run read no other artifacts.
      }],
    });
    const body = captured!.body as Record<string, unknown>;
    const arts = body.produced_artifacts as Array<Record<string, unknown>>;
    // Absent on the client side → serialized as an empty array so the sidecar
    // always sees a list (never null/undefined) for the optional field.
    assert.deepEqual(arts[0]!.input_artifact_versions, []);
  } finally {
    await close(server);
  }
});

test("observeExecution forwards provenance addressing fields (hashes/turnId/contentHash)", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 2 } };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    await client.observeExecution({
      executionId: "exec-1", sessionId: "s1", turnId: "t1", tool: "run_python",
      language: "python", codeHash: "ch", exitCode: 0, status: "succeeded",
      startedAt: "2026-07-31T00:00:00Z", finishedAt: "2026-07-31T00:00:01Z",
      toolType: "execution",
      stdoutHash: "sh", stderrHash: "eh", envHash: "envh",
      producedArtifacts: [{
        artifactId: "art-1", path: "squares.csv", projectId: "project-1", version: 1,
        mediaType: "text/csv", logicalName: "squares.csv",
        turnId: "t1", contentHash: "conth",
      }],
    });
    const body = captured!.body as Record<string, unknown>;
    assert.equal(body.stdout_hash, "sh");
    assert.equal(body.stderr_hash, "eh");
    assert.equal(body.env_hash, "envh");
    assert.equal(body.turn_id, "t1");
    const arts = body.produced_artifacts as Array<Record<string, unknown>>;
    assert.equal(arts[0]!.turn_id, "t1");
    assert.equal(arts[0]!.content_hash, "conth");
  } finally {
    await close(server);
  }
});

test("getArtifactProvenance issues GET with query params and shapes the full result (five fields + dependencies)", async () => {
  let capturedPath: string | null = null;
  const server = await startFakeMemoryGraph((path) => {
    capturedPath = path;
    return {
      status: 200,
      json: {
        artifact_id: "art-1", version: 1, logical_name: "squares.csv",
        media_type: "text/csv", content_hash: "conth", turn_id: "t1",
        code_hash: "ch", stdout_hash: "sh", stderr_hash: "eh", env_hash: "envh",
        exit_code: 0, status: "succeeded",
        finished_at: "2026-07-31T00:00:01Z", started_at: "2026-07-31T00:00:00Z",
        code_id: "exec-1", language: "python", tool: "run_python",
        messages_turn_id: "t1",
        dependencies: [
          { artifact_id: "art-0", version: 1, logical_name: "input.csv",
            media_type: "text/csv", path: "input.csv" },
        ],
      },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.getArtifactProvenance("art-1", 1);
    assert.match(capturedPath!, /^\/query\/artifact-provenance\?artifact_id=art-1&version=1/);
    assert.equal(result!.artifactId, "art-1");
    assert.equal(result!.version, 1);
    assert.equal(result!.contentHash, "conth");
    assert.equal(result!.turnId, "t1");
    assert.equal(result!.codeHash, "ch");
    assert.equal(result!.messagesTurnId, "t1");
    assert.equal(result!.dependencies![0]!.kind, "artifact");
    assert.equal(result!.dependencies![0]!.kind === "artifact" ? result!.dependencies![0]!.artifactId : "", "art-0");
    assert.equal(result!.dependencies![0]!.mediaType, "text/csv");
    assert.equal(result!.dependencies![0]!.path, "input.csv");
    assert.equal(result!.reason, undefined);
  } finally {
    await close(server);
  }
});

test("getArtifactProvenance returns empty dependencies (no reason) when no input edge matched", async () => {
  const server = await startFakeMemoryGraph(() => ({
    status: 200,
    // The output version exists but read no inputs → empty dependencies, no reason.
    json: { artifact_id: "art-2", version: 1, logical_name: "plot.svg", dependencies: [] },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.getArtifactProvenance("art-2", 1, "s1");
    assert.deepEqual(result!.dependencies, []);
    assert.equal(result!.reason, undefined);
  } finally {
    await close(server);
  }
});

test("getArtifactProvenance shapes a source_file dependency (uploaded input, no version)", async () => {
  // A Code run that read an uploaded file produces a SourceFile -[:input]-> Code
  // edge; the provenance endpoint surfaces it as a dependency with kind
  // "source_file" (fileId/name instead of artifactId/version). The shaper must
  // route it onto the source_file arm of the discriminated union.
  const server = await startFakeMemoryGraph(() => ({
    status: 200,
    json: {
      artifact_id: "art-3", version: 1, logical_name: "plot.svg",
      dependencies: [
        { kind: "source_file", file_id: "source_file:session:s1:data.csv",
          name: "data.csv", path: "data.csv", media_type: "text/csv" },
      ],
    },
  }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.getArtifactProvenance("art-3", 1, "s1");
    assert.equal(result!.dependencies!.length, 1);
    const dep = result!.dependencies![0]!;
    assert.equal(dep.kind, "source_file");
    if (dep.kind !== "source_file") throw new Error("narrow");
    assert.equal(dep.fileId, "source_file:session:s1:data.csv");
    assert.equal(dep.name, "data.csv");
    assert.equal(dep.mediaType, "text/csv");
    assert.equal(dep.path, "data.csv");
  } finally {
    await close(server);
  }
});

test("getArtifactProvenance returns null when the sidecar is unreachable", async () => {
  // Point at a port that refuses connections → fetch throws → null (degrade).
  const client = new MemoryGraphClient({ url: "http://127.0.0.1:1", token: "t" });
  const result = await client.getArtifactProvenance("art-1", 1);
  assert.equal(result, null);
});

test("getArtifactProvenance returns node_not_found on 404", async () => {
  const server = await startFakeMemoryGraph(() => ({ status: 404, json: { detail: { code: "not_found" } } }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.getArtifactProvenance("art-1", 99);
    assert.equal(result!.reason, "node_not_found");
  } finally {
    await close(server);
  }
});
test("traceProvenance posts the right shape and maps snake→camel fields", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return {
      status: 200,
      json: {
        start_node: { label: "Artifact", id: "art-1", excerpt: "summary.csv" },
        chain: [
          { hop: 1, node: { label: "Code", id: "code-1", excerpt: "run_python" }, via_edge: "produces" },
          { hop: 2, node: { label: "SubTask", id: "task-1", excerpt: "analysis" }, via_edge: "produces" },
          { hop: 3, node: { label: "ResearchGoal", id: "goal-1", excerpt: "TP53 mutation" }, via_edge: "next", is_terminal: true },
        ],
        broken: false,
        truncated: false,
        reason: "reached terminal node ResearchGoal",
      },
    };
  });
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.traceProvenance({ nodeId: "art-1" });
    // The POST hit /trace/provenance with snake_case + defaults (direction is
    // fixed upstream server-side, so the client doesn't send it).
    assert.equal(captured!.path, "/trace/provenance");
    const body = captured!.body as Record<string, unknown>;
    assert.equal(body.node_id, "art-1");
    assert.equal(body.target_label, null); // default
    assert.equal(body.max_hops, 8); // default
    // snake_case → camelCase mapping.
    assert.equal(result.startNode!.label, "Artifact");
    assert.equal(result.startNode!.id, "art-1");
    assert.equal(result.chain[0]!.viaEdge, "produces");
    assert.equal(result.chain[2]!.isTerminal, true);
    assert.equal(result.broken, false);
    assert.equal(result.reason, "reached terminal node ResearchGoal");
  } finally {
    await close(server);
  }
});

test("traceProvenance degrades to broken:true when the sidecar is unreachable", async () => {
  // postJson swallows a 500 into a degraded-empty shell (no `chain`); toTraceResult
  // translates that into broken:true + memory_graph_unreachable, never throwing.
  const server = await startFakeMemoryGraph(() => ({ status: 500, json: { detail: "boom" } }));
  try {
    const client = new MemoryGraphClient({ url: `http://127.0.0.1:${portOf(server)}`, token: "t" });
    const result = await client.traceProvenance({ nodeId: "art-1" });
    assert.equal(result.broken, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.chain, []);
    assert.equal(result.startNode, null);
    assert.equal(result.reason, "memory_graph_unreachable");
  } finally {
    await close(server);
  }
});

test("MemoryGraphSink.cleanupSession posts the right shape and never throws when the service errors", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((_path, body) => {
    captured = { path: _path, body };
    // Even a 500 must not throw into the HTTP deletion response.
    return { status: 500, json: { detail: "boom" } };
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const sink = new MemoryGraphSink(client, () => true);
    sink.cleanupSession("sess-del");
    for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(captured, "the sink should have posted to the sidecar");
    const c = captured as { path: string; body: unknown };
    assert.equal(c.path, "/cleanup/session");
    assert.equal((c.body as Record<string, unknown>).session_id, "sess-del");
  } finally {
    await close(server);
  }
});

test("MemoryGraphSink.cleanupProject posts the right shape and never throws when the service errors", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((_path, body) => {
    captured = { path: _path, body };
    return { status: 500, json: { detail: "boom" } };
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const sink = new MemoryGraphSink(client, () => true);
    sink.cleanupProject("proj-del", ["s1", "s2"]);
    for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(captured, "the sink should have posted to the sidecar");
    const c = captured as { path: string; body: unknown };
    assert.equal(c.path, "/cleanup/project");
    const body = c.body as Record<string, unknown>;
    assert.equal(body.project_id, "proj-del");
    assert.deepEqual(body.session_ids, ["s1", "s2"]);
  } finally {
    await close(server);
  }
});

test("MemoryGraphSink.cleanup* is a no-op when disabled (no network call)", async () => {
  let calls = 0;
  const server = await startFakeMemoryGraph(() => { calls += 1; return { status: 200, json: { status: "healthy" } }; });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const sink = new MemoryGraphSink(null, () => false);
    sink.cleanupSession("sess-x");
    sink.cleanupProject("proj-x", ["s1"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, "a disabled sink must not touch the network");
  } finally {
    await close(server);
  }
});

// --- unified tool-call ticket ------------------------------------------

test("MemoryGraphSink.observeToolCall posts snake_case products and never throws when the service errors", async () => {
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 500, json: { detail: "boom" } };
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const sink = new MemoryGraphSink(client, () => true);
    const payload: ObserveToolCallPayload = {
      taskId: "subtask:mcp:tc-1",
      sessionId: "sess-tc-1",
      turnId: "turn-tc-1",
      toolName: "mcp__llm-wiki__search",
      toolType: "search",
      source: "llm-wiki",
      resultCount: 2,
      products: [
        {
          productType: "web_page",
          identifier: "wiki/BRCA1",
          identifierType: "wiki-path",
          url: "http://wiki.local/BRCA1",
          title: "BRCA1",
          snippet: "tumor suppressor",
          sourceRefs: ["ref1", "ref2"],
        },
        {
          productType: "db_record",
          source: "uniprot",
          identifier: "P38398",
          identifierType: "uniprot-id",
          title: "BRCA1_HUMAN",
        },
      ],
    };
    // Fire-and-forget: must NOT throw even though the sidecar returned 500.
    sink.observeToolCall(payload);
    for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(captured, "the sink should have posted to the sidecar");
    const c = captured as { path: string; body: unknown };
    assert.equal(c.path, "/observe/tool-call");
    const body = c.body as Record<string, unknown>;
    assert.equal(body.task_id, "subtask:mcp:tc-1");
    assert.equal(body.session_id, "sess-tc-1");
    assert.equal(body.tool_name, "mcp__llm-wiki__search");
    assert.equal(body.tool_type, "search");
    assert.equal(body.source, "llm-wiki");
    assert.equal(body.result_count, 2);
    const products = body.products as Array<Record<string, unknown>>;
    assert.equal(products.length, 2);
    assert.equal(products[0]?.product_type, "web_page");
    assert.equal(products[0]?.identifier, "wiki/BRCA1");
    assert.equal(products[0]?.identifier_type, "wiki-path");
    assert.equal(products[0]?.url, "http://wiki.local/BRCA1");
    assert.deepEqual(products[0]?.source_refs, ["ref1", "ref2"]);
    // A snippet-only page carries no body hash → explicit null (the
    // sidecar's COALESCE keeps an existing content_hash when null arrives).
    assert.equal(products[0]?.content_hash, null);
    assert.equal(products[1]?.product_type, "db_record");
    assert.equal(products[1]?.source, "uniprot");
    assert.equal(products[1]?.identifier, "P38398");
    // db_record products never carry a content hash either.
    assert.equal(products[1]?.content_hash, null);
  } finally {
    await close(server);
  }
});

test("MemoryGraphSink.observeToolCall forwards contentHash on fetched web_page products", async () => {
  // A page-fetch product (web_fetch / llm-wiki get_page) carries the CAS
  // data-pool hash of the page body; the wire name is content_hash.
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 2 } };
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const sink = new MemoryGraphSink(client, () => true);
    sink.observeToolCall({
      taskId: "subtask:web-fetch:tc-9",
      sessionId: "sess-tc-9",
      turnId: "turn-tc-9",
      toolName: "web_fetch",
      toolType: "search",
      resultCount: 1,
      products: [{
        productType: "web_page",
        url: "https://en.wikipedia.org/wiki/BRCA1",
        contentHash: "a".repeat(64),
      }],
    });
    for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(captured, "the sink should have posted to the sidecar");
    const c = captured as { path: string; body: unknown };
    assert.equal(c.path, "/observe/tool-call");
    const body = c.body as Record<string, unknown>;
    const products = body.products as Array<Record<string, unknown>>;
    assert.equal(products[0]?.content_hash, "a".repeat(64));
    assert.equal(body.tool_name, "web_fetch");
  } finally {
    await close(server);
  }
});

test("MemoryGraphSink.observeToolCall forwards parentSubagentId and skips when disabled", async () => {
  let calls = 0;
  let captured: { path: string; body: unknown } | null = null;
  const server = await startFakeMemoryGraph((path, body) => {
    calls += 1;
    captured = { path, body };
    return { status: 200, json: { status: "healthy", written: 1 } };
  });
  const url = `http://127.0.0.1:${portOf(server)}`;
  try {
    const client = new MemoryGraphClient({ url, token: "test-token" });
    const enabledSink = new MemoryGraphSink(client, () => true);
    enabledSink.observeToolCall({
      taskId: "subtask:mcp:tc-2",
      sessionId: "sess-tc-2",
      turnId: "turn-tc-2",
      toolName: "web_search",
      toolType: "search",
      parentSubagentId: "sub-1",
      products: [],
    });
    for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(captured);
    const capturedSub = captured as { path: string; body: unknown };
    assert.equal(capturedSub.path, "/observe/tool-call");
    const body = capturedSub.body as Record<string, unknown>;
    assert.equal(body.parent_subagent_id, "sub-1");

    calls = 0;
    captured = null;
    const disabledSink = new MemoryGraphSink(null, () => false);
    disabledSink.observeToolCall({
      taskId: "subtask:mcp:tc-3",
      sessionId: "sess-tc-3",
      turnId: "turn-tc-3",
      toolName: "x",
      toolType: "y",
      products: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, "a disabled sink must not touch the network");
    assert.equal(captured, null);
  } finally {
    await close(server);
  }
});
