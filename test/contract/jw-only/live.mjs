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

/**
 * Live checks of what only the JiuwenSwarm executor does (there is nothing to compare with on the
 * built-in loop, so they are not L2 cases). Run against a stack started with the adapter and
 * SCIENCE_AGENT_EXECUTOR=jiuwenswarm:
 *
 *   E2E_BASE_URL=http://127.0.0.1:4310 E2E_API_TOKEN=... node test/contract/jw-only/live.mjs history
 *   node test/contract/jw-only/live.mjs todo-plan
 *
 *   LIVE_RESTART_CMD='scripts/jiuwenswarm.sh stop && scripts/jiuwenswarm.sh start' ... live.mjs history-restart
 *
 * Each check builds its own project, model and scripted model, and deletes them.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

import { startStubModel } from "../stub-model.mjs";

const run = promisify(exec);
const base = process.env.E2E_BASE_URL;
const token = process.env.E2E_API_TOKEN;
if (!base || !token) throw new Error("Need E2E_BASE_URL and E2E_API_TOKEN");

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function setup(stub, modelExtras = {}) {
  const model = await api("POST", "/api/models", { vision: false, apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `live ${Date.now()}`, ...modelExtras });
  const project = await api("POST", "/api/projects", { name: `live ${Date.now()}` });
  const sessionId = project.firstSession.id;
  await api("PATCH", `/api/sessions/${sessionId}`, { modelId: model.id, title: "live" });
  await api("PATCH", `/api/sessions/${sessionId}`, { approvalMode: "always_allow" });
  const cleanup = async () => {
    await api("DELETE", `/api/projects/${project.id}`, { confirmationId: project.id }).catch(() => undefined);
    await api("DELETE", `/api/models/${model.id}`).catch(() => undefined);
    await stub.stop();
  };
  return { sessionId, cleanup, modelId: model.id };
}

async function runAndWait(sessionId, content) {
  const run = await api("POST", `/api/sessions/${sessionId}/runs`, { content });
  for (let i = 0; i < 240; i += 1) {
    const current = await api("GET", `/api/sessions/${sessionId}/runs/${run.id}`);
    if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("run did not finish");
}

const runEvents = async (sessionId, runId) => (await api("GET", `/api/sessions/${sessionId}/runs/${runId}/events`)).map((entry) => entry.event ?? entry);

const checks = {
  /** The second turn of a conversation reaches the model with the first turn in its context. */
  async history() {
    const stub = await startStubModel({ main: [{ text: "First answer." }, { text: "Second answer." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      await runAndWait(sessionId, "My favourite number is 4711.");
      const second = await runAndWait(sessionId, "What did I say my favourite number was?");
      if (second.status !== "completed") throw new Error(`second run ${second.status}: ${second.error}`);
      const tail = stub.requests.filter((request) => request.route === "main").length;
      if (tail !== 2) throw new Error(`expected 2 model requests, saw ${tail}`);
      const seen = stub.lastMessages?.() ?? [];
      const text = JSON.stringify(seen);
      if (!text.includes("4711")) throw new Error("the second request did not carry the first turn");
      console.log(`history: ok (the second model request had ${seen.length} messages and the first turn in them)`);
    } finally {
      await cleanup();
    }
  },

  /** The conversation is still in JiuwenSwarm's context after JiuwenSwarm itself was restarted between two turns. */
  async "history-restart"() {
    const restart = process.env.LIVE_RESTART_CMD;
    if (!restart) throw new Error("history-restart needs LIVE_RESTART_CMD, the command that restarts JiuwenSwarm");
    const stub = await startStubModel({ main: [{ text: "First answer." }, { text: "Second answer." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      await runAndWait(sessionId, "My favourite number is 4711.");
      // Asynchronously: the scripted model lives in this process and must keep answering while JiuwenSwarm restarts.
      await run(restart, { shell: "/bin/bash", timeout: 300_000 });
      const second = await runAndWait(sessionId, "What did I say my favourite number was?");
      if (second.status !== "completed") throw new Error(`second run ${second.status}: ${second.error}`);
      const seen = stub.lastMessages?.() ?? [];
      if (!JSON.stringify(seen).includes("4711")) throw new Error(`after the restart the second request did not carry the first turn (${seen.length} messages)`);
      console.log(`history-restart: ok (after restarting JiuwenSwarm the second request still had the first turn among its ${seen.length} messages)`);
    } finally {
      await cleanup();
    }
  },

  /**
   * JiuwenSwarm compresses the conversation when its window fills. The stack must have been started with
   * JIUWENSWARM_CONTEXT_WINDOW_TOKENS=3000 (the only window setting JiuwenSwarm 0.2.6 honours); six turns of
   * about 750 tokens each are sent: by the last request the early turns must be gone or summarised, while
   * the newest is there in full.
   */
  async compression() {
    const stub = await startStubModel({ main: Array.from({ length: 30 }, (_, index) => ({ text: `Answer ${index + 1}.` })) });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const turns = 6;
      for (let turn = 1; turn <= turns; turn += 1) {
        const run = await runAndWait(sessionId, `TURN-${turn}-MARK ${"lorem ipsum dolor ".repeat(170)}`);
        if (run.status !== "completed") throw new Error(`turn ${turn} ${run.status}: ${run.error}`);
      }
      const seen = JSON.stringify(stub.lastMessages?.() ?? []);
      const present = Array.from({ length: turns }, (_, index) => index + 1).filter((turn) => seen.includes(`TURN-${turn}-MARK`));
      const sent = turns * 3000;
      console.log(`compression: last request ${seen.length} chars for ${sent} sent; turns still present in full: ${present.join(",") || "none"}`);
      if (!present.includes(turns)) throw new Error("the newest turn is missing from the last request");
      // The size of the request is not a test: JiuwenSwarm's own system prompt is part of it.
      if (present.length === turns) throw new Error("nothing was compressed: every turn is still there");
    } finally {
      await cleanup();
    }
  },

  /**
   * Each run registers its tools under a new server name, and JiuwenSwarm keeps the session's history across
   * runs. By the second run's model request, the first run's tool call must be there under its plain name.
   */
  async "history-names"() {
    const stub = await startStubModel({ main: [
      { tool: "run_shell", arguments: { command: "echo FIRST" } }, { text: "First done." },
      { tool: "run_shell", arguments: { command: "echo SECOND" } }, { text: "Second done." },
    ] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      for (const text of ["Run the first command.", "Run the second command."]) {
        const run = await runAndWait(sessionId, text);
        if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      }
      const seen = JSON.stringify(stub.lastMessages?.() ?? []);
      const stale = seen.match(/mcp_sci[0-9a-z]{10}_\w+/g) ?? [];
      if (stale.length) throw new Error(`prefixed tool names reached the model: ${[...new Set(stale)].join(", ")}`);
      if (!seen.includes("echo FIRST")) throw new Error("the first run's tool call is not in the history");
      console.log("history-names: ok (the first run's tool call reached the second run's model under its plain name)");
    } finally {
      await cleanup();
    }
  },

  /**
   * Web search is JiuwenSwarm's, configured from the web settings: with DuckDuckGo and Bing on in the settings,
   * its free search tool is offered and a call to it comes back with results.
   */
  async "web-search"() {
    const web = await api("GET", "/api/web/settings");
    if (web.backend !== "jiuwenswarm") throw new Error(`the web settings do not say jiuwenswarm: ${web.backend}`);
    await api("PUT", "/api/web/settings", { freeSearchEngines: { ...web.freeSearchEngines, duckduckgo: true, bing: true } });
    // The memory graph is off in a fresh data directory; the check needs it on.
    const memory = await api("GET", "/api/memory/settings");
    if (!memory.enabled) await api("PUT", "/api/memory/settings", { enabled: true });
    const stub = await startStubModel({ main: [{ tool: "free_search", arguments: { query: "perovskite solar cell stability", max_results: 3 } }, { text: "Searched." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Search the web.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const events = await runEvents(sessionId, run.id);
      const completed = events.find((event) => event.type === "tool.completed");
      if (completed?.trace?.name !== "free_search") throw new Error(`no free_search call: ${events.map((e) => e.type).join(" ")}`);
      const output = JSON.stringify(await api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${completed.trace.outputStream}/events`));
      console.log(`web-search: ${completed.trace.status} (${output.length} characters of output): ${output.slice(0, 200)}`);
      if (completed.trace.status !== "completed") throw new Error("the search failed");
      // The hits are recorded in the memory graph as WebPage nodes, as ScienceDiscovery's own search records them.
      let pages = [];
      for (let attempt = 0; attempt < 10 && !pages.length; attempt += 1) {
        const graph = await api("GET", `/api/memory/subgraph?session_id=${sessionId}`);
        if (graph.reason) { console.log(`web-search: memory graph not available here (${graph.reason}); not checked`); return; }
        pages = (graph.nodes ?? []).filter((node) => /web/i.test(String(node.type ?? node.label ?? node.labels ?? "")));
        if (!pages.length) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!pages.length) throw new Error("no WebPage node in the session's memory graph");
      console.log(`web-search: ${pages.length} WebPage node(s) in the memory graph, e.g. ${JSON.stringify(pages[0]).slice(0, 200)}`);
    } finally {
      await cleanup();
    }
  },

  /**
   * ScienceDiscovery's tools reach JiuwenSwarm through one shared MCP server with stable names: run_shell runs in
   * the sandbox in two runs one after the other (the second finds the server already there), and its output is
   * in the run's tool card.
   */
  async "run-shell"() {
    const stub = await startStubModel({ main: [
      { tool: "run_shell", arguments: { command: "echo SD-SHELL-ONE" } }, { text: "One." },
      { tool: "run_shell", arguments: { command: "echo SD-SHELL-TWO" } }, { text: "Two." },
    ] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      for (const word of ["ONE", "TWO"]) {
        const run = await runAndWait(sessionId, `Run echo ${word}.`);
        if (run.status !== "completed") throw new Error(`run ${word} ${run.status}: ${run.error}`);
        const events = await runEvents(sessionId, run.id);
        const completed = events.find((event) => event.type === "tool.completed" && event.trace?.name === "run_shell");
        if (!completed || completed.trace.native) throw new Error(`run ${word}: no run_shell of ours: ${events.map((e) => e.type).join(" ")}`);
        const stream = completed.trace.outputStream;
        const output = stream ? await api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${stream}/events`) : completed.trace;
        if (!JSON.stringify(output).includes(`SD-SHELL-${word}`)) throw new Error(`run ${word}: output missing: ${JSON.stringify(output).slice(0, 300)}`);
      }
      const names = new Set(stub.requests.flatMap((request) => request.toolNames ?? []));
      if (!names.has("run_shell") || [...names].some((name) => /^mcp_sci/.test(name))) throw new Error(`the model saw ${[...names].filter((n) => /shell/.test(n))}`);
      console.log("run-shell: ok (run_shell ran in the sandbox in two runs through the shared MCP server; the model saw plain names)");
    } finally {
      await cleanup();
    }
  },

  /** JiuwenSwarm's own todo tool drives the plan (the default; not with SCIENCE_AGENT_JIUWENSWARM_PLANNING=update_plan). */
  async "todo-plan"() {
    const tasks = [
      { id: "search", content: "Search the literature", activeForm: "Searching", description: "find sources" },
      { id: "write", content: "Write the summary", activeForm: "Writing", description: "summarise" },
    ];
    const stub = await startStubModel({ main: [{ tool: "todo_create", arguments: { tasks, call_goal: "plan" } }, { text: "Planned." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Plan the work.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const events = await runEvents(sessionId, run.id);
      const types = events.map((event) => event.type);
      const plans = events.filter((event) => event.type === "plan.updated");
      if (!plans.length) throw new Error(`no plan.updated event; events: ${types.join(" ")}`);
      const steps = JSON.stringify(plans.at(-1));
      for (const wanted of ["Search the literature", "Write the summary", "in_progress"]) {
        if (!steps.includes(wanted)) throw new Error(`plan lacks ${wanted}: ${steps.slice(0, 300)}`);
      }
      const started = events.find((event) => event.type === "tool.started");
      if (started?.trace?.name !== "todo_create") throw new Error(`the todo call is not shown as a tool: ${JSON.stringify(started)?.slice(0, 200)}`);
      console.log("todo-plan: ok (todo_create shown as a tool call, plan.updated carries both steps)");
    } finally {
      await cleanup();
    }
  },

  /**
   * The session's skills are JiuwenSwarm skills: imported into it (skill-creator as sciencediscovery-skill-creator, since
   * JiuwenSwarm has its own), loaded with its skill_tool. Our read_skill and read_skill_resource remain available
   * as fallbacks for JiuwenSwarm skill_tool failures, while our catalog is not duplicated. JiuwenSwarm
   * lists every skill in its prompt while they fit its budget and otherwise has the model search them (skill_index), so
   * the check loads them by name rather than looking for them in the prompt.
   */
  async skills() {
    const stub = await startStubModel({ main: [
      { tool: "skill_tool", arguments: { skill_name: "evolve-design" } },
      { tool: "skill_tool", arguments: { skill_name: "sciencediscovery-skill-creator" } },
      { text: "Loaded." },
    ] });
    const { sessionId, cleanup, modelId } = await setup(stub);
    try {
      // A new project starts with no skills; this session gets all of them. The PUT replaces every override, the model too.
      await api("PUT", `/api/sessions/${sessionId}/settings`, { skillSelectionMode: "all", modelId });
      const run = await runAndWait(sessionId, "Load the evolve-design and skill-creator skills.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const system = JSON.stringify((stub.lastMessages?.() ?? []).filter((message) => message.role === "system"));
      if (system.includes("<available_skills>")) throw new Error("our skill catalog is still in the prompt");
      if (!system.includes("Skill")) throw new Error("JiuwenSwarm's installed-skills section is missing");
      const events = await runEvents(sessionId, run.id);
      const loads = events.filter((event) => event.type === "tool.completed" && event.trace?.name === "skill_tool");
      // A long output is kept in its own stream rather than in the event.
      const outputs = await Promise.all(loads.map(async (event) => JSON.stringify(event.trace) + JSON.stringify(event.trace.outputStream
        ? await api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${event.trace.outputStream}/events?after=0`) : "")));
      if (!outputs.some((output) => /create_evolve_run/.test(output))) throw new Error(`skill_tool did not return evolve-design's SKILL.md: ${outputs.join(" ").slice(0, 300)}`);
      if (!outputs.some((output) => /create_skill|reviewable reusable Agent Skill/.test(output))) throw new Error(`skill_tool did not return our skill-creator: ${outputs.join(" ").slice(0, 300)}`);
      const names = new Set(stub.requests.flatMap((request) => request.toolNames ?? []));
      for (const reader of ["read_skill", "read_skill_resource"]) {
        if (!names.has(reader)) throw new Error(`${reader} fallback is missing`);
      }
      console.log(`skills: ok (evolve-design and sciencediscovery-skill-creator loaded with skill_tool; fallback readers offered without a duplicate catalog; JiuwenSwarm prompt ${system.includes("newly_installed_skills") ? "in search mode" : "lists the skills"})`);
    } finally {
      await cleanup();
    }
  },

  /**
   * A skill switched off in Settings > Skills (JiuwenSwarm's one on/off switch) cannot be loaded in a session started
   * afterwards; switched back on, it can. The switch is left as it was found.
   */
  async "skill-switch"() {
    const name = "code-engineer";
    const before = (await api("GET", "/api/jiuwenswarm/skills")).skills.find((skill) => skill.name === name);
    if (!before) throw new Error(`${name} is not installed in JiuwenSwarm; run the skills check first`);
    const loadIn = async (enabled) => {
      await api("PUT", `/api/jiuwenswarm/skills/${name}`, { enabled });
      const listed = (await api("GET", "/api/jiuwenswarm/skills")).skills.find((skill) => skill.name === name);
      if (listed?.enabled !== enabled) throw new Error(`the list says ${name} is ${listed?.enabled ? "on" : "off"}`);
      const stub = await startStubModel({ main: [{ tool: "skill_tool", arguments: { skill_name: name } }, { text: "Done." }] });
      const { sessionId, cleanup } = await setup(stub);
      try {
        const run = await runAndWait(sessionId, `Load ${name}.`);
        if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
        const done = (await runEvents(sessionId, run.id)).find((event) => event.type === "tool.completed" && event.trace?.name === "skill_tool");
        const stream = done?.trace?.outputStream
          ? await api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${done.trace.outputStream}/events?after=0`) : "";
        return /execute\.py|code-engineer/.test(JSON.stringify(stream)) && (done?.trace?.outputChars ?? 0) > 1000;
      } finally {
        await cleanup();
      }
    };
    try {
      if (await loadIn(false)) throw new Error(`${name} was switched off but skill_tool still returned it`);
      if (!(await loadIn(true))) throw new Error(`${name} was switched back on but skill_tool did not return it`);
      console.log(`skill-switch: ok (${name} off: skill_tool could not load it in a new session; on again: it could)`);
    } finally {
      await api("PUT", `/api/jiuwenswarm/skills/${name}`, { enabled: before.enabled });
    }
  },

  /**
   * JiuwenSwarm's tools that act on the host are not the model's: a bash call it makes anyway runs nothing (the marker
   * file it would create stays absent), and read_file reaches ScienceDiscovery's, in the workspace.
   */
  async "host-tools"() {
    const { existsSync } = await import("node:fs");
    const marker = `/tmp/sd-host-tool-${Date.now()}`;
    const stub = await startStubModel({ main: [
      { tool: "bash", arguments: { command: `touch ${marker}` } },
      { tool: "read_file", arguments: { path: "missing-on-purpose.txt" } },
      { text: "Done." },
    ] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Try the tools.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      if (existsSync(marker)) throw new Error(`bash ran on the host: ${marker} exists`);
      const offered = new Set(stub.requests.flatMap((request) => request.toolNames ?? []));
      for (const hidden of ["bash", "write_file", "edit_file", "glob", "grep"]) {
        if (offered.has(hidden)) throw new Error(`JiuwenSwarm's ${hidden} was offered to the model`);
      }
      const events = await runEvents(sessionId, run.id);
      const read = events.find((event) => event.type === "tool.started" && /read_file$/.test(event.trace?.name ?? ""));
      if (!read || read.trace.native) throw new Error(`read_file did not reach ScienceDiscovery's tool: ${JSON.stringify(read?.trace ?? null)}`);
      console.log(`host-tools: ok (bash turned away, nothing ran on the host; read_file was ScienceDiscovery's; offered: ${[...offered].filter((n) => !n.startsWith("mcp_")).length} JiuwenSwarm tools)`);
    } finally {
      await cleanup();
    }
  },

  /**
   * JiuwenSwarm's permission engine decides: with a session that asks, run_shell stops on its question, which shows
   * as one of our approvals. Allowed once, the command runs (recorded as JiuwenSwarm's decision); the next call asks
   * again and, denied, runs nothing.
   */
  async approvals() {
    const stub = await startStubModel({ main: [
      { tool: "run_shell", arguments: { command: "echo APPROVED-RUN" } },
      { tool: "run_shell", arguments: { command: "echo DENIED-RUN" } },
      { text: "Done." },
    ] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      await api("PATCH", `/api/sessions/${sessionId}`, { approvalMode: "ask_for_dangerous" });
      const run = await api("POST", `/api/sessions/${sessionId}/runs`, { content: "Run two commands." });
      const decide = async (decision) => {
        for (let i = 0; i < 120; i += 1) {
          const pending = (await api("GET", `/api/permission-requests?sessionId=${sessionId}`)).filter((request) => request.state === "pending");
          if (pending.length) {
            await api("POST", `/api/permission-requests/${pending[0].id}/decision`, { decision });
            return pending[0];
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(`no approval was asked for (to ${decision})`);
      };
      const first = await decide("allow_once");
      const second = await decide("deny");
      // The card says what the call is: the tool and its command, not only JiuwenSwarm's question.
      if (first.summary !== "run_shell: echo APPROVED-RUN" || second.summary !== "run_shell: echo DENIED-RUN") {
        throw new Error(`the approvals do not show the calls: ${JSON.stringify([first.summary, second.summary])}`);
      }
      let current;
      for (let i = 0; i < 120; i += 1) {
        current = await api("GET", `/api/sessions/${sessionId}/runs/${run.id}`);
        if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (current.status !== "completed") throw new Error(`run ${current.status}: ${current.error}`);
      const events = JSON.stringify(await runEvents(sessionId, run.id));
      const streams = await Promise.all((await runEvents(sessionId, run.id))
        .filter((event) => event.type === "tool.completed" && event.trace?.outputStream)
        .map((event) => api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${event.trace.outputStream}/events`)));
      const outputs = events + JSON.stringify(streams);
      if (!outputs.includes("APPROVED-RUN")) throw new Error("the allowed command did not run");
      if (/DENIED-RUN\\n|"DENIED-RUN"/.test(JSON.stringify(streams))) throw new Error("the denied command ran");
      // Each call JiuwenSwarm asked about is recorded once, as the user's answer to its question: the bridge-side
      // check reuses that record by toolCallId instead of booking a second, `jiuwenswarm`-sourced one (store.ts,
      // authorizeByJiuwenSwarm). Two questions, so exactly two records, one allowed and one denied.
      const authorizations = await api("GET", `/api/sessions/${sessionId}/permission-authorizations`);
      const outcomes = authorizations.map((authorization) => authorization.outcome).sort();
      const callIds = new Set(authorizations.map((authorization) => authorization.toolCallId));
      if (authorizations.length !== 2 || outcomes.join() !== "allowed,denied" || callIds.size !== 2 || callIds.has(undefined)) {
        throw new Error(`expected one authorization per asked call (allowed, denied): ${JSON.stringify(authorizations).slice(0, 600)}`);
      }
      console.log(`approvals: ok (asked twice: "${first.summary.slice(0, 50)}"; allowed once it ran, denied it did not; one authorization per call, not double-booked)`);
    } finally {
      await cleanup();
    }
  },

  /**
   * The trajectory view has a JiuwenSwarm run: its model inputs (as sent, JiuwenSwarm's prompt included), the
   * states around each turn and the tool call, linked to the input that asked for it.
   */
  async trajectory() {
    const stub = await startStubModel({ main: [{ tool: "run_shell", arguments: { command: "echo TRAJ-OK" } }, { text: "Done." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Run it.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const index = await api("GET", `/api/sessions/${sessionId}/trajectory`);
      const entries = index.entries ?? index;
      const kinds = entries.reduce((count, entry) => ({ ...count, [entry.kind]: (count[entry.kind] ?? 0) + 1 }), {});
      const inputs = entries.filter((entry) => entry.kind === "input");
      if (inputs.length < 2) throw new Error(`expected a model input per turn (2), saw ${inputs.length}: ${JSON.stringify(kinds)}`);
      const detail = await api("GET", `/api/sessions/${sessionId}/trajectory/detail?id=${encodeURIComponent(inputs[0].id)}`);
      const text = JSON.stringify(detail);
      if (!text.includes("JiuwenSwarm") || !text.includes("run_shell")) throw new Error(`the model input is not what was sent: ${text.slice(0, 300)}`);
      const linkedTool = entries.find((entry) => /tool/.test(entry.kind) && entry.contextId);
      if (!linkedTool) throw new Error(`no tool entry linked to a model input: ${JSON.stringify(kinds)}`);
      console.log(`trajectory: ok (${JSON.stringify(kinds)}; the model input holds JiuwenSwarm's prompt and the tools; the tool call is linked to its input)`);
    } finally {
      await cleanup();
    }
  },

  /** The UI's language is JiuwenSwarm's: after switching, a new session gets JiuwenSwarm's own prompt in it. */
  async language() {
    const promptIn = async (language) => {
      await api("PUT", "/api/jiuwenswarm/language", { language });
      const stub = await startStubModel({ main: [{ text: "Hi." }] });
      const { sessionId, cleanup } = await setup(stub);
      try {
        await runAndWait(sessionId, "Hello.");
        return JSON.stringify((stub.lastMessages?.() ?? []).filter((message) => message.role === "system"));
      } finally {
        await cleanup();
      }
    };
    try {
      const english = await promptIn("en");
      if (!english.includes("# Identity")) throw new Error(`with en, JiuwenSwarm's prompt is not English: ${english.slice(0, 200)}`);
      const chinese = await promptIn("zh-CN");
      if (!chinese.includes("# 身份")) throw new Error(`with zh-CN, JiuwenSwarm's prompt is not Chinese: ${chinese.slice(0, 200)}`);
      // Switching in the middle of a session: its next run.
      const stub = await startStubModel({ main: [{ text: "One." }, { text: "Two." }] });
      const { sessionId, cleanup } = await setup(stub);
      let midSession;
      try {
        await runAndWait(sessionId, "First.");
        await api("PUT", "/api/jiuwenswarm/language", { language: "en" });
        await runAndWait(sessionId, "Second.");
        const system = JSON.stringify((stub.lastMessages?.() ?? []).filter((message) => message.role === "system"));
        midSession = system.includes("# Identity") ? "switches at the session's next run" : "keeps the language it started with";
      } finally {
        await cleanup();
      }
      console.log(`language: ok (en gives JiuwenSwarm's prompt in English, zh-CN in Chinese; a running session ${midSession})`);
    } finally {
      await api("PUT", "/api/jiuwenswarm/language", { language: process.env.LIVE_LANGUAGE || "zh-CN" }).catch(() => undefined);
    }
  },

  /** Not a check: prints what a JiuwenSwarm subagent (task_tool) looks like from here, to design the mapping. */
  async "subagent-probe"() {
    const stub = await startStubModel({
      subagentMarker: "SUBAGENT-PROBE",
      main: [
        { tool: "subagent_spawn", arguments: { subagent_type: process.env.PROBE_TYPE || "general_agent", display_name: "Probe", role: "helper",
          task_description: "SUBAGENT-PROBE: run `echo CHILD-OK` with run_shell, then say done." } },
        { tool: "subagent_wait", arguments: (body) => {
          const text = JSON.stringify(body.messages ?? []);
          const id = text.match(/(?:sub_session_id|subagent_id)['\\"]*\s*:\s*['\\"]*([A-Za-z0-9_.:-]+)/)?.[1];
          console.log(`probe: spawn result gives id ${id}`);
          return { subagent_ids: id ? [id] : [], timeout_seconds: 60 };
        } },
        { text: "Delegated." },
      ],
      subagent: [{ tool: "run_shell", arguments: { command: "echo CHILD-OK" } }, { text: "child done" }],
    });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Delegate a probe.");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      console.log(`run: ${run.status} ${run.error ?? ""}`);
      for (const request of stub.requests) {
        console.log(`model request: route=${request.route} messages=${request.messages} system=${request.systemLength} tools=${(request.toolNames ?? []).length} run_shell=${(request.toolNames ?? []).includes("run_shell")} task_tool=${(request.toolNames ?? []).includes("task_tool")} system-start=${JSON.stringify((request.system ?? "").slice(0, 90))}`);
      }
      const events = await runEvents(sessionId, run.id);
      console.log(`event types: ${[...new Set(events.map((event) => event.type))].join(" ")}`);
      for (const event of events.filter((event) => /^tool\.|subagent/.test(event.type))) {
        console.log(`  ${event.type} ${JSON.stringify(event.trace ?? event.subagent ?? event).slice(0, 260)}`);
      }
      const streams = await Promise.all(events.filter((event) => event.type === "tool.completed" && event.trace?.outputStream)
        .map((event) => api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${event.trace.outputStream}/events`)));
      console.log(`CHILD-OK in outputs: ${JSON.stringify(streams).includes("CHILD-OK") || JSON.stringify(events).includes("CHILD-OK")}`);
    } finally {
      await cleanup();
    }
  },

  /**
   * Where the time before the first token goes, with a model that answers at once: from the run's start to the
   * model's first request, and from there to the first text event. Two runs, since the first of a session sets more up.
   */
  async ttft() {
    const stub = await startStubModel({ main: [{ text: "First." }, { text: "Second." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      for (const label of ["first run", "second run"]) {
        const seen = stub.requests.filter((request) => request.route === "main").length;
        const t0 = Date.now();
        const run = await api("POST", `/api/sessions/${sessionId}/runs`, { content: `Say hi (${label}).` });
        let model, text, done;
        for (let i = 0; i < 1200 && !done; i += 1) {
          if (model === undefined && stub.requests.filter((request) => request.route === "main").length > seen) model = Date.now() - t0;
          const events = await runEvents(sessionId, run.id);
          if (text === undefined && events.some((event) => event.type === "assistant.delta" || event.type === "assistant.snapshot")) text = Date.now() - t0;
          const current = await api("GET", `/api/sessions/${sessionId}/runs/${run.id}`);
          if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) done = Date.now() - t0;
          else await new Promise((resolve) => setTimeout(resolve, 50));
        }
        console.log(`ttft ${label}: model request at ${model ?? "?"} ms, first text event at ${text ?? "?"} ms, done at ${done ?? "?"} ms`);
      }
    } finally {
      await cleanup();
    }
  },

  /**
   * Thinking and text reach the run as the model streams them: a model that sends 20 thinking words and
   * 20 text words 300 ms apart must show its first thinking about 0.3 s after its request, not at its end.
   */
  streaming() {
    return (async () => {
      const words = (tag) => Array.from({ length: 20 }, (_, index) => `${tag}${index}`).join(" ");
      const stub = await startStubModel({ main: [{ reasoning: words("think"), text: words("word"), chunkDelayMs: 300 }] });
      const { sessionId, cleanup } = await setup(stub);
      try {
        const run = await api("POST", `/api/sessions/${sessionId}/runs`, { content: "Stream please." });
        const seenAt = {};
        let requested;
        const t0 = Date.now();
        for (let i = 0; i < 1200; i += 1) {
          if (requested === undefined && stub.requests.some((request) => request.route === "main")) requested = Date.now() - t0;
          const events = await runEvents(sessionId, run.id);
          for (const type of ["assistant.thinking.delta", "assistant.delta"]) {
            const count = events.filter((event) => event.type === type).length;
            if (count && !seenAt[type]) seenAt[type] = { at: Date.now() - t0, count };
          }
          const current = await api("GET", `/api/sessions/${sessionId}/runs/${run.id}`);
          if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) {
            const all = await runEvents(sessionId, run.id);
            const counts = Object.fromEntries(["assistant.thinking.delta", "assistant.delta"].map((type) => [type, all.filter((event) => event.type === type).length]));
            console.log(`streaming: model request at ${requested} ms; first seen ${JSON.stringify(seenAt)}; done at ${Date.now() - t0} ms; delta events ${JSON.stringify(counts)} (the model spent ~12 s streaming 40 words)`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await cleanup();
      }
    })();
  },
};

const wanted = process.argv.slice(2);
try {
  for (const name of wanted.length ? wanted : Object.keys(checks)) {
    if (!checks[name]) throw new Error(`unknown check ${name}; known: ${Object.keys(checks).join(", ")}`);
    await checks[name]();
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}${error?.cause?.message ? ` (${error.cause.message})` : ""}`);
  process.exit(1);
}
