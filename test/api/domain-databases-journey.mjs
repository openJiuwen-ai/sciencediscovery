// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-META
 * Purpose: Retrieve five domain databases through the production MCP Inspector, complete governed downloads, analyze files and verify Agent use.
 * Steps: Start isolated production API/Runner; select connectors; inspect five live providers; download/verify GEO/PDB/AlphaFold files; persist analysis provenance; run local-stub Agent and continue Session.
 * Environment: Built committed task worktree, gateway venv and working Bubblewrap, ephemeral loopback ports and dedicated data.
 * Type: real
 * LLM: Journey-owned local deterministic model only; no paid model calls.
 * WebSearch: none
 * PaperSources: none
 * MCP: Real bundled biomed stdio and official GEO/ChEMBL/ClinVar/PDB/AlphaFold APIs.
 * OtherExternal: Official HTTPS endpoints and download hosts from config/external-urls.json only.
 * Credentials: Random local API token; no provider credentials.
 * CostSideEffects: Public read-only queries and small public file downloads; temporary local processes/data, evidence retained under .tmp.
 * Run: pnpm build && DOMAIN_DATABASES_LIVE=1 node --import tsx test/api/domain-databases-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { researchModel } from "../helpers/research-model.ts";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = resolve(".tmp", `domain-databases-${randomUUID()}`), data = resolve(root, "data"), token = randomUUID();
