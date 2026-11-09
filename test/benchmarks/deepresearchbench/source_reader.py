# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Bounded recovery of source content only; never cache scores or verdicts."""
import time


def read_source(url, api_key, *, deadline=None, cache=None, diagnostic=None):
    import requests
    info = diagnostic if diagnostic is not None else {}
    info.update(attempts=0, cache_hit=False, errors=[])
    if cache is not None and url in cache:
        info["cache_hit"] = True
        return cache[url]
    # Preserve the original first-attempt 15/90 second limits. A retry shares
    # this per-source ceiling and the evaluator's remaining overall budget.
    end = min(time.monotonic() + 120, deadline if deadline is not None else float("inf"))
    for attempt in range(2):
        remaining = end - time.monotonic()
        if remaining < 1:
            info["budget_exhausted"] = True
            raise requests.Timeout("Source read budget exhausted")
        connect = min(15, remaining / 3)
        info["attempts"] += 1
        response = None
        try:
            response = requests.get(f"https://r.jina.ai/{url}", headers={
                "Accept": "application/json", "Authorization": api_key,
                "X-Timeout": "60000", "X-With-Generated-Alt": "true"},
                timeout=(connect, min(90, remaining - connect)))
            response.raise_for_status()
            data = response.json()["data"]
            if not data.get("content", "").strip():
                raise ValueError("Empty source")
            content = "\n\n".join(data.get(k, "") or "" for k in ("title", "description", "content"))
            if cache is not None:
                cache[url] = content
            return content
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            info["errors"].append({"type": type(error).__name__, **({"status": status} if status is not None else {})})
            transient = isinstance(error, (requests.Timeout, requests.ConnectionError)) or status in (429, 502, 503, 504)
            if not transient or attempt == 1 or end - time.monotonic() < 1.25:
                raise
        finally:
            if response is not None:
                response.close()
        time.sleep(0.25)
