// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, fileDigest, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import { hostPlatform, hostArch } from '../test/support/tagged/environment.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { PROVIDER_FAULT, detectProviderFault, detectProviderFaultFromErrors, isProviderFaultOnlyWorkerFailure } from '../test/support/tagged/provider-fault.mjs';
import { retryableCaseFailures, retryFailed, retryReportMissing, shouldRetryFailedCases } from '../test/support/tagged/retry.mjs';
import TaggedReporter from '../test/support/tagged/playwright-reporter.mjs';
import { reconcile } from './real-report.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = { os: hostPlatform(process.platform), arch: hostArch(process.arch) };

// The texts the Nightly of 2026-10-06 recorded, unchanged.
const GATEWAY_500 = "[181001] model call failed, reason: openAI API async stream error: InternalServerError: Error code: 500 - {'error': {'message': 'Database error...', 'type': 'new_api_error'}}";
const GATEWAY_503 = "[181001] model call failed, reason: openAI API async stream error: ServiceUnavailableError: Error code: 503 - {'error': {'message': 'No available channel for model deepseek-v4-flash...', 'type': 'model_not_found'}}";
const UNAUTHORIZED = "[181001] model call failed, reason: openAI API async stream error: AuthenticationError: Error code: 401 - {'error': {'message': 'scripted http401'}}";
const RATE_LIMITED = "[181001] model call failed, reason: openAI API async stream error: RateLimitError: Error code: 429 - {'error': {'message': 'scripted http429'}}";
const DELIVERY_MISS = 'Main run must complete with readable, nonempty declared final artifacts; delivery_status=failed; run_status=failed; delivered_artifacts=0; run_error=none';

// The text Nightly 45212568993 recorded for research-11, twice, unchanged.
const IDEA_TREE_502 = 'research settled as "interrupted": Model HTTP 502: {"error":"Model stream failed after response headers: read ECONNRESET"}';
// The same failure as Playwright reports it, with the failed expect() appended.
const IDEA_TREE_502_WRAPPED = `${IDEA_TREE_502}\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: "completed"\nReceived: "interrupted"`;

