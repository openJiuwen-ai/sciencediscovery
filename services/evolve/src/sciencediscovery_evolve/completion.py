# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""A ``prompt -> text`` completion, routed through the control plane.

**Why not `agentdescent.agents.openai_compatible`.** It builds the same request
and normalises the same reply — including the `content: null` a reasoning model
returns when its whole budget went to hidden thinking — and this file would be a
few lines long if it could be used. It cannot, for one reason: it reads the base
URL and the API key **from the environment**. This process is handed a
run-scoped proxy token instead of a provider key, one per search, and putting
those in `os.environ` would leak them into the candidate: the Seatbelt sandbox
passes `{**os.environ, ...}` to the subprocess, so a model-written program would
be able to read the token for its own run. Passing credentials per call is the
whole point, so the request is built here.

What *is* reused rather than rebuilt: `agentdescent.agents.Usage` counts the
tokens (see `_Usage` in `puct_engine.py`). Transport retries live here so
they share the call's timeout, cancellation and per-call accounting.
"""

from __future__ import annotations

import http.client
import json
import math
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .logging_config import get_logger

log = get_logger("completion")


class CompletionUnavailable(RuntimeError):
    """No model access was configured for this run."""


@dataclass(frozen=True)
class CompletionUsage:
    """What one call cost, and whether it ran out of room.

    ``capped`` is the difference between "the model had nothing to say" and "the
    model never got to the saying part". A reasoning model can spend an entire
    output budget on hidden thinking and return empty content — observed on a
    real deployment at exactly 16001 of 16000 permitted tokens — and without
    this the engine reports an empty reply, which reads as a model that cannot
    write code.
    """

    total: int
    completion: int
    capped: bool


def completion_for(
    endpoint: str,
    token: str,
    *,
    max_tokens: int = 16_000,
    temperature: Optional[float] = None,
    thinking: Optional[str] = None,
    timeout: float = 300.0,
    max_retries: int = 2,
    on_usage: Optional[Callable[[CompletionUsage], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> Callable[[str], str]:
    """Build the callable the engine calls once per mutation.

    ``endpoint`` is absolute and comes from the control plane, which knows its
    own bind address. A sidecar that had to guess it would turn every expansion
    into a failed candidate for a reason that has nothing to do with candidates.

    ``on_usage`` receives what the provider reported, so the token budget gate
    reads what was actually spent rather than an estimate — and so an empty reply
    can be told apart from an exhausted one. The returned callable takes its own
    sink as well: with N expansions in flight there is no such thing as "the last
    call", and blaming one expansion's empty reply on another's token count is
    worse than not explaining it at all.

    ``should_stop`` makes a call abandonable. Without it a stop waits out the
    request, and on a reasoning model rewriting a program that is minutes: the
    user presses stop and watches nothing happen. The request itself cannot be
    cancelled, so it is left to finish on a daemon thread and its answer is
    dropped — the call is already paid for either way, and the difference is
    whether the user is made to wait for it.

    ``thinking`` is sent as ``{"type": ...}`` when set, and comes from the goal
    rather than being decided here — it is a trade the user makes, measured on
    GLM5.2 rewriting a small program: on, ~46k output tokens per call and a
    held-out test score of 0.519; off, ~1.2k and 0.366. Forty times the tokens
    and five times the wall clock for better candidates.

    Leaving it unset sends nothing, which is what a provider that has never
    heard of the field should receive. The option is one-sided anyway: an
    endpoint that does not know it ignores it.

    ``temperature`` is the same story: left unset, nothing is sent and the
    provider's own default applies — observed necessary on a deployment whose
    gateway rejects every value except the one it was configured with
    (``HTTP 400 invalid temperature: only 0.6 is allowed for this model``),
    which turned every mutation call into a failed candidate. A caller that
    wants a specific value can still pass one.

    ``max_tokens`` defaults high because a reasoning model with thinking left on
    spends the budget on hidden tokens and returns an empty reply — and an empty
    reply becomes a failed node, which is indistinguishable from a candidate that
    genuinely would not run. The pre-flight checks refuse a run whose ceiling is
    too low for that reason.
    """
    if not endpoint or not token:
        raise CompletionUnavailable("this run was not given model access")
    if type(max_retries) is not int or not 0 <= max_retries <= 2:
        raise ValueError("max_retries must be an integer between 0 and 2")

    def complete(
        prompt: str,
        sink: Optional[Callable[[CompletionUsage], None]] = None,
        on_failure: Optional[Callable[[str], None]] = None,
    ) -> str:
        report = sink or on_usage
        # Already stopped: do not send the request at all. Every expansion the
        # search still has queued would otherwise fire a real, paid model call
        # and abandon it half a second later, once per remaining expansion.
        if should_stop is not None and should_stop():
            return ""
        # Owned by the caller's thread rather than reported from `_call`: the
        # call runs on a daemon thread so it can be abandoned when the run
        # stops, and a thread-local set over there is invisible here.
        failures: list[str] = []
        if should_stop is None:
            text = _call(prompt, report, failures)
        else:
            box: list[str] = []
            worker = threading.Thread(
                target=lambda: box.append(_call(prompt, report, failures)),
                daemon=True, name="evolve-completion",
            )
            worker.start()
            while worker.is_alive():
                worker.join(0.5)
                if should_stop():
                    log.info("completion abandoned: the run was stopped")
                    return ""
            text = box[0] if box else ""
        if failures and on_failure is not None:
            on_failure(failures[-1])
        return text

    def _call(
        prompt: str,
        report: Optional[Callable[[CompletionUsage], None]],
        failures: list[str],
    ) -> str:
        body: dict[str, Any] = {
            "max_tokens": max_tokens,
            "messages": [{"content": prompt, "role": "user"}],
        }
        if temperature is not None:
            body["temperature"] = temperature
        if thinking:
            body["thinking"] = {"type": thinking}
        payload = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=payload,
            headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
            method="POST",
        )
        deadline = time.monotonic() + timeout
        for attempt in range(max_retries + 1):
            if should_stop is not None and should_stop():
                return ""
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failures.append("completion transport retry deadline exceeded")
                return ""
            try:
                with urllib.request.urlopen(request, timeout=remaining) as response:
                    body = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as error:
                try:
                    detail = error.read(300).decode("utf-8", "replace")
                finally:
                    error.close()
                reason = f"HTTP {error.code}：{detail}"
                retryable = error.code == 429 or 500 <= error.code < 600
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as error:
                reason = str(error) or error.__class__.__name__
                retryable = True
            except Exception as error:  # malformed JSON and other permanent failures
                reason = str(error) or error.__class__.__name__
                retryable = False
            if not retryable or attempt == max_retries:
                log.warning("completion failed after %s attempt(s): %s", attempt + 1, reason)
                failures.append(reason)
                return ""
            log.warning("completion transport retry %s/%s: %s", attempt + 1, max_retries, reason)
            # Backoff is interruptible, including inside an abandoned daemon call.
            wake_at = min(deadline, time.monotonic() + 0.5 * 2**attempt)
            while time.monotonic() < wake_at:
                if should_stop is not None and should_stop():
                    return ""
                time.sleep(min(0.1, max(0, wake_at - time.monotonic())))
        if report is not None:
            usage = body.get("usage") if isinstance(body, dict) else None
            usage = usage if isinstance(usage, dict) else {}
            completion = usage.get("completion_tokens")
            total = usage.get("total_tokens")
            valid = lambda value: (isinstance(value, (int, float)) and not isinstance(value, bool)
                                   and 0 <= value <= 2**53 - 1 and int(value) == value and (isinstance(value, int) or math.isfinite(value)))
            if valid(total) and valid(completion) and total >= completion:
                try:
                    report(CompletionUsage(total=int(total), completion=int(completion),
                                           capped=completion >= max_tokens - 2))
                except Exception:  # Accounting is best effort; retain the already-paid answer.
                    log.warning("completion usage could not be recorded")
        return _first_text(body)

    return complete


def _first_text(body: object) -> str:
    if not isinstance(body, dict):
        return ""
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    return content if isinstance(content, str) else ""
