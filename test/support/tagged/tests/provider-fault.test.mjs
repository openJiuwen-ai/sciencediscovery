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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectProviderFault, detectProviderFaultFromErrors } from '../provider-fault.mjs';

/** The wording Nightly 42907916462 recorded for DRB-58 / DRB-59 / DRB-75. */
const streamDiedAfter200 = 'Error: Main run must complete with readable, nonempty declared final artifacts; '
  + 'delivery_status=failed; run_status=failed; delivered_artifacts=0; '
  + 'run_error=[181001] model call failed, reason: openAI API async stream error: APIError: read ECONNRESET';

/** The wording Nightly 45212568993 recorded for research-11, unchanged. */
const ideaTreeTransport = 'research settled as "interrupted": Model HTTP 502: '
  + '{"error":"Model stream failed after response headers: read ECONNRESET"}';
/** The same text as Playwright reports it, with the failed `expect()` appended. */
const ideaTreeTransportWrapped = `${ideaTreeTransport}\n`
  + 'expect(received).toBe(expected) // Object.is equality\n\n'
  + 'Expected: "completed"\nReceived: "interrupted"';

test('a stream that dies after the provider answered is a provider fault', () => {
  assert.deepEqual(detectProviderFault(streamDiedAfter200), { code: 'provider-transport', status: null });
  assert.equal(detectProviderFault('the upload socket reported other side closed'), null,
    'the same words without the gateway naming itself stay the product\'s');
});

test('a delivery miss with no broken transport keeps its product classification', () => {
  assert.equal(detectProviderFault('Error: Main run must complete with readable, nonempty declared final artifacts; delivery_status=failed'), null);
  assert.equal(detectProviderFault('expect(received).toEqual(expected) // assertion failed'), null);
  assert.equal(detectProviderFault('run_error=[181001] model call failed, reason: model returned no artifacts'), null);
});

test('the existing status and routing classes are unchanged', () => {
  assert.deepEqual(detectProviderFault('openAI API answered http status 503'), { code: 'provider-server-error', status: 503 });
  assert.deepEqual(detectProviderFault('no available channel for model'), { code: 'provider-unavailable', status: null });
  assert.equal(detectProviderFault('openAI API answered status 401 unauthorized'), null);
  assert.equal(detectProviderFault('openAI API answered status 429 rate limit'), null);
});

test('Idea Tree relaying the endpoint 502 is a provider fault', () => {
  // Idea Tree's transport raises `Model HTTP <status>: <body>` for the answer
  // the model endpoint gave; a 502 with a broken stream is the gateway's
  // outage, even though the text carries none of the gateway's vocabulary.
  assert.deepEqual(detectProviderFault(ideaTreeTransport), { code: 'provider-transport', status: null });
  // Playwright appends the failed expect() to the same message (#1340).
  assert.deepEqual(detectProviderFault(ideaTreeTransportWrapped), { code: 'provider-transport', status: null });
  assert.deepEqual(detectProviderFaultFromErrors([ideaTreeTransportWrapped]),
    { code: 'provider-transport', status: null });
  // A relayed 5xx without a transport break keeps the status it reports.
  assert.deepEqual(
    detectProviderFault('research settled as "interrupted": Model HTTP 500: {"error":"upstream database error"}'),
    { code: 'provider-server-error', status: 500 },
  );
});

test('Idea Tree relaying a 5xx the local proxy wrote itself stays the product\'s', () => {
  // The proxy does not only forward the provider's status. It answers 502 for
  // every error `completeChatRequest` threw — request validation
  // (`packages/model/src/completion.ts:67-78`) and its own aborts, including the
  // 20-minute `CALL_CEILING_MS` deadline (`llm-proxy.ts:89,123,176-179`) — and
  // the catch-all 500 `Internal server error` for a request it did not finish
  // (`services/api/src/http/index.ts:5044-5051`). Those are product failures.
  const relayed = body => `research settled as "interrupted": Model HTTP ${body}`;
  for (const text of [
    relayed('502: {"error":"Unsupported model parameters: stream"}'),
    relayed('502: {"error":"aborted"}'),
    relayed('502: {"error":"The operation was aborted due to timeout"}'),
    relayed('502: {"error":"The model provider could not be reached"}'),
    relayed('500: {"error":"Internal server error"}'),
  ]) assert.equal(detectProviderFault(text), null, text);
  // The relayed local verdict also vetoes a sibling outage in the same case.
  assert.equal(detectProviderFaultFromErrors([
    relayed('502: {"error":"aborted"}'), ideaTreeTransport,
  ]), null);
  // A provider answer relayed by the same reporter is unchanged: the broken
  // stream is still the transport fault and a provider 5xx body keeps its status.
  assert.deepEqual(detectProviderFault(ideaTreeTransport), { code: 'provider-transport', status: null });
  assert.deepEqual(detectProviderFault(relayed('500: {"error":"upstream database error"}')),
    { code: 'provider-server-error', status: 500 });
});

test('Idea Tree relaying a decision or the local proxy refusal stays the product\'s', () => {
  // A 429 is the provider's decision, a 422 is the proxy rejecting the shape,
  // and a 503 "no API token" is the local /internal/evolve-llm proxy refusing
  // the call before it ever reaches the provider: the product misconfigured.
  assert.equal(detectProviderFault(
    'research settled as "interrupted": Model HTTP 429: retry budget exhausted after 2 attempts: quota'), null);
  assert.equal(detectProviderFault(
    'research settled as "interrupted": Model HTTP 422: {"error":"Invalid Chat completion response"}'), null);
  assert.equal(detectProviderFault(
    'research settled as "interrupted": Model HTTP 503: {"error":"The model this run was created with has no API token"}'), null);
  // The refusal is the product's verdict, so it also vetoes a sibling outage.
  assert.equal(detectProviderFaultFromErrors([
    'research settled as "interrupted": Model HTTP 503: {"error":"The model this run was created with has no API token"}',
    ideaTreeTransport,
  ]), null);
});

test('a status-less transport break classifies at case level too', () => {
  // The product's report wraps the provider's words in `delivery_status=failed`;
  // that wrapper is not a verdict, so the case still records the break.
  assert.deepEqual(detectProviderFaultFromErrors([streamDiedAfter200]),
    { code: 'provider-transport', status: null });
  // An assertion wrapper beside it records nothing either, and neither vetoes.
  assert.deepEqual(
    detectProviderFaultFromErrors([streamDiedAfter200, 'assertion failed on delivery to the workspace']),
    { code: 'provider-transport', status: null },
  );
});

test('a delivery miss the case recorded beside a break still vetoes', () => {
  // Another text that is itself a delivery verdict is the case's own answer; the
  // short-circuit covers the wrapper inside the break's text, not a sibling.
  assert.equal(detectProviderFaultFromErrors([streamDiedAfter200, 'Error: delivery_status=failed']), null);
  assert.equal(detectProviderFaultFromErrors(['delivery_status=failed; assertion failed']), null);
});