const directory = t => {
  const path = mkdtempSync(join(tmpdir(), 'provider-fault-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

/** One browser identity, as the tagged plan records it. */
const identity = (id, tags) => ({
  id, source: 'test/journey-basic-real-api.spec.ts',
  sourceHash: fileDigest(readFileSync(join(root, 'test/journey-basic-real-api.spec.ts'))),
  runner: 'playwright', requirements: [], tags,
});
const realTags = ['category:e2e', `os:${target.os}`, `arch:${target.arch}`, 'model:real', 'tier:l4'];
const mockedTags = ['category:e2e', `os:${target.os}`, `arch:${target.arch}`, 'model:mock', 'tier:l2'];
const realCaseTags = realTags.map(tag => `@${tag}`);
const mockedCaseTags = mockedTags.map(tag => `@${tag}`);

/** A Playwright test case, as the reporter sees it. */
const browserCase = (title, tags) => ({
  location: { file: join(root, 'test/journey-basic-real-api.spec.ts') },
  titlePath: () => ['real', title],
  annotations: [],
  tags,
});

/** The identity the reporter derives from one browser case. */
const browserId = title => `playwright:test/journey-basic-real-api.spec.ts::real/${encodeURIComponent(title)}`;

/** Run the tagged reporter over one browser result and return what it wrote. */
function report(t, { title, tags, status, errors, duration }) {
  const plan = createPlan([identity(browserId(title), tags.map(tag => tag.slice(1)))], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const home = directory(t);
  const planPath = join(home, 'plan.json');
  const reportPath = join(home, 'report.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const previous = { plan: process.env.SCIENCE_TAG_PLAN, report: process.env.SCIENCE_TAG_PW_REPORT };
  process.env.SCIENCE_TAG_PLAN = planPath;
  process.env.SCIENCE_TAG_PW_REPORT = reportPath;
  try {
    const reporter = new TaggedReporter();
    const testCase = browserCase(title, tags);
    reporter.onBegin({ workers: 1, fullyParallel: false }, { allTests: () => [testCase] });
    reporter.onTestEnd(testCase, { status, errors: errors.map(message => ({ message })), duration });
    reporter.onEnd();
  } finally {
    if (previous.plan === undefined) delete process.env.SCIENCE_TAG_PLAN; else process.env.SCIENCE_TAG_PLAN = previous.plan;
    if (previous.report === undefined) delete process.env.SCIENCE_TAG_PW_REPORT; else process.env.SCIENCE_TAG_PW_REPORT = previous.report;
  }
  return { plan, written: JSON.parse(readFileSync(reportPath, 'utf8')) };
}

test('a gateway 500 with the gateway own codes is a provider fault, not a product failure', () => {
  const fault = detectProviderFault(GATEWAY_500);
  assert.equal(fault.code, 'provider-server-error');
  assert.equal(fault.status, 500);
  // The gateway's routing failures name themselves even without a status.
  assert.equal(detectProviderFault(GATEWAY_503).status, 503);
  assert.equal(detectProviderFault(GATEWAY_503).code, 'provider-server-error');
  assert.equal(detectProviderFault('No available channel for model deepseek-v4-flash').code, 'provider-unavailable');
});

test('an unauthorized, rate-limited or semantic failure is never a transient gateway fault', () => {
  assert.equal(detectProviderFault(UNAUTHORIZED), null);
  assert.equal(detectProviderFault(RATE_LIMITED), null);
  assert.equal(detectProviderFault(DELIVERY_MISS), null);
  assert.equal(detectProviderFault('The final handoff must identify a report, not only intermediate notes'), null);
  // The product's own answer is not the gateway's, even with a status in it.
  assert.equal(detectProviderFault('/api/sessions/abc -> 500: {"error":"Internal Server Error"}'), null);
  assert.equal(detectProviderFault('Agent run stalled: no assistant progress for 600000 ms'), null);
  assert.equal(detectProviderFault('Test timeout of 240000ms exceeded.'), null);
});

test('an assertion beside a gateway outage does not hide the outage', () => {
  // Playwright appends the failed expect() to the error it saw, so the case
  // records the gateway's 503 and `Expected:/Received:` together. The
  // assertion line must not veto the fault (#813).
  const mixed = detectProviderFaultFromErrors([GATEWAY_503, 'Expected: "completed", Received: "failed"']);
  assert.equal(mixed.code, 'provider-server-error');
  assert.equal(mixed.status, 503);
  assert.equal(detectProviderFaultFromErrors([GATEWAY_500]).code, 'provider-server-error');
  // A delivery miss is the product's own verdict and still outranks the
  // gateway text recorded beside it.
  assert.equal(detectProviderFaultFromErrors([GATEWAY_500, DELIVERY_MISS]), null);
  assert.equal(detectProviderFaultFromErrors([]), null);
});

test('a stream that broke after a 200 classifies at case level too', () => {
  // The product's report wraps the transport break in `delivery_status=failed`,
  // and Nightly recorded exactly that on DRB-58. The wrapper restates a run that
  // died on the transport after the provider answered whole, so it is not a
  // verdict of its own and must not keep the case out of the classification.
  const streamDied = 'Error: Main run must complete with readable, nonempty declared final artifacts; '
    + 'delivery_status=failed; run_status=failed; delivered_artifacts=0; '
    + 'run_error=[181001] model call failed, reason: openAI API async stream error: APIError: read ECONNRESET';
  assert.deepEqual(detectProviderFaultFromErrors([streamDied]), { code: 'provider-transport', status: null });
  // An assertion wrapper beside it records nothing either.
  assert.deepEqual(
    detectProviderFaultFromErrors([streamDied, 'Expected: "completed", Received: "failed"']),
    { code: 'provider-transport', status: null },
  );
  // A delivery miss the case recorded in another text is still its own verdict.
  assert.equal(detectProviderFaultFromErrors([streamDied, DELIVERY_MISS]), null);
});

test('a decision or a stall beside a gateway outage still vetoes the case', () => {
  // A case records one text per failed expect() or hook, so the provider's
  // 401/429 answer or the product's stalled-run wording can sit beside a
  // sibling 503. Those texts are verdicts of their own, not assertion
  // wrappers, so they keep the case out of the soft classification.
  assert.equal(detectProviderFaultFromErrors([UNAUTHORIZED, GATEWAY_503]), null);
  assert.equal(detectProviderFaultFromErrors([RATE_LIMITED, GATEWAY_503]), null);
  assert.equal(detectProviderFaultFromErrors(['Agent run stalled: no assistant progress for 600000 ms', GATEWAY_503]), null);
  assert.equal(detectProviderFaultFromErrors(['Test timeout of 240000ms exceeded.', GATEWAY_500]), null);
  // One aggregated retry log can hold a decision and a break in the same text.
  // The decision still vetoes the case: the per-text rule answers `null` for it,
  // so the case veto must not read the break first and let a sibling 503 carry
  // an authentication or quota answer.
  const unauthorizedRetry = '[181001] model call failed after 2 attempts: attempt 1: openAI API answered Error code: 401 - unauthorized; attempt 2: read ECONNRESET';
  assert.equal(detectProviderFault(unauthorizedRetry), null);
  assert.equal(detectProviderFaultFromErrors([unauthorizedRetry, GATEWAY_503]), null);
  const rateLimitedRetry = '[181001] model call failed after 2 attempts: attempt 1: openAI API answered Error code: 429 - rate limit; attempt 2: socket hang up';
  assert.equal(detectProviderFault(rateLimitedRetry), null);
  assert.equal(detectProviderFaultFromErrors([rateLimitedRetry, GATEWAY_503]), null);
  // A timeout that names the gateway's own routing failure is the exception:
  // the per-text rule never masks a routing failure behind that wording.
  assert.equal(detectProviderFaultFromErrors(['No available channel for model deepseek-v4-flash; timed out', GATEWAY_503]).code,
    'provider-unavailable');
});

test('a gateway 504 whose wording says timeout is still the outage', () => {
  // The gateway names its own 504 in words a timeout also uses. The status and
  // its context outrank that wording, on its own and beside an assertion block.
  const gateway504 = "[181001] model call failed, reason: openAI API async stream error: GatewayTimeout: Error code: 504 - Gateway Timeout";
  assert.equal(detectProviderFault(gateway504).code, 'provider-server-error');
  assert.equal(detectProviderFault(gateway504).status, 504);
  const withAssertion = `${gateway504}\nExpected: "completed"\nReceived: "failed"`;
  assert.equal(detectProviderFault(withAssertion).status, 504);
  // The 504 text must not veto the case either, with or without a sibling 503,
  // and the order of the texts must not decide it.
  assert.equal(detectProviderFaultFromErrors([withAssertion]).status, 504);
  assert.equal(detectProviderFaultFromErrors([withAssertion, GATEWAY_503]).status, 504);
  assert.equal(detectProviderFaultFromErrors([GATEWAY_503, withAssertion]).status, 503);
  // A bare proxy-shaped 504 names no gateway context: it is a status the text
  // quotes, so it stays the product's and vetoes the case like the stalled-run
  // wording does.
  assert.equal(detectProviderFault('504 Gateway Timeout'), null);
  assert.equal(detectProviderFaultFromErrors(['504 Gateway Timeout', GATEWAY_503]), null);
  // A stalled-run text that embeds the gateway's own 5xx is the outage, because
  // the status and its context outrank the timeout wording in the same text.
  const stalledOnGateway = 'Agent run stalled: no assistant progress for 600000 ms; run_error=[181001] model call failed, Error code: 503';
  assert.equal(detectProviderFault(stalledOnGateway).status, 503);
  assert.equal(detectProviderFaultFromErrors([stalledOnGateway]).status, 503);
});

test('a text that records what one step printed is outvoted by a sibling outage', () => {
  // Pinned as documented: the four verdicts above are the only texts that keep
  // a case out, so a product-side message beside a gateway 5xx still lets the
  // outage carry the case.
  assert.equal(detectProviderFault('/api/sessions/abc -> 500: {"error":"Internal Server Error"}'), null);
  assert.equal(detectProviderFaultFromErrors(['/api/sessions/abc -> 500: {"error":"Internal Server Error"}', GATEWAY_503]).status, 503);
  assert.equal(detectProviderFault('No final report identified; declared intermediate files are insufficient'), null);
  assert.equal(detectProviderFaultFromErrors(['No final report identified; declared intermediate files are insufficient', GATEWAY_503]).status, 503);
});

test('one text holding the gateway error and the assertion block is still the outage', () => {
  const mixed = `${GATEWAY_503}\nexpect(received).toBe(expected) // Object.is equality\nExpected: "completed"\nReceived: "failed"`;
  assert.equal(detectProviderFault(mixed).status, 503);
  assert.equal(detectProviderFault(mixed).code, 'provider-server-error');
});

test('a product failure that quotes a provider status is never soft-classified', () => {
  // "provider", "llm", "gateway" and "upstream" are the words any product
  // text that quotes a provider status says too. They are not a provider
  // context, so a delivery failure that mentions one stays a product failure.
  assert.equal(detectProviderFault('delivery failed; provider said HTTP 500'), null);
  assert.equal(detectProviderFault('upstream returned HTTP 503 while the run was still going'), null);
  assert.equal(detectProviderFault('the llm gateway answered HTTP 500'), null);
  assert.equal(detectProviderFault('the provider endpoint returned HTTP 502'), null);
  // The product's own report of a delivery miss stays the product's own
  // report, even when it carries the provider's words with it.
  assert.equal(detectProviderFault(`${DELIVERY_MISS}; run_error=${GATEWAY_500}`), null);
  assert.equal(detectProviderFault('Main run must complete and reference a readable nonempty final artifact; Expected: "passed"; Received: "failed"'), null);
  // The gateway's own report is still a provider fault.
  assert.equal(detectProviderFault(GATEWAY_500).code, 'provider-server-error');
  assert.equal(detectProviderFault(GATEWAY_503).code, 'provider-server-error');
  assert.equal(detectProviderFault('Error: Main run failed: ' + GATEWAY_500).code, 'provider-server-error');
});

test('Idea Tree relaying the provider 502 is a provider fault, not a product failure', t => {
  // Idea Tree's transport raises `Model HTTP <status>: <body>` for the answer
  // the model endpoint gave (research.py), so the 502 that carried a broken
  // stream is the gateway's outage (#1340). It must classify without the
  // gateway's own 181001/model-call vocabulary and reach the accounting as a
  // fault instead of `FAIL`.
  assert.deepEqual(detectProviderFault(IDEA_TREE_502), { code: 'provider-transport', status: null });
  assert.deepEqual(detectProviderFaultFromErrors([IDEA_TREE_502_WRAPPED]),
    { code: 'provider-transport', status: null });
  const { plan, written } = report(t, {
    title: 'research-11', tags: realCaseTags, status: 'failed', errors: [IDEA_TREE_502_WRAPPED], duration: 174_000,
  });
  assert.equal(written.results[0].outcome, PROVIDER_FAULT);
  assert.deepEqual(written.results[0].providerFault, { code: 'provider-transport', status: null });
  assert.deepEqual(written.results[0].errors, [IDEA_TREE_502_WRAPPED]);
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.providerFaults, 1);
  assert.equal(verdict.failed, 0);
  assert.ok(!verdict.problems.some(problem => problem.startsWith('FAIL:')));
  // A relayed 5xx without a transport break keeps the status it reports.
  assert.deepEqual(detectProviderFault('research settled as "interrupted": Model HTTP 500: {"error":"upstream database error"}'),
    { code: 'provider-server-error', status: 500 });
});

test('Idea Tree relaying a 5xx the local proxy wrote itself stays the product failure', () => {
  // /internal/evolve-llm does not only forward the provider's status: it also
  // answers 5xx from its own code (`services/api/src/evolution/llm-proxy.ts`).
  // A 502 covers every error `completeChatRequest` threw — its request
  // validation (`packages/model/src/completion.ts:67-78`), its own aborts for a
  // closed response, a revoked token or the 20-minute call ceiling — and the
  // catch-all 500 is `services/api/src/http/index.ts:5044-5051`. Those are the
  // product's failures, so the relayed 5xx must not excuse them (#1341 review).
  const relayed = body => `research settled as "interrupted": Model HTTP ${body}`;
  const localFailures = [
    relayed('502: {"error":"Unsupported model parameters: stream"}'),
    relayed('502: {"error":"Invalid model message history"}'),
    relayed('502: {"error":"Use the shared model gateway for streaming Chat requests"}'),
    relayed('502: {"error":"max_tokens must be a positive integer"}'),
    relayed('502: {"error":"aborted"}'),
    relayed('502: {"error":"The operation was aborted due to timeout"}'),
    relayed('502: {"error":"The model provider could not be reached"}'),
    relayed('500: {"error":"Internal server error"}'),
  ];
  for (const text of localFailures) assert.equal(detectProviderFault(text), null, text);
  // The same verdict keeps a sibling gateway outage out of the case, exactly as
  // the proxy's "no API token" refusal does.
  assert.equal(detectProviderFaultFromErrors([localFailures[4], GATEWAY_503]), null);
  // Playwright's appended assertion block does not change either answer.
  assert.equal(detectProviderFault(`${localFailures[0]}\nExpected: "completed"\nReceived: "interrupted"`), null);
  // The provider's own relayed 5xx is still provider evidence: the broken
  // stream keeps its transport class and a provider body keeps its status.
  assert.deepEqual(detectProviderFault(IDEA_TREE_502), { code: 'provider-transport', status: null });
  assert.deepEqual(detectProviderFault(relayed('500: {"error":"upstream database error"}')),
    { code: 'provider-server-error', status: 500 });
});

test('Idea Tree relaying a decision or the local proxy refusal stays the product failure', () => {
  // A 429 is the provider's decision and a 422 is the proxy rejecting the
  // shape, so neither is an outage.
  assert.equal(detectProviderFault('research settled as "interrupted": Model HTTP 429: retry budget exhausted after 2 attempts: quota'), null);
  assert.equal(detectProviderFault('research settled as "interrupted": Model HTTP 422: {"error":"Invalid Chat completion response"}'), null);
  // A 503 "no API token" is the local /internal/evolve-llm proxy refusing the
  // call before it reaches the provider: the product misconfigured, not an
  // outage. The refusal also vetoes a sibling outage in the same case.
  const refusal = 'research settled as "interrupted": Model HTTP 503: {"error":"The model this run was created with has no API token"}';
  assert.equal(detectProviderFault(refusal), null);
  assert.equal(detectProviderFaultFromErrors([refusal, GATEWAY_503]), null);
});

test('the reporter records a live-model gateway fault apart from a product failure', t => {
  const { plan, written } = report(t, {
    title: 'DRB-75', tags: realCaseTags, status: 'failed', errors: [GATEWAY_500], duration: 9_300,
  });
  assert.equal(written.results[0].outcome, PROVIDER_FAULT);
  // The provider's own words stay in the failure: nothing is rewritten.
  assert.deepEqual(written.results[0].errors, [GATEWAY_500]);
  assert.deepEqual(written.results[0].providerFault, { code: 'provider-server-error', status: 500 });
  // The case ran; it is not a case that was never executed.
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.executed, 1);
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.passed, 0);
  assert.equal(verdict.providerFaults, 1);
});

test('a live-model case that carries the assertion block with the 503 counts as a fault', t => {
  const mixed = `${GATEWAY_503}\nexpect(received).toBe(expected) // Object.is equality\nExpected: "completed"\nReceived: "failed"`;
  const { plan, written } = report(t, {
    title: 'L3-cancel', tags: realCaseTags, status: 'failed', errors: [mixed], duration: 14_400,
  });
  assert.equal(written.results[0].outcome, PROVIDER_FAULT);
  assert.deepEqual(written.results[0].providerFault, { code: 'provider-server-error', status: 503 });
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.providerFaults, 1);
  assert.equal(verdict.failed, 0);
  assert.ok(!verdict.problems.some(problem => problem.startsWith('FAIL:')));
});

test('a product failure stays a hard failure with no provider class', t => {
  const { plan, written } = report(t, {
    title: 'DRB-59', tags: realCaseTags, status: 'failed', errors: [DELIVERY_MISS], duration: 600_000,
  });
  assert.equal(written.results[0].outcome, 'FAIL');
  assert.equal(written.results[0].providerFault, undefined);
  const verdict = verifyResults(plan, written.results);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.failed, 1);
  assert.ok(verdict.problems.includes(`FAIL: ${plan.entries[0].key}`));
  assert.ok(!verdict.problems.some(problem => problem.startsWith('PROVIDER_FAULT:')));
});

