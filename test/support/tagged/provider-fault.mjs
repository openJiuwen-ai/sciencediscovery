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
 * One product reporter is provider context too: Idea Tree's own transport
 * (`vendor/idea_tree/research.py`) relays the answer the local
 * `/internal/evolve-llm` proxy gave as `Model HTTP <status>: <body>`, so a 5xx
 * there is the gateway's outage wearing the product's words. That reporter also
 * relays the 5xx answers the proxy writes itself: its 503 refusal when the
 * run's model has no API token, a 502 for a call it refused or aborted before
 * the provider answered, and the catch-all 500 of a request it did not finish.
 * Those are product failures, not the gateway's, so they are carved out below.
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
/** Whether a problem belongs to the provider-fault family. */
export const isProviderFaultProblem = problem =>
  typeof problem === 'string'
  && (problem.startsWith(`${PROVIDER_FAULT}: `) || problem.startsWith(`${PROVIDER_FAULT}_`));

/** A worker can exit 1 when every executed case failed at the provider gateway. */
export const isProviderFaultOnlyWorkerFailure = (code, results = []) =>
  code === 1
  && !results.some(result => result?.outcome === 'FAIL')
  && results.some(result => result?.outcome === PROVIDER_FAULT);

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
 * Idea Tree's own reporter for the status the model endpoint answered.
 *
 * `services/evolve/src/sciencediscovery_evolve/vendor/idea_tree/research.py`
 * raises `Model HTTP <status>: <body>` for the answer it got, and the Nightly
 * recorded `Model HTTP 502: {"error":"Model stream failed after response
 * headers: read ECONNRESET"}` from it. That is the gateway's outage relayed by
 * the product, so the 5xx is provider evidence even though the text carries
 * none of the gateway's own vocabulary. Only 5xx counts: a 4xx is a decision
 * or the product's own request, and the rate-limit rule below already keeps
 * a 429 out. A 5xx the proxy wrote itself is carved out by
 * `MODEL_HTTP_LOCAL_FAILURE` below, because the same reporter relays it.
 */
const MODEL_HTTP_SERVER_ERROR = /\bmodel\s+http\s+(5\d\d)\b/i;

/**
 * The local `/internal/evolve-llm` proxy's own refusal, which is the product's
 * failure rather than the gateway's: it answers 503 with this wording when the
 * run's model has no API token, before any provider call is made. Idea Tree
 * reports that refusal with the same `Model HTTP <status>` wording, so the
 * reporter above has to be narrowed by it.
 */
const LOCAL_PROXY_REFUSAL = /\bno\s+api\s+token\b/i;

/**
 * The 5xx answers the local proxy writes itself, as Idea Tree relays them.
 *
 * `services/api/src/evolution/llm-proxy.ts` forwards the provider's own status
 * and body at :219-226, but three other exits are its own words:
 *
 * - :144-146 answers 503 when the run's model has no API token (matched by
 *   `LOCAL_PROXY_REFUSAL` above);
 * - :180-188 answers 502 for every error `completeChatRequest` threw that is
 *   not a malformed provider response (that one is a 422). That set includes
 *   the proxy's request validation (`packages/model/src/completion.ts:67-78`),
 *   its own aborts — the response closed, the run token was revoked, or the
 *   `CALL_CEILING_MS` deadline fired (`llm-proxy.ts:89,123,176-179`), which
 *   `requestWithRetry` reports as `aborted` and the signal itself as
 *   `This operation was aborted` / `The operation was aborted due to timeout`
 *   — and a non-`Error` throw, reported as `The model provider could not be
 *   reached`;
 * - `services/api/src/http/index.ts:5044-5051` answers the catch-all 500
 *   `Internal server error` for a request that threw before it could answer.
 *
 * None of those is the gateway answering, so a relayed 5xx carrying one of
 * them is the product's failure and must not be read as the provider's. Keep
 * the match on the relayed line (`[^\n]*`): an assertion or a second error
 * appended by Playwright must not let the same words veto a sibling outage
 * elsewhere in the message.
 */
const MODEL_HTTP_LOCAL_FAILURE = new RegExp(
  String.raw`\bmodel\s+http\s+5\d\d\s*:[^\n]*(?:`
  + String.raw`"error"\s*:\s*"internal\s+server\s+error"`
  + String.raw`|"error"\s*:\s*"aborted"`
  + String.raw`|\b(?:this|the)\s+operation\s+was\s+aborted\b`
  + String.raw`|\bunsupported\s+model\s+(?:parameters|tool)\b`
  + String.raw`|\binvalid\s+model\s+message\s+history\b`
  + String.raw`|\bunsupported\s+thinking\s+control\b`
  + String.raw`|\bmax_tokens\s+must\s+be\s+a\s+positive\s+integer\b`
  + String.raw`|\buse\s+the\s+shared\s+model\s+gateway\s+for\s+streaming\s+chat\s+requests\b`
  + String.raw`|\bthe\s+model\s+provider\s+could\s+not\s+be\s+reached\b`
  + `)`,
  'i',
);

/**
 * Whether a text places a server status at the provider: the gateway naming
 * itself, or Idea Tree relaying an answer the provider gave. A 5xx the local
 * proxy wrote itself is not that answer.
 */
