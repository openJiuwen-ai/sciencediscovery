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

/** A terminal user follows and controls both long-running engines with the CLI.
 * Run: node test/api/engine-cli-journey.mjs
 * Requires the built API and launcher and the locked services/evolve/.venv (UT preparation supplies them).
 * The CLI is the built entry point `node services/launcher/dist/main.js`, reading the access token from the
 * data directory exactly as `run` does; stdout is a pipe, so JSONL is the default as for any script.
 * Steps: start an isolated API + real research sidecar + local model stub; read a recorded evolve search
 * (list/get/candidate/watch/resume/stop/missing); follow a live search on the real evolve routes and
 * orchestrator through a dropped connection, then stop it from the CLI; drive an Idea Tree research
 * through watch/pause/continue/stop and a completed research. No Runner, full stack or paid calls.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const launcherMain = resolve(repoRoot, 'services/launcher/dist/main.js');
const apiModule = (path) => import(pathToFileURL(resolve(repoRoot, 'services/api/dist', path)).href);

/** The goal shape a confirmed `/evolve-design` produces, on the stub engine (no dataset). */
const stubGoal = (statement) => ({
  algorithm: 'puct', baselineProgramCas: 'sha256:baseline', engine: 'stub', thinking: 'disabled', frozen: [], modelId: 'model-1',
  budget: { candidateTimeoutSeconds: 60, expansions: 4, maxCostCents: 500, maxSeconds: 1800, maxTokens: 200000, maxTokensPerCall: 16000, workers: 1 },
  scorecard: {
    aggregate: 'weighted_sum', confirmedAt: '2026-10-25T00:00:00.000Z', confirmedBy: 'tester', constraints: [],
    criteria: [{ direction: 'maximize', id: 'f1', name: 'f1', normalize: { kind: 'identity' }, weight: 1, measure: {
      datasetCas: ['sha256:data'], kind: 'dataset_metric', metric: { direction: 'maximize', name: 'f1' }, target: 'y',
      split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 10, testShards: 4, trainRows: null } } }],
    derivedFrom: { draftRunId: 'draft', statement }, hash: 'sha256:card', schemaVersion: 1, solvedThreshold: 0.999,
  },
  schemaVersion: 2, statement, target: { entrypoint: 'main.py', kind: 'program', programId: 'p' },
});