test('a mocked case is never soft-classified, however its failure reads', t => {
  const { plan, written } = report(t, {
    title: 'workspace plan gateway', tags: mockedCaseTags, status: 'failed',
    errors: ["Run failed while waiting for Workspace Plans: Needs attention: {'type': 'new_api_error', 'code': 503}"], duration: 1_000,
  });
  assert.equal(written.results[0].outcome, 'FAIL');
  assert.equal(verifyResults(plan, written.results).status, 'FAIL');
});

test('the visible-gateway-error journey stays a mocked case', () => {
  const source = readFileSync(join(root, 'test/issue-67-34-inline-cards.spec.ts'), 'utf8');
  const journey = source.slice(source.indexOf('visible gateway errors fail promptly'));
  assert.match(journey, /@mocked/);
  assert.match(journey, /@model:mock/);
});

test('a provider fault is reported under its own code and does not pass the gate', () => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const entry = plan.entries[0];
  const verdict = verifyResults(plan, [{
    key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend,
    providerFault: { code: 'provider-server-error', status: 503 },
  }]);
  // Distinguishable from a product failure ...
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.ok(verdict.problems.includes(`PROVIDER_FAULT: ${entry.key}`));
  assert.ok(!verdict.problems.includes(`FAIL: ${entry.key}`));
  // ... and not a pass: the planned case is unverified.
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.providerFaults, 1);
  assert.equal(verdict.passed, 0);
});

