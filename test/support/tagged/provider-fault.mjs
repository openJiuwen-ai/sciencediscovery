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
 * Transient model-gateway faults, told apart from product delivery failures.
 *
 * A real-model case can fail because the provider answered with a server
 * error, not because the product ran and did not deliver. The product already
 * keeps those apart: `services/api/src/run-failure.ts` calls 500/502/503/504
 * a `server-error`, and the adapter maps the same statuses onto
 * `server-error`. This module recognises the same faults in the text a failed
 * test reports, so the harness can name the difference without rewriting
 * anything the provider said.
 *
 * The rules stay narrow on purpose. A fault must carry a server status *and*
 * a provider context, name one of the gateway's own routing failures
 * outright, or be a transport break with no status at all — `read
 * ECONNRESET`, `other side closed`, `socket hang up`, `UND_ERR_SOCKET` —
 * beside the gateway naming itself. An authentication or rate-limit answer
 * is a decision, not an outage, and a failure with no provider context is the
 * product's own. The provider's context has to name the gateway itself: a
 * product delivery failure that merely quotes a provider status is the
 * product's failure, and stays one.
 *
 * A transport break is checked before the product-report rule on purpose: the
 * failed case text wraps the provider's words in `delivery_status=failed`,
 * which is the product restating a run that died on the wire, not evidence it
 * mishandled a complete answer.
 *
 * An assertion diff is not that product verdict. Playwright appends the failed
 * `expect()` to the error it saw, so the gateway's `181001 … 503` arrives in
 * the same message as `Expected: "completed" / Received: "failed"`. The
 * gateway's own vocabulary outranks the assertion wrapper; only a delivery miss
 * outranks the gateway.
 *
 * Naming a fault is not a pass. The accounting keeps the two apart and
 * reports the fault as such, but a planned case that only faulted is an
 * unverified case: the gate does not pass on it.
 */

/** The outcome a provider fault carries in the tagged accounting. */
export const PROVIDER_FAULT = 'PROVIDER_FAULT';

/** The distinct problem code the accounting shows, never a plain `FAIL:`. */
export const providerFaultProblem = key => `${PROVIDER_FAULT}: ${key}`;
/**
 * The audit codes a failed early repeat leaves behind. The repeat did not
 * work because the same provider was still failing, so these belong to the
 * provider-fault family and never read as a product failure.
 */
export const providerFaultRepeatFailed = code => `${PROVIDER_FAULT}_REPEAT_FAILED: ${code}`;
export const providerFaultRepeatReportMissing = `${PROVIDER_FAULT}_REPEAT_REPORT_MISSING`;
/**
 * Whether a problem belongs to the provider-fault family: the soft class
 * itself, and the audit codes a failed early repeat leaves behind. Both
 * describe the gateway's outage, never the product's own failure.
 */
export const isProviderFaultProblem = problem =>
  typeof problem === 'string'
  && (problem.startsWith(`${PROVIDER_FAULT}: `) || problem.startsWith(`${PROVIDER_FAULT}_`));

/**
 * Server statuses, in the order they are recognised. A number only counts in
 * a status position — "500 items" is not a status — and a named error stands
 * for the status it always means.
 */
