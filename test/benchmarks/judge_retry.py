# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Bounded retries for one-shot quality judges; never select the highest score."""
import copy
import json
import time
import urllib.error
from pathlib import Path

MAX_TOKENS = 65536
MAX_RETRIES = 3
REQUEST_TIMEOUT_SECONDS = 900


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Private evidence; no request headers or credentials are persisted.
    with path.open("w", encoding="utf-8") as stream:
        path.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)


def judge_with_retries(body, request, validate, output, *, sleep=time.sleep):
    """Same evidence/rubric on every attempt, first valid answer wins.

    request accepts a JSON body and must impose REQUEST_TIMEOUT_SECONDS.
    validate parses the message content and enforces the case's scoring contract.
    """
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    body = copy.deepcopy(body)
    body["max_tokens"] = MAX_TOKENS
    write_json(output / "request.json", body)
    attempts = []
    for attempt in range(1, MAX_RETRIES + 2):
        started = time.monotonic()
        entry = {"attempt": attempt}
        retryable = True
        try:
            raw = request(copy.deepcopy(body))
            write_json(output / f"response-{attempt:02}.json", raw)
            choice = raw["choices"][0]
            entry.update(finish_reason=choice.get("finish_reason"), usage=raw.get("usage"))
            if choice.get("finish_reason") != "stop":
                raise ValueError(f"Judge response incomplete: finish_reason={choice.get('finish_reason')}")
            result = validate(choice["message"].get("content") or "")
            result.update(usage=raw.get("usage"), model=body["model"],
                          judge_recovery={"max_tokens": MAX_TOKENS, "max_retries": MAX_RETRIES,
                                          "attempt": attempt, "records": str(output)})
            entry["status"] = "scored"
        except urllib.error.HTTPError as error:
            entry.update(status="error", error_type="HTTPError", error=f"HTTP {error.code}")
            retryable = error.code in (408, 429) or 500 <= error.code < 600
        except (ValueError, KeyError, TypeError, IndexError, AttributeError, OSError) as error:
            entry.update(status="error", error_type=type(error).__name__, error=str(error))
        entry["seconds"] = time.monotonic() - started
        attempts.append(entry)
        write_json(output / "attempts.json", attempts)
        if entry["status"] == "scored":
            return result, raw
        if not retryable or attempt == MAX_RETRIES + 1:
            raise ValueError(f"Judge failed after {attempt} attempt(s): {entry['error']}; see {output}")
        sleep(5 * attempt)