test('a job whose cases all faulted stays a provider fault and still fails', () => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const faulted = entry => ({ key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend });
  const verdict = verifyResults(plan, plan.entries.map(faulted));
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.passed, 0);
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.providerFaults, 2);
  for (const entry of plan.entries) {
    assert.ok(verdict.problems.includes(`PROVIDER_FAULT: ${entry.key}`));
    assert.ok(!verdict.problems.includes(`FAIL: ${entry.key}`));
  }
});

test('a provider-fault-only worker exit stays out of product accounting', () => {
  const providerFault = { outcome: PROVIDER_FAULT };
  assert.equal(isProviderFaultOnlyWorkerFailure(1, [providerFault]), true);
  assert.equal(isProviderFaultOnlyWorkerFailure(2, [providerFault]), false);
  assert.equal(isProviderFaultOnlyWorkerFailure(1, [{ outcome: 'FAIL' }, providerFault]), false);
});

test('a mixed job keeps its passes as passes and still fails on a product failure', () => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const [first, second] = plan.entries;
  const passed = entry => ({ key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend });
  const faulted = entry => ({ key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend });
  const failed = entry => ({ key: entry.key, outcome: 'FAIL', actualTarget: entry.target, actualBackend: entry.backend });

  // A pass beside a provider fault stays a pass; the fault keeps its own code
  // and the job does not pass.
  const mixed = verifyResults(plan, [passed(first), faulted(second)]);
  assert.equal(mixed.status, 'PROVIDER_FAULT');
  assert.equal(mixed.exitCode, 1);
  assert.equal(mixed.passed, 1);
  assert.equal(mixed.failed, 0);
  assert.equal(mixed.providerFaults, 1);
  assert.ok(mixed.problems.includes(`PROVIDER_FAULT: ${second.key}`));

  const withProductFailure = verifyResults(plan, [passed(first), failed(second)]);
  assert.equal(withProductFailure.status, 'FAIL');
  assert.equal(withProductFailure.exitCode, 1);
  assert.equal(withProductFailure.passed, 1);
  assert.equal(withProductFailure.failed, 1);

  // Only a run without a provider fault and without a product problem passes.
  const clean = verifyResults(plan, [passed(first), passed(second)]);
  assert.equal(clean.status, 'PASS');
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.passed, 2);
});