const namesProvider = text => GATEWAY_CONTEXT.test(text)
  || (MODEL_HTTP_SERVER_ERROR.test(text) && !MODEL_HTTP_LOCAL_FAILURE.test(text));

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
  // The local proxy refusing the call — no API token for this run's model — is
  // the product misconfigured, not the gateway failing, whichever reporter
  // relays it.
  if (LOCAL_PROXY_REFUSAL.test(text)) return null;
  // A relayed 5xx carrying the local proxy's own failure wording is the
  // product's, even though the same reporter relays the provider's 5xx.
  if (MODEL_HTTP_LOCAL_FAILURE.test(text)) return null;
  // A stream that broke after the provider had already answered carries no
  // status at all: the gateway returned 200, sent records, then the connection
  // died (`read ECONNRESET`, `other side closed`). It is checked before the
  // product-report rule on purpose — the run's own failure text wraps the
  // provider's words in `delivery_status=failed`, and that wrapper is the
  // product restating a run that died on the transport, not evidence that the
  // product mis-handled an answer it received whole.
  if (TRANSPORT_BREAK.test(text) && namesProvider(text)) return { code: 'provider-transport', status: null };
  // A delivery miss is the product's own verdict, even when the provider's
  // words were recorded beside it: the product ran and did not deliver.
  if (DELIVERY_MISS.test(text)) return null;
  const routing = ROUTING_FAILURE.test(text);
  const status = serverStatus(text);
  const gatewayStatus = status !== null && namesProvider(text);
  // The gateway naming its own server status outranks the assertion wrapper
  // that carries it: `[181001] model call failed … 503` followed by
  // `Expected: "completed" / Received: "failed"` is the outage, not the
  // assertion. A text that only quotes a status still belongs to the product.
  if (PRODUCT_REPORT.test(text) && !gatewayStatus) return null;
  // A status alone belongs to the product until something places it at the
  // gateway: the local API answering 500 is a product failure, not an outage.
  if (!routing && !status) return null;
  if (!routing && !namesProvider(text)) return null;
  // A timeout is the product's stalled run, unless the same text names the
  // gateway's own status and context: `Error code: 504 - Gateway Timeout` from
  // a text carrying `181001`/`model call failed`/`openai api`/`chat/completions`
  // is the outage, not the stalled run it reads like. A bare `504 Gateway
  // Timeout` names no gateway context and stays the product's. The gateway's
  // routing failures are never masked by that wording either.
  if (!routing && !gatewayStatus && TIMED_OUT.test(text)) return null;
  return {
    code: status ? 'provider-server-error' : 'provider-unavailable',
    status: status ?? null,
  };
}

/**
 * Whether one text vetoes the whole case.
 *
 * `detectProviderFault` answers `null` both for a text that only records what
 * one step printed — an assertion wrapper, a thrown API error, a semantic
 * verdict — and for a verdict on the run itself: a delivery miss, a 401/403 or
 * 429 answer, or the product's stalled-run wording. Only the first kind may be
 * outvoted by a sibling text that names the gateway; the four verdicts may not.
 * A status-less transport break is not a verdict either: the text carries the
 * product's report wrapper, but that wrapper restates a run that died on the
 * transport after the provider had answered whole, so the break still
 * classifies at case level.
 * A timeout whose own text names the gateway's status and context, or its
 * routing failure, is not the product's stalled run, so it is not one of the
 * four either; a bare status the text only quotes is.
 */
function vetoesCase(text) {
  // An authentication or rate-limit answer stays a decision even when the same
  // message also records a break, because a retrying gateway client aggregates
  // its attempts: `attempt 1: … 401` beside `attempt 2: read ECONNRESET`. This
  // is the order `detectProviderFault` keeps, so the two rules cannot disagree.
  if (UNAUTHORIZED.test(text) || RATE_LIMITED.test(text)) return true;
  // The local proxy's own refusal is a product verdict too, so it vetoes a
  // sibling outage exactly like the provider's decision does. A relayed 5xx
  // the proxy wrote itself (validation, its own abort, the catch-all 500) is
  // the same kind of verdict.
  if (LOCAL_PROXY_REFUSAL.test(text) || MODEL_HTTP_LOCAL_FAILURE.test(text)) return true;
  // A status-less transport break outranks the product's report wrapper for the
  // same reason `detectProviderFault` checks it first: the wrapper restates a run
  // that died on the transport after the provider had answered whole. The text
  // that carries it therefore records no verdict of its own, and an assertion
  // wrapper beside it neither.
  if (TRANSPORT_BREAK.test(text) && namesProvider(text)) return false;
  if (DELIVERY_MISS.test(text)) return true;
  if (!TIMED_OUT.test(text)) return false;
  const status = serverStatus(text);
  const gatewayStatus = status !== null && namesProvider(text);
  return !ROUTING_FAILURE.test(text) && !gatewayStatus;
}

/**
 * Classify a failed case from the text its errors carry.
 *
 * A case is a provider fault when at least one recorded text names one and no
 * text records a verdict of its own. A Playwright case appends its assertion to
 * the gateway's error, so requiring every text to classify let that assertion
 * line veto the outage and turn a whole queue red as a product regression;
 * requiring only one text to classify must not go the other way and let an
 * outage outrank a decision the case recorded beside it.
 */
export function detectProviderFaultFromErrors(errors = []) {
  const texts = (Array.isArray(errors) ? errors : [errors]).filter(text => typeof text === 'string');
  if (!texts.length) return null;
  // A delivery miss, a provider decision or a stalled run anywhere in the case
  // is the case's own verdict.
  if (texts.some(vetoesCase)) return null;
  const detected = texts.map(text => detectProviderFault(text)).filter(Boolean);
  return detected.length ? detected[0] : null;
}