const SERVER_STATUS = [
  { status: null, pattern: /\bhttp(?:\/\d(?:\.\d)?)?\s+(5\d\d)\b/i },
  { status: null, pattern: /\b(?:http[ _-]?status|status[ _-]?code|status|error[ _-]?code|code)\s*['"`]?\s*[:=]\s*['"`]?\s*(5\d\d)\b/i },
  { status: null, pattern: /\b(?:http[ _-]?status|status[ _-]?code|status|error[ _-]?code|code)\s+(5\d\d)\b/i },
  { status: null, pattern: /\b(5\d\d)\s+(?:internal[\s_-]?server[\s_-]?error|bad[\s_-]?gateway|service[\s_-]?unavailable|gateway[\s_-]?timeout)\b/i },
  { status: 500, pattern: /\binternal[\s_-]?server[\s_-]?error(?:[\s_-]?error)?\b/i },
  { status: 502, pattern: /\bbad[\s_-]?gateway(?:[\s_-]?error)?\b/i },
  { status: 503, pattern: /\bservice[\s_-]?unavailable(?:[\s_-]?error)?\b/i },
  { status: 504, pattern: /\bgateway[\s_-]?timeout(?:[\s_-]?error)?\b/i },
];

/**
 * The gateway's own vocabulary: its model-call failure code, the error types
 * it returns and the wording of a routing failure. These name a provider
 * fault on their own, without a status beside them.
 */
const ROUTING_FAILURE = /\bno available channel\b|\bmodel_not_found\b|\bnew_api_error\b/i;

/**
 * A provider context strong enough to place a server status at the gateway.
 *
 * Bare words — "provider", "llm", "gateway", "upstream" — are not context on
 * their own: a product failure that quotes a provider status says exactly
 * those words, and must not be soft-classified because of them. What counts
 * is the gateway naming itself: its model-call code, the wording of a failed
 * model call, the API it answers on.
 */
const GATEWAY_CONTEXT = /\b181001\b|\bmodel call failed\b|\bopenai api\b|\bchat\/completions\b/i;

/**
 * A transport break the provider caused after it had already answered. There is
 * no HTTP status to read: the gateway said `200`, streamed for a while and then
 * the connection died. The words are the only evidence, so they must be exact.
 */
const TRANSPORT_BREAK = /\bread\s+econnreset\b|\beconnreset\b|\bother side closed\b|\bsocket hang up\b|\bund_err_socket\b/i;

/**
 * The product's delivery verdict, which outranks the gateway.
 *
 * This is the report that the product ran and did not deliver — the one the
 * gate must keep as `FAIL` even when the same text also carries the gateway's
 * error, which is how a delivery miss on top of an outage is recorded.
 */
const DELIVERY_MISS = /\bdelivery[ _-]?(?:status|failed|missed)\b|\bdelivered[ _-]?artifacts\b|\bmain run must (?:complete|reference)\b/i;

/**
 * The product's own report: a delivery miss or an assertion diff. Such a
 * text says what the product did with the answer, not what the provider
 * answered, so a provider status quoted inside it is the product's failure
 * to keep.
 *
 * An assertion alone is the weaker half: a Playwright failure message carries
 * the gateway's error *and* the `Expected:` / `Received:` block it produced,
 * so the assertion wording must not swallow the gateway's own 181001/5xx.
 * Only the delivery half (`DELIVERY_MISS`) wins over the gateway's words.
 */
const PRODUCT_REPORT = /\bdelivery[ _-]?(?:status|failed|missed)\b|\bdelivered[ _-]?artifacts\b|\bmain run must (?:complete|reference)\b|\bexpected\s*:|\breceived\s*:|\bassertion\b/i;

/** A decision by the provider, not an outage: never a transient fault. */
const UNAUTHORIZED = /\b(?:401|403)\b|unauthoriz|forbidden|invalid\s+api[\s_-]?key|authentication\s+(?:error|failed)|permission\s+denied/i;
const RATE_LIMITED = /\b429\b|rate[\s_-]?limit|too\s+many\s+requests|quota\s+(?:exceeded|exhausted)|insufficient[\s_-]?quota/i;

/** The product's own stalled-run wording, which is a timeout and not a fault. */
const TIMED_OUT = /timed?\s?out|\btimeout\b|stalled|etimedout|no\s+gateway\s+progress/i;

function serverStatus(text) {
  for (const { status, pattern } of SERVER_STATUS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const digits = match[1] ?? match[0].match(/5\d\d/)?.[0];
    return digits ? Number(digits) : status;
  }
  return null;
}

/**
 * Classify a failure text as a transient model-gateway fault.
 *
 * Returns `null` for anything else, so the caller can keep the failure as the
 * product's own. The returned record carries the classification and the
 * status; the provider's own words stay in the failure text itself.
 */
export function detectProviderFault(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // An authentication or rate-limit answer is a decision, not an outage.
  if (UNAUTHORIZED.test(text) || RATE_LIMITED.test(text)) return null;
  // A stream that broke after the provider had already answered carries no
  // status at all: the gateway returned 200, sent records, then the connection
  // died (`read ECONNRESET`, `other side closed`). It is checked before the
  // product-report rule on purpose — the run's own failure text wraps the
  // provider's words in `delivery_status=failed`, and that wrapper is the
  // product restating a run that died on the transport, not evidence that the
  // product mis-handled an answer it received whole.
  if (TRANSPORT_BREAK.test(text) && GATEWAY_CONTEXT.test(text)) return { code: 'provider-transport', status: null };
  // A delivery miss is the product's own verdict, even when the provider's
  // words were recorded beside it: the product ran and did not deliver.
  if (DELIVERY_MISS.test(text)) return null;
  const routing = ROUTING_FAILURE.test(text);
  const status = serverStatus(text);
  const gatewayStatus = status !== null && GATEWAY_CONTEXT.test(text);
  // The gateway naming its own server status outranks the assertion wrapper
  // that carries it: `[181001] model call failed … 503` followed by
  // `Expected: "completed" / Received: "failed"` is the outage, not the
  // assertion. A text that only quotes a status still belongs to the product.
  if (PRODUCT_REPORT.test(text) && !gatewayStatus) return null;
  // A status alone belongs to the product until something places it at the
  // gateway: the local API answering 500 is a product failure, not an outage.
  if (!routing && !status) return null;
  if (!routing && !GATEWAY_CONTEXT.test(text)) return null;
  // A timeout that only mentions a server status is the product's stalled run.
  // The gateway's own routing failures are never masked by that wording.
  if (!routing && TIMED_OUT.test(text)) return null;
  return {
    code: status ? 'provider-server-error' : 'provider-unavailable',
    status: status ?? null,
  };
}

/**
 * Classify a failed case from the text its errors carry.
 *
 * A case is a provider fault when at least one recorded text names one and no
 * text reports a delivery miss. A Playwright case appends its assertion to the
 * gateway's error, so requiring every text to classify let that assertion line
 * veto the outage and turn a whole queue red as a product regression.
 */
export function detectProviderFaultFromErrors(errors = []) {
  const texts = (Array.isArray(errors) ? errors : [errors]).filter(text => typeof text === 'string');
  if (!texts.length) return null;
  // A delivery miss anywhere in the case is the product's own report.
  if (texts.some(text => DELIVERY_MISS.test(text))) return null;
  const detected = texts.map(text => detectProviderFault(text)).filter(Boolean);
  return detected.length ? detected[0] : null;
}

/**
 * How long an attempt may run and still be worth repeating. A journey that
 * died within this budget never reached the expensive part of its work, so
 * running it again costs little; one that got further is not repeated.
 */
export const PROVIDER_FAULT_RETRY_BUDGET_MS = 300_000;

/** The cases a first attempt may repeat: an early transient gateway fault
 *  that is not a status-less transport break. A break after a 200 (`read
 *  ECONNRESET`) is a provider fault for the accounting, but it must not earn
 *  the harness's early repeat: that repeat re-runs a whole journey, while the
 *  bounded restream the issue asks for has not landed yet, so repeating here
 *  would deliver the retry this PR says it does not contain. */
export function retryableProviderFaults(results = [], budgetMs = PROVIDER_FAULT_RETRY_BUDGET_MS) {
  return (Array.isArray(results) ? results : []).filter(result =>
    result?.outcome === PROVIDER_FAULT
    && result?.providerFault?.code !== 'provider-transport'
    && typeof result.durationMs === 'number' && result.durationMs <= budgetMs);
}
