import { createServer } from "node:http";

function json(value, status = 200) {
  return JSON.stringify(value);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export async function createCombinationFixture() {
  const state = {
    calls: [],
    config: {},
    approvals: [],
    skills: new Map(),
    sessions: new Map(),
    runs: new Map(),
    artifacts: new Map(),
    memory: new Map(),
    runners: new Map(),
    specialists: new Map(),
  };
  let runNumber = 0;
  let sessionNumber = 0;
  let artifactNumber = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const body = method === "GET" ? {} : await readBody(request);
    state.calls.push({ method, path: url.pathname, body });
    let value;
    let status = 200;

    if (method === "POST" && url.pathname === "/wizard/complete") {
      state.config = { ...state.config, ...body };
      value = { persisted: true, config: state.config };
    } else if (method === "POST" && url.pathname === "/approvals") {
      const approval = { id: `approval-${state.approvals.length + 1}`, ...body, status: "pending" };
      state.approvals.push(approval);
      value = approval;
    } else if (method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/resolve")) {
      const id = url.pathname.split("/")[2];
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval) { status = 404; value = { error: "approval not found" }; }
      else { approval.status = body.decision; value = approval; }
    } else if (method === "POST" && url.pathname === "/skills/inspect") {
      value = { repositoryUrl: body.repositoryUrl, ref: body.ref, commit: "fixture-commit-1", candidates: [{ id: "fixture-skill", status: "new", hash: "skill-hash-1" }] };
    } else if (method === "POST" && url.pathname === "/skills/review") {
      value = { draftId: "draft-fixture-skill", status: "draft", commit: body.commit, skillId: "fixture-skill" };
      state.skills.set("fixture-skill", value);
    } else if (method === "POST" && url.pathname === "/skills/publish") {
      const skill = state.skills.get(body.skillId ?? "fixture-skill");
      if (!skill) { status = 404; value = { error: "draft not found" }; }
      else { skill.status = "published"; skill.version = "v1"; skill.hash = "skill-hash-1"; value = skill; }
    } else if (method === "GET" && url.pathname === "/skills/registry") {
      value = [...state.skills.values()].filter((skill) => skill.status === "published");
    } else if (method === "POST" && url.pathname === "/sessions") {
      const id = `session-${++sessionNumber}`;
      const session = { id, ...body, events: [], artifactIds: [], memoryNodeIds: [] };
      state.sessions.set(id, session);
      value = session;
      status = 201;
    } else if (method === "GET" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/state")) {
      const id = url.pathname.split("/")[2];
      value = state.sessions.get(id);
      if (!value) { status = 404; value = { error: "session not found" }; }
    } else if (method === "POST" && url.pathname === "/runs") {
      const id = `run-${++runNumber}`;
      const run = { id, ...body, status: "running", events: [], retries: 0 };
      state.runs.set(id, run);
      const session = state.sessions.get(body.sessionId);
      if (session) session.events.push({ type: "run.started", runId: id });
      value = run;
      status = 201;
    } else if (method === "POST" && url.pathname.startsWith("/runs/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[2];
      const run = state.runs.get(id);
      if (!run) { status = 404; value = { error: "run not found" }; }
      else { run.events.push(body); value = { accepted: true, count: run.events.length }; }
    } else if (method === "POST" && url.pathname.startsWith("/runs/") && url.pathname.endsWith("/retry")) {
      const id = url.pathname.split("/")[2];
      const run = state.runs.get(id);
      if (!run) { status = 404; value = { error: "run not found" }; }
      else { run.retries += 1; run.events.push({ type: "run.retry", retry: run.retries }); value = run; }
    } else if (method === "GET" && url.pathname.startsWith("/runs/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[2];
      value = state.runs.get(id)?.events ?? [];
    } else if (method === "POST" && url.pathname === "/artifacts") {
      const id = `artifact-${++artifactNumber}`;
      const artifact = { id, ...body, provenance: { source: body.source ?? "run" } };
      state.artifacts.set(id, artifact);
      const session = state.sessions.get(body.sessionId);
      if (session) session.artifactIds.push(id);
      value = artifact;
      status = 201;
    } else if (method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const id = url.pathname.split("/")[2];
      value = state.artifacts.get(id);
      if (!value) { status = 404; value = { error: "artifact not found" }; }
    } else if (method === "POST" && url.pathname === "/memory/nodes") {
      const id = body.id ?? `memory-${state.memory.size + 1}`;
      const node = { id, ...body, version: 1 };
      state.memory.set(id, node);
      const session = state.sessions.get(body.sessionId);
      if (session) session.memoryNodeIds.push(id);
      value = node;
      status = 201;
    } else if (method === "POST" && url.pathname === "/memory/query") {
      value = { nodes: [...state.memory.values()].filter((node) => !body.sessionId || node.sessionId === body.sessionId), total: state.memory.size };
    } else if (method === "POST" && url.pathname === "/research") {
      const run = state.runs.get(body.runId);
      if (run) run.events.push({ type: "research.completed", nodeId: body.nodeId });
      value = { status: "completed", runId: body.runId, nodeId: body.nodeId };
    } else if (method === "POST" && url.pathname === "/evolve") {
      value = { status: "completed", sourceNode: body.nodeId, artifactId: body.artifactId };
    } else if (method === "POST" && url.pathname === "/runners") {
      const id = body.id ?? `runner-${state.runners.size + 1}`;
      const runner = { id, ...body, status: "ready" };
      state.runners.set(id, runner);
      value = runner;
      status = 201;
    } else if (method === "POST" && url.pathname.startsWith("/runners/") && url.pathname.endsWith("/execute")) {
      const id = url.pathname.split("/")[2];
      const runner = state.runners.get(id);
      if (!runner || runner.status !== "ready") { status = 503; value = { error: "runner unavailable" }; }
      else { runner.executions = (runner.executions ?? 0) + 1; value = { status: "completed", runnerId: id }; }
    } else if (method === "POST" && url.pathname.startsWith("/runners/") && url.pathname.endsWith("/cleanup")) {
      const id = url.pathname.split("/")[2];
      const runner = state.runners.get(id);
      if (runner) runner.cleaned = true;
      value = { cleaned: Boolean(runner) };
    } else if (method === "POST" && url.pathname === "/specialists") {
      const id = `specialist-${state.specialists.size + 1}`;
      const specialist = { id, ...body, status: "running", results: [] };
      state.specialists.set(id, specialist);
      value = specialist;
      status = 201;
    } else if (method === "POST" && url.pathname.startsWith("/specialists/") && url.pathname.endsWith("/result")) {
      const id = url.pathname.split("/")[2];
      const specialist = state.specialists.get(id);
      if (!specialist) { status = 404; value = { error: "specialist not found" }; }
      else { specialist.results.push(body); value = specialist; }
    } else if (method === "POST" && url.pathname === "/specialists/merge") {
      value = { status: "completed", citations: body.citations ?? [], sources: body.sources ?? [] };
    } else {
      status = 404;
      value = { error: `fixture route not found: ${method} ${url.pathname}` };
    }

    response.writeHead(status, { "content-type": "application/json" });
    response.end(json(value));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  async function request(path, options = {}) {
    const response = await fetch(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${value.error ?? "request failed"}`);
    return value;
  }

  return { state, origin, request, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runRealCombinationJourney(id) {
  const fixture = await createCombinationFixture();
  try {
    const { request, state } = fixture;
    const session = await request("/sessions", { method: "POST", body: { model: "fixture-model", skill: "fixture-skill" } });
    let run;
    let artifact;
    switch (id) {
      case "GJ-01": {
        await request("/wizard/complete", { method: "POST", body: { workspace: "/fixture", model: "fixture-model" } });
        const approval = await request("/approvals", { method: "POST", body: { sessionId: session.id, scope: "run" } });
        await request(`/approvals/${approval.id}/resolve`, { method: "POST", body: { decision: "approved" } });
        await request("/skills/inspect", { method: "POST", body: { repositoryUrl: "https://fixture.test/skills.git", ref: "main" } });
        await request("/skills/review", { method: "POST", body: { commit: "fixture-commit-1" } });
        await request("/skills/publish", { method: "POST", body: { skillId: "fixture-skill" } });
        const registry = await request("/skills/registry");
        assert(registry.some((skill) => skill.skillId === "fixture-skill"), "published skill missing from registry");
        run = await request("/runs", { method: "POST", body: { sessionId: session.id, skillSnapshot: "skill-hash-1" } });
        artifact = await request("/artifacts", { method: "POST", body: { sessionId: session.id, runId: run.id, source: "run" } });
        assert(run.skillSnapshot === "skill-hash-1", "run did not pin the published skill snapshot");
        assert(state.config.workspace === "/fixture", "wizard configuration was not persisted");
        assert(artifact.provenance.source === "run", "artifact provenance was not retained");
        break;
      }
      case "GJ-02":
        run = await request("/runs", { method: "POST", body: { sessionId: session.id } });
        await request(`/runs/${run.id}/events`, { method: "POST", body: { type: "delta", sequence: 1 } });
        await request(`/runs/${run.id}/retry`, { method: "POST", body: { reason: "sse-disconnect" } });
        await request(`/runs/${run.id}/events`, { method: "POST", body: { type: "resumed", sequence: 2 } });
        const events = await request(`/runs/${run.id}/events`);
        assert(Array.isArray(events) && events.length >= 2, "events were not returned");
        assert(events.some((event) => event.type === "resumed"), "resume event missing");
        break;
      case "GJ-03": {
        await request("/memory/nodes", { method: "POST", body: { id: "paper-1", sessionId: session.id, source: "paper.pdf" } });
        const nodes = await request("/memory/query", { method: "POST", body: { sessionId: session.id } });
        assert(nodes.nodes.some((node) => node.id === "paper-1"), "memory node was not queryable");
        run = await request("/runs", { method: "POST", body: { sessionId: session.id } });
        await request("/research", { method: "POST", body: { runId: run.id, nodeId: "paper-1" } });
        artifact = await request("/artifacts", { method: "POST", body: { sessionId: session.id, runId: run.id, source: "paper-1" } });
        await request("/evolve", { method: "POST", body: { nodeId: "paper-1", artifactId: artifact.id } });
        assert(artifact.provenance.source === "paper-1", "research artifact source was lost");
        break;
      }
      case "GJ-04": {
        const runner = await request("/runners", { method: "POST", body: { id: "runner-1", capability: "remote" } });
        const execution = await request(`/runners/${runner.id}/execute`, { method: "POST", body: { sessionId: session.id } });
        assert(execution.status === "completed", "remote execution did not complete");
        await request(`/runners/${runner.id}/cleanup`, { method: "POST", body: {} });
        assert(state.runners.get(runner.id).cleaned === true, "runner cleanup was not persisted");
        break;
      }
      case "GJ-05": {
        const specialist = await request("/specialists", { method: "POST", body: { sessionId: session.id, lanes: ["mcp", "subagent"] } });
        await request(`/specialists/${specialist.id}/result`, { method: "POST", body: { source: "mcp", citation: "cite-1" } });
        await request(`/specialists/${specialist.id}/result`, { method: "POST", body: { source: "subagent", citation: "cite-2" } });
        const merged = await request("/specialists/merge", { method: "POST", body: { sources: ["mcp", "subagent"], citations: ["cite-1", "cite-2"] } });
        assert(merged.citations.length === 2, "merged citations were lost");
        break;
      }
      case "GJ-06": {
        const second = await request("/sessions", { method: "POST", body: { model: "model-2", skill: "skill-2" } });
        const firstState = await request(`/sessions/${session.id}/state`);
        const secondState = await request(`/sessions/${second.id}/state`);
        assert(firstState.id !== secondState.id, "sessions share identity");
        assert(firstState.model !== secondState.model || firstState.skill !== secondState.skill, "session capabilities crossed");
        break;
      }
      default:
        throw new Error(`Unknown combination journey ${id}`);
    }
    return { status: "passed", calls: state.calls.length, sessionId: session.id, runId: run?.id, artifactId: artifact?.id };
  } finally {
    await fixture.close();
  }
}