export async function runEngineCliJourney({ pythonExecutable = resolve(repoRoot, 'services/evolve/.venv/bin/python') } = {}) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: repoRoot }).trim();
  const root = resolve(repoRoot, '.tmp', `engine-cli-journey-${randomUUID()}`);
  const apiData = resolve(root, 'api');
  await mkdir(resolve(apiData, 'secrets'), { recursive: true });
  const secret = randomUUID(), internal = randomUUID(), providerKey = randomUUID();
  // Stored the way `serve` stores it; neither the API nor the CLI is given it any other way.
  await writeFile(resolve(apiData, 'secrets', 'auth-token'), `${secret}\n`, { mode: 0o600 });
  const children = [], steps = [], servers = [];
  let outcome = 'FAIL', origin, apiPort, sidecarOrigin;
  const redact = value => String(value).replaceAll(secret, '[redacted]').replaceAll(internal, '[redacted]').replaceAll(providerKey, '[redacted]');
  const until = async (fn, timeout = 30000, what = 'condition') => { const end = Date.now() + timeout; for (;;) { const result = await fn(); if (result) return result; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 30)); } };
  const instrumentation = Object.fromEntries(['NODE_V8_COVERAGE', 'COVERAGE_PROCESS_START', 'SCIENCE_COVERAGE_DATA_DIR', 'SCIENCE_COVERAGE_PROCESS_LOG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const start = async (command, args, env, pattern, name) => {
    const child = spawn(command, args, { cwd: repoRoot, env: { PATH: process.env.PATH, NODE_OPTIONS: '--max-old-space-size=768', ...instrumentation, ...env, ...(instrumentation.COVERAGE_PROCESS_START ? { PYTHONPATH: resolve(repoRoot, 'test/support/tagged/python/coverage-hook') + ':' + (env.PYTHONPATH ?? '') } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, name, log: '', url: '', error: null, closed: false }; children.push(state);
    child.once('error', error => { state.error = error; });
    child.once('close', () => { state.closed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { state.log += redact(b); state.url ||= b.toString().match(pattern)?.[1] ?? ''; });
    await until(() => { if (state.error) throw new Error(`${name} could not start: ${redact(state.error.message)}`); if (state.closed) throw new Error(`${name} exited: ${state.log}`); return state.url; }, 30000, `${name} to start`);
    return state.url;
  };
  const listen = async (server) => { servers.push(server); await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; };

  // The CLI as a script runs it: stdout is a pipe, the working directory has no .env, and the token
  // comes only from --data-dir. `lines` parses every stdout line, so a non-JSON line fails the step.
  let cliRuns = 0;
  const spawnCli = (args, { port = apiPort } = {}) => {
    const name = `cli-${++cliRuns}-${args.slice(0, 2).join('-')}`;
    const child = spawn(process.execPath, [launcherMain, ...args, '--data-dir', apiData, '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { PATH: process.env.PATH, ...instrumentation }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, name, args, stdout: '', stderr: '', code: null, closed: false, get log() { return `$ ${args.join(' ')}\n${redact(this.stdout)}${redact(this.stderr)}exit ${this.code}\n`; } };
    children.push(state);
    child.stdout.on('data', b => { state.stdout += b; });
    child.stderr.on('data', b => { state.stderr += b; });
    state.done = new Promise(r => child.once('close', code => { state.code = code; state.closed = true; r(state); }));
    // Complete lines only: a watch still running may be mid-line.
    state.lines = () => state.stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    return state;
  };
  const cli = async (args, options) => { const state = spawnCli(args, options); await until(() => state.closed, 30000, `${args.join(' ')} to exit`); return state; };
  const step = async (name, expected, work) => { try { const actual = await work(); steps.push({ name, expected, actual, status: 'PASS' }); } catch (e) { steps.push({ name, expected, actual: redact(e.stack), status: 'FAIL' }); throw e; } };

  // Local model stub. While `hold` is set every request waits, which keeps a research running on demand.
  let hold = false; const waiting = []; let modelRequests = 0;
  const release = () => { hold = false; waiting.splice(0).forEach(r => r()); };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); modelRequests += 1;
    if (hold) await new Promise(r => waiting.push(r));
    const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const value = system.includes('matching: {"candidates"') ? { candidates: [{ parentId: 'ROOT', hypothesis: 'Synthetic hypothesis' }], reason: 'One bounded synthetic comparison' }
      : system.includes('"score":1.0') ? { text: 'Synthetic independent assessment', score: 8 }
      : system.includes('"strengths":[]') ? { text: 'Synthetic aggregation', strengths: [], failureModes: [], uncertainties: [], evidenceGaps: [], recommendedNextMoves: [], constraintFlags: [], confidence: 0.5 }
      : { text: 'Synthetic design or propagation' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
  });
  const providerOrigin = `http://127.0.0.1:${await listen(provider)}`;

  try {
    // A finished search, recorded on disk the way the evolve store writes one.
    const recordedId = randomUUID(), digest = 'ab'.repeat(32), candidateSource = 'def predict(rows):\n    return [row["x"] > 0.42 for row in rows]\n';
    const recordedEvents = [
      { type: 'search_started', algorithm: 'puct', scorecardHash: 'sha256:card' },
      { type: 'seeded', nodeIndex: 0, baselineScore: 0.5 },
      { type: 'expanded', nodeIndex: 1, parentIndex: 0, depth: 1, score: 0.58, valid: true, changeSummary: 'raise the threshold', codeHash: `sha256:${'cd'.repeat(32)}` },
      { type: 'expanded', nodeIndex: 2, parentIndex: 1, depth: 2, score: 0.66, valid: true, changeSummary: 'threshold at 0.42', codeHash: `sha256:${digest}` },
      { type: 'merged', nodeIndex: 2, accepted: true, reason: 'the hold-out gate score improved' },
      { type: 'search_finished', status: 'succeeded', candidates: 2, bestNodeIndex: 2, stopReason: 'max_iters' },
    ];
    const recordedRun = { algorithm: 'puct', bestNodeIndex: 2, candidates: 2, costCents: 3, createdAt: '2026-10-25T08:00:00.000Z', startedAt: '2026-10-25T08:00:01.000Z', finishedAt: '2026-10-25T08:05:00.000Z', goal: stubGoal('Raise the hold-out F1 of the threshold rule'), id: recordedId, lastSeq: recordedEvents.length, sessionId: 'recorded-session', status: 'succeeded', tokens: 1800 };
    await mkdir(resolve(apiData, 'evolution', 'runs', recordedId), { recursive: true });
    await writeFile(resolve(apiData, 'evolution', 'runs', recordedId, 'run.json'), JSON.stringify(recordedRun));
    await writeFile(resolve(apiData, 'evolution', 'runs', recordedId, 'events.ndjson'), recordedEvents.map((event, index) => JSON.stringify({ createdAt: '2026-10-25T08:01:00.000Z', event, sequence: index + 1 })).join('\n') + '\n');
    await mkdir(resolve(apiData, 'evolve-candidates', recordedId), { recursive: true });
    await writeFile(resolve(apiData, 'evolve-candidates', recordedId, `${digest}.py`), candidateSource);

    await step('1. Start the API, research sidecar and model stub', 'Healthy isolated services; the token exists only in the data directory', async () => {
      sidecarOrigin = await start(pythonExecutable, ['-m', 'uvicorn', 'sciencediscovery_evolve.server:app', '--host', '127.0.0.1', '--port', '0'], { SCIENCE_AGENT_DATA_DIR: resolve(root, 'sidecar'), SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal, PYTHONPATH: resolve(repoRoot, 'services/evolve/src') }, /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/, 'sidecar');
      const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
      apiPort = reservation.address().port; await new Promise(r => reservation.close(r));
      origin = await start(process.execPath, [resolve(repoRoot, 'services/api/dist/server.js')], { SCIENCE_AGENT_DATA_DIR: apiData, SCIENCE_AGENT_HOST: '127.0.0.1', SCIENCE_AGENT_PORT: String(apiPort), SCIENCE_AGENT_EVOLVE_URL: sidecarOrigin, SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal, SCIENCE_AGENT_RUNNER_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_MEMORY_GRAPH_URL: 'http://127.0.0.1:1' }, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 'api');
      assert.equal((await fetch(origin + '/api/evolve/runs')).status, 401);
      return `API ${origin}; unauthenticated evolve list refused`;
    });

    await step('2. Read a recorded evolve search from the CLI', 'list/get/candidate/watch/resume/stop answer from the real routes; every piped line is JSON', async () => {
      const list = await cli(['evolve', 'list']);
      assert.equal(list.code, 0, list.log);
      assert.deepEqual(list.lines().map(run => [run.id, run.status]), [[recordedId, 'succeeded']]);
      const text = await cli(['evolve', 'get', recordedId, '--output', 'text']);
      assert.equal(text.code, 0, text.log);
      assert.match(text.stdout, /^Status\s+succeeded$/m); assert.match(text.stdout, /^Candidates\s+2\/4$/m); assert.match(text.stdout, /^Best node\s+2$/m);
      const candidate = await cli(['evolve', 'get', recordedId, '--candidate', `sha256:${digest}`]);
      assert.deepEqual(candidate.lines(), [{ hash: `sha256:${digest}`, source: candidateSource }]);
      const source = await cli(['evolve', 'get', recordedId, '--candidate', `sha256:${digest}`, '--output', 'text']);
      assert.equal(source.stdout, candidateSource);
      const watch = await cli(['evolve', 'watch', recordedId]);
      assert.equal(watch.code, 0, watch.log);
      const lines = watch.lines();
      assert.deepEqual(lines.filter(line => 'sequence' in line).map(line => line.event.type), recordedEvents.map(event => event.type));
      assert.deepEqual(lines.at(-1), { type: 'result', runId: recordedId, sessionId: 'recorded-session', status: 'succeeded', candidates: 2, bestNodeIndex: 2, error: null, lastSequence: 6 });
      const resumed = await cli(['evolve', 'watch', recordedId, '--after', '4']);
      assert.deepEqual(resumed.lines().filter(line => 'sequence' in line).map(line => line.sequence), [5, 6]);
      const stop = await cli(['evolve', 'stop', recordedId]);
      assert.equal(stop.code, 0, stop.log); assert.equal(stop.lines()[0].status, 'succeeded');
      const missing = await cli(['evolve', 'get', 'no-such-run']);
      assert.equal(missing.code, 1); assert.deepEqual(missing.lines(), [{ type: 'error', message: 'Evolve run not found: no-such-run', code: 'NOT_FOUND', runId: 'no-such-run' }]);
      return `list/get/candidate/watch (6 events, exit 0)/--after 4 (2 events)/stop on a finished run/missing id (exit 1)`;
    });

    await step('3. Follow a live search through a dropped connection, then stop it from the CLI', 'Watch resumes after its cursor with no gap or repeat; the CLI stop ends the run stopped and the watch exits 130', async () => {
      // The real evolve handlers, store and orchestrator, mounted as `http/index.ts` mounts them; a
      // sidecar stub streams one candidate every 100 ms until it is told to stop.
      const [{ handleListRuns, handleRunEvents, handleStopRun, handleGetCandidate }, { EvolutionStore }, { EvolveOrchestrator }, { EvolveSidecarClient }, { CandidateSources }] = await Promise.all(['evolution/routes.js', 'evolution/store.js', 'evolution/orchestrator.js', 'evolution/sidecar.js', 'evolution/candidates.js'].map(apiModule));
      const stops = new Set();
      const sidecar = createServer(async (req, res) => {
        if (req.url.endsWith('/stop')) { stops.add(decodeURIComponent(req.url.split('/')[2])); res.writeHead(200, { 'content-type': 'application/json' }).end('{"stopped":true}'); return; }
        let raw = ''; for await (const b of req) raw += b;
        const spec = JSON.parse(raw); let sequence = 0, node = 0;
        const emit = event => res.write(JSON.stringify({ createdAt: new Date().toISOString(), event, sequence: ++sequence }) + '\n');
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        emit({ type: 'search_started', algorithm: 'puct', scorecardHash: spec.scorecard_hash }); emit({ type: 'seeded', nodeIndex: 0, baselineScore: 0.5 });
        const timer = setInterval(() => {
          if (stops.has(spec.search_id) || node >= 300) { clearInterval(timer); emit({ type: 'search_finished', status: stops.has(spec.search_id) ? 'stopped' : 'succeeded', candidates: node, bestNodeIndex: null }); res.end(); return; }
          node += 1; emit({ type: 'expanded', nodeIndex: node, parentIndex: 0, depth: 1, score: 0.5 + node / 1000, valid: true, changeSummary: `step ${node}` });
        }, 100);
        res.on('close', () => clearInterval(timer));
      });
      const liveData = resolve(root, 'live');
      const store = new EvolutionStore(liveData); await store.initialize();
      const orchestrator = new EvolveOrchestrator(store, new EvolveSidecarClient({ internalToken: internal, url: `http://127.0.0.1:${await listen(sidecar)}` }));
      const routes = createServer((request, response) => void (async () => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/api/health') return response.writeHead(200).end('{"status":"ok"}');
        if (request.headers.authorization !== `Bearer ${secret}`) return response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
        if (url.pathname === '/api/evolve/runs') return handleListRuns(response, store, url.searchParams.get('sessionId'));
        const match = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/(events|stop|candidates\/([^/]+))$/);
        if (match?.[2] === 'events') return handleRunEvents(request, response, store, orchestrator, decodeURIComponent(match[1]), Number(url.searchParams.get('after') ?? '0'));
        if (match?.[2] === 'stop' && request.method === 'POST') return handleStopRun(response, store, orchestrator, decodeURIComponent(match[1]));
        if (match?.[3]) return handleGetCandidate(response, store, new CandidateSources(liveData), decodeURIComponent(match[1]), decodeURIComponent(match[3]));
        response.writeHead(404).end();
      })().catch(error => response.destroy(error)));
      const routesPort = await listen(routes);
      const live = await orchestrator.start({ goal: stubGoal('Live threshold search'), sessionId: 'live-session' });
      const watch = spawnCli(['evolve', 'watch', live.id], { port: routesPort });
      const before = await until(() => { const seen = watch.lines().filter(line => 'sequence' in line); return seen.length >= 4 && seen; }, 30000, 'live events');
      routes.closeAllConnections(); // the network drops under the watch
      await until(() => watch.lines().some(line => line.type === 'reconnect') && watch.lines().filter(line => 'sequence' in line).length >= before.length + 3, 30000, 'the watch to reconnect and continue');
      const stop = await cli(['evolve', 'stop', live.id], { port: routesPort });
      assert.equal(stop.code, 0, stop.log); assert.deepEqual(stop.lines(), [{ runId: live.id, stopping: true }]);
      await until(() => watch.closed, 30000, 'the watch to end');
      assert.equal(watch.code, 130, watch.log);
      const lines = watch.lines(), sequences = lines.filter(line => 'sequence' in line).map(line => line.sequence);
      assert.deepEqual(sequences, sequences.map((_, index) => index + 1), 'every event exactly once, in order');
      const reconnect = lines.find(line => line.type === 'reconnect');
      assert.ok(reconnect.after >= before.at(-1).sequence, JSON.stringify(reconnect));
      assert.equal(lines.at(-2).event.type, 'search_finished'); assert.equal(lines.at(-2).event.status, 'stopped');
      assert.equal(lines.at(-1).type, 'result'); assert.equal(lines.at(-1).status, 'stopped');
      assert.equal((await store.readRun(live.id)).status, 'stopped');
      const text = await cli(['evolve', 'get', live.id, '--output', 'text'], { port: routesPort });
      assert.match(text.stdout, /^Status\s+stopped$/m);
      return `${sequences.length} events once each across a reconnect after sequence ${reconnect.after}; CLI stop -> run stopped, watch exit 130`;
    });

    let session, researchA, researchB;
    await step('4. Watch an Idea Tree research, pause it from the CLI', 'The watch streams the running research and exits 130 once it is paused', async () => {
      const model = await (await fetch(origin + '/api/models', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'synthetic-research', name: 'Synthetic research model', baseUrl: providerOrigin + '/v1', apiProtocol: 'openai-chat-completions', apiToken: providerKey, proxyPolicy: 'none' }) })).json();
      const api = async (path, body) => { const r = await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const json = await r.json(); assert.ok(r.ok, JSON.stringify(json)); return json; };
      const project = await api('/api/projects', { name: 'Engine CLI' });
      session = await api(`/api/projects/${project.id}/sessions`, { title: 'Engine CLI research', modelId: model.id });
      hold = true;
      // Started the way the composer starts it; the CLI only follows and controls.
      researchA = (await api(`/api/sessions/${session.id}/idea-tree/research`, { content: '/idea-tree Compare two synthetic hypotheses', settings: { explorationIntensity: 'quick', maxNodes: 2, maxDepth: 1, maxTokensPerCall: 256, maxTokens: 600000 } })).research;
      await until(() => waiting.length > 0, 30000, 'the first model call');
      const list = await cli(['idea', 'list', '--session', session.id]);
      assert.equal(list.code, 0, list.log); assert.deepEqual(list.lines().map(view => [view.research.id, view.research.status]), [[researchA.id, 'running']]);
      const watch = spawnCli(['idea', 'watch', researchA.id, '--session', session.id]);
      await until(() => watch.stdout.includes('\n'), 30000, 'the first view');
      const pause = await cli(['idea', 'pause', researchA.id, '--session', session.id]);
      assert.equal(pause.code, 0, pause.log); assert.ok(['pausing', 'paused'].includes(pause.lines()[0].research.status));
      release();
      await until(() => watch.closed, 30000, 'the watch to end');
      assert.equal(watch.code, 130, watch.log);
      const lines = watch.lines();
      assert.equal(lines[0].research.status, 'running');
      const result = lines.at(-1);
      assert.deepEqual({ ...result, reason: undefined }, { type: 'result', researchId: researchA.id, sessionId: session.id, status: 'paused', reason: undefined, scored: 0 });
      assert.match(result.reason, /by user$/);
      const get = await cli(['idea', 'get', researchA.id, '--session', session.id, '--output', 'text']);
      assert.match(get.stdout, /^Status\s+paused$/m);
      return `${lines.length - 1} views (running -> paused); exit 130; get shows paused`;
    });

    await step('5. Continue it, then stop it from the CLI as the card ends it', 'The research ends with "Ended by user", a text watch exits 130, and an ended research refuses continue', async () => {
      hold = true;
      const resume = await cli(['idea', 'continue', researchA.id, '--session', session.id]);
      assert.equal(resume.code, 0, resume.log); assert.equal(resume.lines()[0].research.status, 'running');
      await until(() => waiting.length > 0, 30000, 'the resumed model call');
      const watch = spawnCli(['idea', 'watch', researchA.id, '--session', session.id, '--output', 'text']);
      await until(() => watch.stdout.includes('running'), 30000, 'the first text line');
      const stop = await cli(['idea', 'stop', researchA.id, '--session', session.id, '--output', 'text']);
      assert.equal(stop.code, 0, stop.log); assert.match(stop.stdout, /^Research research-\S+ (will end after the step in progress|is ended)/);
      release();
      await until(() => watch.closed, 30000, 'the text watch to end');
      assert.equal(watch.code, 130, watch.log);
      assert.match(watch.stdout, /^running · /m); assert.match(watch.stdout, /^ended · /m);
      assert.match(watch.stderr, new RegExp(`\\[idea\\] ${researchA.id} ended: \\w+ by user`));
      const ended = (await cli(['idea', 'get', researchA.id, '--session', session.id])).lines()[0].research;
      assert.equal(ended.status, 'ended'); assert.match(ended.reason, /by user$/);
      const refused = await cli(['idea', 'continue', researchA.id, '--session', session.id]);
      assert.equal(refused.code, 1); assert.equal(refused.lines()[0].type, 'error'); assert.match(refused.lines()[0].message, /not resumable/);
      return 'continue -> running; stop -> ended (Ended by user); watch exit 130; continue after end refused (exit 1)';
    });

    await step('6. Watch a research to completion', 'The watch exits 0 with the completed status and the scored candidate', async () => {
      const r = await fetch(`${origin}/api/sessions/${session.id}/idea-tree/research`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: '/idea-tree Compare one synthetic hypothesis', settings: { explorationIntensity: 'quick', maxNodes: 2, maxDepth: 1, maxTokensPerCall: 256, maxTokens: 600000 } }) });
      researchB = (await r.json()).research; assert.equal(r.status, 200);
      const watch = await cli(['idea', 'watch', researchB.id, '--session', session.id]);
      assert.equal(watch.code, 0, watch.log);
      const result = watch.lines().at(-1);
      assert.equal(result.status, 'completed'); assert.ok(result.scored >= 1, JSON.stringify(result));
      const list = await cli(['idea', 'list', '--session', session.id, '--output', 'text']);
      assert.match(list.stdout, new RegExp(`^${researchB.id}\\s+completed`, 'm')); assert.match(list.stdout, new RegExp(`^${researchA.id}\\s+ended`, 'm'));
      return `completed with ${result.scored} scored candidate(s); ${modelRequests} model calls in the journey`;
    });
    outcome = 'PASS';
  } finally {
    release();
    for (const state of [...children].reverse()) {
      if (!state.closed) {
        state.child.kill('SIGTERM');
        await until(() => state.closed, 5000).catch(async () => { state.child.kill('SIGKILL'); await until(() => state.closed, 5000); });
      }
    }
    for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await writeFile(resolve(root, 'cli.log'), children.filter(state => state.args).map(state => state.log).join('\n'));
    for (const state of children.filter(state => !state.args)) await writeFile(resolve(root, `${state.name}.log`), state.log);
    await writeFile(resolve(root, 'steps.json'), JSON.stringify({ sha, outcome, steps, paidRequests: 0 }, null, 2));
    await writeFile(resolve(root, 'report.md'), `# Engine CLI journey: ${outcome}\n\nSHA: ${sha}\nAPI: ${origin}\nSidecar: ${sidecarOrigin}\nNo Runner/full stack or paid providers.\n\n${steps.map(s => `- ${s.name}: ${s.status}\n  Expected: ${s.expected}\n  Actual: ${s.actual}`).join('\n')}\n`);
    console.log(JSON.stringify({ sha, outcome, report: resolve(root, 'report.md') }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runEngineCliJourney();
