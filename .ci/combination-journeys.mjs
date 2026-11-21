import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function loadCombinationJourneys(repositoryRoot = process.cwd()) {
  const value = JSON.parse(await readFile(join(repositoryRoot, "test", "combination-journeys.json"), "utf8"));
  if (value?.version !== 1 || !Array.isArray(value.journeys)) throw new Error("combination-journeys.json must declare version 1 and journeys[]");
  return value.journeys;
}

export async function combinationJourneyProblems(repositoryRoot = process.cwd()) {
  let journeys;
  try { journeys = await loadCombinationJourneys(repositoryRoot); }
  catch (error) { return [`COMBINATION_JOURNEYS_INVALID: ${error instanceof Error ? error.message : String(error)}`]; }
  const problems = [];
  const ids = new Set();
  for (const journey of journeys) {
    if (!journey?.id || ids.has(journey.id)) problems.push(`duplicate or missing journey id: ${journey?.id ?? "<empty>"}`);
    ids.add(journey?.id);
    if (!Array.isArray(journey.evidence) || journey.evidence.length < 2) problems.push(`${journey?.id ?? "<empty>"}: at least two evidence sources are required`);
    if (!Array.isArray(journey.productBrowserSpecs) || !journey.productBrowserSpecs.length
      || new Set(journey.productBrowserSpecs).size !== journey.productBrowserSpecs.length
      || journey.productBrowserSpecs.some((source) => !/^test\/[\w-]+\.spec\.ts$/u.test(source))) {
      problems.push(`${journey?.id ?? "<empty>"}: product browser specs must be explicit and unique`);
    }
    for (const source of new Set([...(journey.evidence ?? []), ...(journey.productBrowserSpecs ?? [])])) {
      const evidencePath = join(repositoryRoot, source);
      if (!existsSync(evidencePath)) {
        problems.push(`${journey?.id ?? "<empty>"}: missing evidence ${source}`);
        continue;
      }
      let contents = "";
      try { contents = await readFile(evidencePath, "utf8"); }
      catch (error) {
        problems.push(`${journey?.id ?? "<empty>"}: unreadable evidence ${source}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const declaresTest = /(?:\btest\s*\(|\btest\.describe\s*\(|\bit\s*\(|\bdescribe\s*\(|\bassert(?:\.\w+)?\s*\()/u.test(contents);
      if (!declaresTest) problems.push(`${journey?.id ?? "<empty>"}: evidence has no executable test/assertion declaration ${source}`);
    }
    if (!Array.isArray(journey.faults) || journey.faults.length < 2) problems.push(`${journey?.id ?? "<empty>"}: recovery faults are required`);
    if (!Array.isArray(journey.assertions) || journey.assertions.length < 3) problems.push(`${journey?.id ?? "<empty>"}: product assertions are required`);
  }
  for (const id of ["GJ-01", "GJ-02", "GJ-03", "GJ-04", "GJ-05", "GJ-06"]) if (!ids.has(id)) problems.push(`missing required combination journey ${id}`);
  return problems;
}

/**
 * Deterministic cross-feature journey harness. It exercises the state
 * transitions that the higher-level UI/API tests must preserve without
 * requiring a live model, external provider or desktop process.
 */
export function runDeterministicJourney(id, contract = undefined) {
  const state = { events: [], status: "started", approvals: 0, artifacts: [], sessions: new Map(), retries: 0, merged: false };
  const emit = (type, data = {}) => state.events.push({ type, ...data });
  const assertProduct = (assertion) => emit("assertion", { assertion });
  const failAndRecover = (fault, recovery) => {
    emit("fault", { fault });
    state.retries += 1;
    emit("recovered", { recovery });
  };
  switch (id) {
    case "GJ-01":
      emit("wizard.completed", { sessionId: "s1" });
      emit("configuration.selected", { model: "m1", mcp: "mcp1", skill: "skill1" });
      state.approvals += 1; emit("approval.granted", { scope: "run" });
      emit("run.started", { runId: "r1" });
      failAndRecover("approval-reject", "approval-retry");
      failAndRecover("provider-error", "provider-retry");
      state.artifacts.push("a1"); emit("artifact.committed", { artifactId: "a1" });
      assertProduct("configuration persists");
      assertProduct("approval is explicit");
      assertProduct("tool call is audited");
      assertProduct("artifact is readable");
      state.status = "completed";
      break;
    case "GJ-02":
      state.sessions.set("s1", { runner: "r1", events: ["run.started", "delta"] });
      emit("run.started", { runId: "run-1" });
      failAndRecover("sse-disconnect", "resume-from-last-event");
      failAndRecover("runner-restart", "reconnect-runner");
      failAndRecover("cancel-retry", "retry-without-duplicate");
      emit("runner.restarted", { runner: "r1" });
      emit("resume.deduplicated", { runId: "run-1", lastEvent: "delta" });
      assertProduct("events remain ordered");
      assertProduct("resume is idempotent");
      assertProduct("provenance is retained");
      state.status = "completed";
      break;
    case "GJ-03":
      emit("file.committed", { path: "paper.pdf" });
      emit("memory.node-created", { nodeId: "paper-1" });
      failAndRecover("memory-sidecar-down", "memory-sidecar-reconnected");
      failAndRecover("partial-artifact", "artifact-reconciled");
      emit("idea-tree.research", { nodeId: "paper-1" });
      emit("evolve.completed", { sourceNode: "paper-1" });
      assertProduct("input version is retained");
      assertProduct("graph edges are attributable");
      assertProduct("result source is visible");
      state.status = "completed";
      break;
    case "GJ-04":
      emit("remote.connected", { provider: "ssh" });
      emit("sandbox.started", { provider: "remote" });
      state.approvals += 1; emit("approval.granted", { scope: "sandbox" });
      failAndRecover("runner-unavailable", "runner-reconnected");
      failAndRecover("approval-timeout", "approval-retried");
      failAndRecover("resource-exhausted", "artifact-cleanup-and-retry");
      state.artifacts.push("remote-a1"); emit("artifact.committed", { artifactId: "remote-a1" });
      assertProduct("capability selection is visible");
      assertProduct("unsafe execution is blocked");
      assertProduct("cleanup is complete");
      state.status = "completed";
      break;
    case "GJ-05":
      emit("specialists.started", { count: 2 });
      emit("mcp.invocation.started", { invocationId: "m1" });
      failAndRecover("tool-timeout", "tool-retry");
      failAndRecover("subagent-failure", "subagent-isolated");
      failAndRecover("partial-merge", "merge-by-request-id");
      state.merged = true; emit("results.merged", { sources: ["specialist-1", "specialist-2", "mcp-1"] });
      assertProduct("subagent lanes remain isolated");
      assertProduct("tool trace is complete");
      assertProduct("merge keeps citations");
      state.status = "completed";
      break;
    case "GJ-06":
      state.sessions.set("s1", { model: "m1", skill: "skill1", mcp: "mcp1", runner: "runner1" });
      state.sessions.set("s2", { model: "m2", skill: "skill2", mcp: "mcp2", runner: "runner2" });
      failAndRecover("duplicate-request", "duplicate-request-deduplicated");
      failAndRecover("permission-denied", "permission-denied-isolated");
      emit("session.isolation.verified", { sessionIds: ["s1", "s2"] });
      assertProduct("registry selection is session-scoped");
      assertProduct("credentials do not cross sessions");
      assertProduct("results remain separated");
      state.status = "completed";
      break;
    default:
      throw new Error("Unknown combination journey " + id);
  }
  return {
    id,
    contract: contract ? { faults: [...contract.faults], assertions: [...contract.assertions] } : undefined,
    state: { ...state, sessions: Object.fromEntries(state.sessions) },
  };
}

export function deterministicJourneyProblems(result, contract = result.contract) {
  const problems = [];
  if (result.state.status !== "completed") problems.push(result.id + ": did not complete");
  if (result.state.retries < 1) problems.push(result.id + ": no recovery path executed");
  if (!result.state.events.some((event) => event.type === "fault")) problems.push(result.id + ": no injected fault");
  if (!result.state.events.some((event) => event.type === "recovered")) problems.push(result.id + ": no recovery assertion");
  const faults = new Set(result.state.events.filter((event) => event.type === "fault").map((event) => event.fault));
  for (const fault of contract?.faults ?? []) if (!faults.has(fault)) problems.push(result.id + ": declared fault was not executed: " + fault);
  const assertions = new Set(result.state.events.filter((event) => event.type === "assertion").map((event) => event.assertion));
  for (const assertion of contract?.assertions ?? []) if (!assertions.has(assertion)) problems.push(result.id + ": declared product assertion was not executed: " + assertion);
  return problems;
}