test('the reconcile keeps a provider fault visible and does not pass the suite', t => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  const [first, second] = plan.entries;
  for (const shard of realShards(plan)) {
    const directory = join(root, 'real-e2e-results-' + shard.name, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(entry => shard.keys.includes(entry.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    const results = worker.entries.map(entry => entry.key === first.key
      ? { key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend }
      : { key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend });
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, results)));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  // The suite does not pass on a provider fault alone ...
  assert.equal(verdict.exitCode, 1);
  // ... the passes stay passes, and the fault stays visible under its own code
  // instead of being turned into an opaque shard failure.
  assert.equal(verdict.passed, 1);
  assert.equal(verdict.providerFaults, 1);
  assert.ok(verdict.problems.some(problem => problem.startsWith('PROVIDER_FAULT:')));
  assert.ok(!verdict.problems.some(problem => problem.includes('SHARD_FAILED')));
});

test('the reconcile fails a suite whose cases all faulted, and keeps their rows', t => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(entry => shard.keys.includes(entry.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    const results = worker.entries.map(entry => ({
      key: entry.key, outcome: PROVIDER_FAULT, actualTarget: entry.target, actualBackend: entry.backend,
      providerFault: { code: 'provider-server-error', status: 500 },
    }));
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, results)));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.passed, 0);
  assert.equal(verdict.providerFaults, 2);
  assert.equal(verdict.executed, plan.entries.length);
  for (const entry of plan.entries) {
    assert.ok(verdict.problems.includes(`PROVIDER_FAULT: ${entry.key}`));
    assert.ok(!verdict.problems.includes(`FAIL: ${entry.key}`));
  }
  assert.ok(!verdict.problems.some(problem => problem.includes('SHARD_FAILED')));
});

