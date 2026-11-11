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