await mkdir(root, { recursive: true });
let outcome = "FAIL", api, stub, logs = "";
const steps = [], processes = [], evidence = {}, failures = [], analysis = [];
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
async function until(check, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for product outcome");
    await new Promise(done => setTimeout(done, 100));
  }
}
async function start(kind, extra = {}) {
  let origin, error;
  const child = spawn(process.execPath, [`services/${kind}/dist/server.js`], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, PYTHONPATH: resolve("services/gateway/src"),
    SCIENCE_AGENT_GATEWAY_PYTHON_PATH: resolve("services/gateway/.venv/bin/python"),
    SCIENCE_AGENT_DATA_DIR: data, SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
    SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "false",
    SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"), SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
    SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:1", ...extra,
  } });
  processes.push(child);
  child.once("error", reason => { error = reason; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    const line = redact(chunk); logs += line;
    origin ??= line.match(new RegExp(kind === "api" ? "ScienceDiscovery listening on (http://127\\.0\\.0\\.1:\\d+)" : "runner listening on (http://127\\.0\\.0\\.1:\\d+)"))?.[1];
  });
  await until(() => { if (error) throw error; if (child.exitCode !== null) throw new Error(`${kind} exited: ${logs.slice(-1500)}`); return origin; });
  return origin;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000); await done; clearTimeout(timer);
}
async function request(path, body, method = body === undefined ? "GET" : "POST", status = 200) {
  const r = await fetch(api + path, { method, signal: AbortSignal.timeout(180_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text(); assert.equal(r.status, status, `${method} ${path}: ${redact(text).slice(0, 2000)}`); return JSON.parse(text);
}
async function step(name, expected, operation) {
  try { const actual = await operation(); steps.push({ name, expected, actual, status: "PASS" }); console.log(name, "PASS", actual); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}
async function independentStep(name, expected, operation) {
  try { await step(name, expected, operation); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}
let session, project;
async function inspect(source, tool, input) {
  const r = await request(`/api/mcp/sources/${source}/inspect`, { sessionId: session.id, toolName: `${source}_${tool}`, input });
  assert.equal(r.ok, true, `${source}.${tool}: ${r.error}`);
  assert.equal(r.result.sourceId, source); assert.ok(r.result.retrievedAt);
  evidence[`${source}.${tool}`] = r;
  return r;
}
async function download(source, tool, input, path) {
  const inspected = await inspect(source, tool, input);
  const candidate = inspected.result.artifacts[0]; assert.ok(candidate, "A real candidate is required");
  const created = await request(`/api/sessions/${session.id}/mcp/artifact-plans`, { candidateId: candidate.id, mcpInvocationId: inspected.invocationId, destination: { type: "workspace", path } }, "POST", 201);
  if (created.plan.state === "awaiting_approval") {
    await request(`/api/permission-requests/${created.plan.permissionRequestId}/decision`, { decision: "allow_once" });
    await request(`/api/sessions/${session.id}/mcp/artifact-plans/${created.plan.id}/approve`, {});
  }
  let job;
  await until(async () => {
    job = (await request(`/api/sessions/${session.id}/mcp/artifact-jobs`)).find(j => j.planId === created.plan.id);
    if (job && ["failed", "cancelled"].includes(job.state)) throw new Error(JSON.stringify(job.error));
    return job?.state === "completed";
  });
  assert.match(job.actualChecksum.replace(/^sha256:/, ""), /^[a-f0-9]{64}$/);
  const r = await fetch(`${api}/api/sessions/${session.id}/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200); const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), job.actualChecksum.replace(/^sha256:/, ""));
  assert.equal(job.sourceRecordId, candidate.sourceRecordId);
  evidence[path] = { candidate, plan: created.plan, job };
  await writeFile(resolve(root, path.split("/").at(-1)), bytes);
  return bytes;
}
try {
  if (process.env.DOMAIN_DATABASES_LIVE !== "1") { outcome = "BLOCKED"; throw new Error("Set DOMAIN_DATABASES_LIVE=1 for public provider calls"); }
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit the candidate before E2E");
  await step("1. Start and select databases", "Authenticated production API/Runner; all five sources ready and selected", async () => {
    const runner = await start("runner"); api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner });
    for (const url of [api, runner]) assert.equal((await fetch(url + "/health", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    stub = await researchModel({ main: [
      { tools: [{ name: "tool_search", arguments: { query: "select:mcp__alphafold__lookup_prediction" } }] },
      { tools: [{ name: "mcp__alphafold__lookup_prediction", arguments: { accession: "P69905" } }] },
      ({ results }) => { assert.match(results.at(-1), /AF-P69905-F1/); assert.match(results.at(-1), /predicted/); return { text: "Retrieved the existing AlphaFold prediction AF-P69905-F1 for P69905; source evidence retained." }; },
    ] });
    const model = await request("/api/models", { name: "Domain validation local stub", baseUrl: stub.baseUrl, apiToken: stub.apiToken, model: stub.model }, "POST", 201);
    const created = await request("/api/projects", { name: "Domain database live journey" }, "POST", 201); project = created.project ?? created; session = created.firstSession;
    session = await request(`/api/sessions/${session.id}`, { modelId: model.id, enabledConnectorIds: ["geo", "chembl", "clinvar", "pdb", "alphafold"] }, "PATCH");
    await request(`/api/sessions/${session.id}`, { approvalMode: "always_allow" }, "PATCH");
    await request("/api/mcp/sources/reload", {});
    const sources = await request("/api/mcp/sources");
    for (const id of ["geo", "chembl", "clinvar", "pdb", "alphafold"]) assert.equal(sources.find(s => s.manifest.id === id)?.status.status, "ready", id);
    return "Five sources ready; Session selections saved; live model calls disabled";
  });
  await independentStep("2a. GEO evidence", "Study metadata, paged sample annotations and actual files", async () => {
    const geo = await inspect("geo", "lookup_accession", { accession: "GSE1000" }); assert.equal(geo.result.records[0].identifier, "GSE1000");
    const files = await inspect("geo", "list_files", { accession: "GSE1000", limit: 25 }); assert.ok(files.result.data.files.some(f => f.format === "series-matrix"));
    const samples = await inspect("geo", "get_samples", { accession: "GSE1000", limit: 1 }); assert.ok(samples.result.records.length > 0); assert.match(JSON.stringify(samples.result), /Platform-Ref/);
    return "GSE1000 study, real file listings and source-identified sample metadata retrieved";
  });
  await independentStep("2b. ChEMBL evidence", "Measurement constraints, assay confidence and non-overlapping pages", async () => {
    const input = { target_chembl_id: "CHEMBL203", standard_type: "IC50", standard_units: "nM", standard_relation: "=", standard_value_max: 100, confidence_score_min: 8, limit: 2 };
    const chembl = await inspect("chembl", "search_activities", input);
    assert.ok(chembl.result.records.length > 0); assert.ok(chembl.result.data.pagination.nextOffset > 0);
    for (const r of chembl.result.records) { assert.equal(r.structuredData.standard_units, "nM"); assert.ok(r.structuredData.assay_metadata.confidence_score >= 8); }
    const next = await inspect("chembl", "search_activities", { ...input, offset: chembl.result.data.pagination.nextOffset });
    assert.ok(next.result.records.every(r => !chembl.result.records.some(old => old.identifier === r.identifier)));
    return "Two provider pages retrieved with preserved units, relations, confidence and assay metadata";
  });
  await independentStep("2c. ClinVar evidence", "Individual SCV submissions and provider versions", async () => {
    const result = await inspect("clinvar", "get_assertions", { accession: "VCV000014206" });
    assert.ok(result.result.records[0].structuredData.assertions[0].accession.startsWith("SCV"));
    assert.ok(result.result.records[0].primaryCitation.sourceVersion);
    return "Versioned VCV000014206 and distinct SCV submissions retrieved";
  });
  await independentStep("2d. PDB evidence", "Experimental entry metadata", async () => {
    const result = await inspect("pdb", "lookup_structure", { pdb_id: "1CRN" });
    assert.equal(result.result.records[0].structuredData.structureType, "experimental");
    return "Experimental PDB 1CRN retrieved";
  });
  await independentStep("2e. AlphaFold evidence", "Existing prediction and model version", async () => {
    const result = await inspect("alphafold", "lookup_prediction", { accession: "P69905" });
    assert.equal(result.result.records[0].structuredData.structureType, "predicted"); assert.ok(result.result.records[0].primaryCitation.sourceVersion);
    return "Existing P69905 prediction, confidence metadata and model version retrieved";
  });
  await independentStep("3a. PDB download and analysis", "Verified structure artifact and actual atom/chain parsing", async () => {
    const pdb = (await download("pdb", "prepare_structure_download", { pdb_id: "1CRN", format: "pdb" }, "downloads/1CRN.pdb")).toString();
    const atoms = pdb.split(/\r?\n/).filter(line => line.startsWith("ATOM  ")); assert.ok(atoms.length > 0);
    const chains = [...new Set(atoms.map(line => line[21]))]; assert.ok(chains.length > 0);
    const result = `PDB 1CRN: ${atoms.length} atoms, chains ${chains.join(', ')}.`; analysis.push(result); return result;
  });
  await independentStep("3b. AlphaFold download and analysis", "Verified model/confidence artifacts with real residue data", async () => {
    const af = (await download("alphafold", "prepare_prediction_download", { accession: "P69905", format: "cif" }, "downloads/P69905.cif")).toString();
    assert.match(af, /_atom_site\./); assert.match(af, /_ma_qa_metric/);
    const confidence = JSON.parse((await download("alphafold", "prepare_prediction_download", { accession: "P69905", format: "plddt" }, "downloads/P69905-confidence.json")).toString());
    assert.ok(confidence.confidenceScore?.length > 0);
    const result = `AlphaFold P69905: predicted CIF, ${confidence.confidenceScore.length} pLDDT values.`; analysis.push(result); return result;
  });
  await independentStep("3c. GEO download and analysis", "Verified matrix artifact, dimensions, sample IDs and numeric values", async () => {
    const matrix = gunzipSync(await download("geo", "prepare_dataset_download", { accession: "GSE1000" }, "downloads/GSE1000.txt.gz")).toString();
    const table = matrix.split("!series_matrix_table_begin")[1]?.split("!series_matrix_table_end")[0].trim().split(/\r?\n/);
    assert.ok(table?.length > 1); const columns = table[0].split("\t"); assert.ok(columns.length > 1); assert.match(columns.slice(1).join(), /GSM/);
    const values = table.slice(1).flatMap(row => row.split("\t").slice(1)).filter(v => v !== 'null' && v !== '\"null\"').map(Number);
    assert.ok(values.some(v => Number.isFinite(v)));
    const result = `GSE1000: ${table.length - 1} rows, ${columns.length - 1} samples. Review source processing before count-based analysis; this journey does not run DESeq2.`;
    analysis.push(result); return result;
  });
  await independentStep("3d. Persist analysis provenance", "Analysis output retains source URLs, identifiers and retrieval times", async () => {
    assert.ok(analysis.length > 0, "Actual file analysis is required");
    const report = "# Analysis of retrieved database artifacts\n\n" + analysis.join("\n\n") + "\n\n" + Object.values(evidence).filter(e => e.result).flatMap(e => e.result.records.map(r => `${r.identifier}: ${r.url}; retrieved ${e.result.retrievedAt}; version ${r.primaryCitation.sourceVersion ?? 'not supplied'}`)).join("\n");
    await request(`/api/sessions/${session.id}/files`, { path: "domain-analysis.md", content: report }, "POST", 201);
    const r = await fetch(`${api}/api/sessions/${session.id}/file?path=domain-analysis.md`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(await r.text(), report);
    return "Read completed artifacts and persisted analysis with original source provenance";
  });
  await independentStep("4. Agent use and recovery", "Selected AlphaFold tool executes through Agent; audit, validation feedback and subsequent Session turn remain usable", async () => {
    const invalid = await request("/api/mcp/sources/alphafold/inspect", { sessionId: session.id, toolName: "alphafold_lookup_prediction", input: { accession: "../invalid" } }, "POST", 400); assert.match(invalid.error, /accession/);
    const run = await request(`/api/sessions/${session.id}/runs`, { content: "Retrieve the existing AlphaFold DB prediction for P69905 using its selected connector." }, "POST", 201);
    let terminal; await until(async () => { terminal = (await request(`/api/sessions/${session.id}/runs`)).find(r => r.id === run.id); return terminal && !["queued", "running"].includes(terminal.status); });
    assert.equal(terminal.status, "completed", terminal.error); assert.deepEqual(stub.errors, []);
    const audits = await request(`/api/sessions/${session.id}/mcp/invocations`); assert.ok(audits.some(i => i.sourceId === "alphafold" && i.status === "succeeded" && !i.turnId.startsWith("mcp-inspector-")));
    const next = await request(`/api/sessions/${session.id}/runs`, { content: "Confirm the retrieved prediction remains available." }, "POST", 201);
    await until(async () => { terminal = (await request(`/api/sessions/${session.id}/runs`)).find(r => r.id === next.id); return terminal && !["queued", "running"].includes(terminal.status); }); assert.equal(terminal.status, "completed", terminal.error);
    return "Agent completed with actual prediction output; invalid Inspector input rejected; subsequent turn completed";
  });
  if (failures.length) throw new Error(failures.join("\n"));
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = outcome === "BLOCKED" ? 2 : 1; }
finally {
  await Promise.all(processes.map(stop)); if (stub) await stub.stop();
  await writeFile(resolve(root, "report.md"), [`# Domain database product journey`, "", `Outcome: ${outcome}; SHA: ${sha}`, "", "Command: DOMAIN_DATABASES_LIVE=1 node --import tsx test/api/domain-databases-journey.mjs", "Startup: production API/Runner dist entry points, isolated data and ephemeral ports; bundled stdio MCP; local model stub.", "", ...steps.flatMap(s => [`## ${s.name}`, "", `Expected: ${s.expected}`, `Actual (${s.status}): ${s.actual}`, ""])].join("\n"));
  await writeFile(resolve(root, "evidence.json"), JSON.stringify(evidence, null, 2)); await writeFile(resolve(root, "service.log"), logs);
  await rm(data, { recursive: true, force: true }); console.log(`Evidence: ${root}/report.md`);
}