test('reconcile keeps retry audit codes as provider faults', t => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  for (const shard of realShards(plan)) {
    const directory = join(root, 'real-e2e-results-' + shard.name, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(entry => shard.keys.includes(entry.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    const results = worker.entries.map(entry => ({
      key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend,
    }));
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, results, [retryReportMissing, retryFailed(1)])));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'PROVIDER_FAULT');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.passed, 1);
  assert.equal(verdict.providerFaults, 0);
  assert.deepEqual(verdict.problems, realShards(plan).flatMap(shard => [
    `PROVIDER_FAULT: ${shard.name}: ${retryReportMissing}`,
    `PROVIDER_FAULT: ${shard.name}: ${retryFailed(1)}`,
  ]));
});

test('the reconcile passes a suite whose cases all passed', t => {
  const plan = createPlan([identity('case-a', realTags), identity('case-b', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(entry => shard.keys.includes(entry.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    const results = worker.entries.map(entry => ({
      key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend,
    }));
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, results)));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.passed, plan.entries.length);
});

test('the daily reconcile still fails the suite on a product failure', t => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', profile: 'daily', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const root = directory(t);
  const [entry] = plan.entries;
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`, 'e2e-real/tagged');
    mkdirSync(directory, { recursive: true });
    const worker = subplan(plan, plan.entries.filter(item => shard.keys.includes(item.key)));
    writeFileSync(join(directory, 'plan.json'), JSON.stringify(worker));
    writeFileSync(join(directory, 'summary.json'), JSON.stringify(verifyResults(worker, [{
      key: entry.key, outcome: 'FAIL', actualTarget: entry.target, actualBackend: entry.backend,
    }])));
  }
  const verdict = reconcile(plan, root);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.exitCode, 1);
});

test('only daily and release profiles enable failed-case retries', () => {
  assert.equal(shouldRetryFailedCases('daily'), true);
  assert.equal(shouldRetryFailedCases('release'), true);
  assert.equal(shouldRetryFailedCases('merge'), false);
  assert.equal(shouldRetryFailedCases('pr'), false);
});

test('the shared-plan summary does not report a faulted layer as green', t => {
  const results = directory(t);
  const layer = join(results, 'e2e-real');
  mkdirSync(join(layer, 'tagged'), { recursive: true });
  const summary = {
    status: 'PROVIDER_FAULT', exitCode: 1, planDigest: 'a'.repeat(64),
    planned: 2, executed: 2, passed: 1, failed: 0, skipped: 0, providerFaults: 1,
  };
  const report = (document) => {
    writeFileSync(join(layer, 'tagged', 'summary.json'), JSON.stringify(document));
    const env = { ...process.env, CI_RESULTS_DIR: results };
    delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(process.execPath, [join(root, '.ci/tagged-summary.mjs')], { env, encoding: 'utf8' });
  };
  // A case that faulted is unverified: the layer does not report green, and
  // the fault stays visible in the table.
  const faulted = report(summary);
  assert.equal(faulted.status, 1);
  assert.match(faulted.stdout, /provider fault/);
  assert.match(faulted.stdout, /\| 1 \|/);
  // A recovered case is visible in the summary while the final layer remains green.
  const recovered = report({ ...summary, status: 'PASS', exitCode: 0, passed: 2, providerFaults: 0,
    retriedCases: 1, recoveredAfterRetry: 1, passed_after_retry: 1 });
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /passed after retry/);
  assert.match(recovered.stdout, /\| 1 \| 0 \| 0 \|/);
});
test('every executed failure is eligible for one complete retry', () => {
  const transport = { outcome: PROVIDER_FAULT, providerFault: { code: 'provider-transport', status: null } };
  const serverError = { outcome: PROVIDER_FAULT, providerFault: { code: 'provider-server-error', status: 503 } };
  const product = { outcome: 'FAIL' };
  const skipped = { outcome: 'SKIPPED' };
  const passed = { outcome: 'PASS' };
  assert.deepEqual(retryableCaseFailures([transport, serverError, product, skipped, passed]), [transport, serverError, product]);
});

test('a retry pass gates green while retaining the first failure record', () => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const entry = plan.entries[0];
  const verdict = verifyResults(plan, [{
    key: entry.key,
    outcome: 'PASS',
    actualTarget: entry.target,
    actualBackend: entry.backend,
    retriedAfterRetry: true,
    passed_after_retry: true,
    firstAttempt: { outcome: 'FAIL' },
  }]);
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.passed, 1);
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.recoveredAfterRetry, 1);
  assert.equal(verdict.passed_after_retry, 1);
});

test('a failed retry remains a failed gate result', () => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const entry = plan.entries[0];
  const verdict = verifyResults(plan, [{
    key: entry.key,
    outcome: 'FAIL',
    actualTarget: entry.target,
    actualBackend: entry.backend,
    retriedAfterRetry: true,
    firstAttempt: { outcome: 'FAIL' },
  }]);
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.passed, 0);
  assert.equal(verdict.failed, 1);
});

test('retry audit codes remain provider faults', () => {
  const plan = createPlan([identity('case-a', realTags)], {
    revision: 'candidate', targets: [target], execution: { backend: 'jiuwenswarm', model: 'generator', judge: null },
  });
  const entry = plan.entries[0];
  const passed = { key: entry.key, outcome: 'PASS', actualTarget: entry.target, actualBackend: entry.backend };
  for (const problem of [retryReportMissing, retryFailed(1)]) {
    const verdict = verifyResults(plan, [passed], [problem]);
    assert.equal(verdict.status, 'PROVIDER_FAULT');
    assert.equal(verdict.exitCode, 1);
    assert.ok(verdict.problems.includes(problem));
    assert.ok(!verdict.problems.some(item => item.startsWith('FAIL:')));
  }
});
