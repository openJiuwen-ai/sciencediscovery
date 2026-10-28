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

"""Sanitized provider HTTP failures shared by the bundled MCP servers."""

from __future__ import annotations

import json
import re
import time
from email.utils import parsedate_to_datetime

import httpx


def raise_for_status(response: httpx.Response) -> None:
    """Preserve status, Retry-After and refusal attribution without raw URLs/bodies."""
    if response.status_code < 400:
        return
    message = f"HTTP {response.status_code} {response.reason_phrase} from {response.request.url.host}"
    retry_after = response.headers.get("retry-after")
    retry_ms = None
    if retry_after:
        try:
            retry_ms = max(0, round(float(retry_after) * 1000))
        except (ValueError, OverflowError):
            try:
                retry_ms = max(0, round((parsedate_to_datetime(retry_after).timestamp() - time.time()) * 1000))
            except (ValueError, TypeError, OverflowError):
                pass
    if retry_ms is not None:
        message += f" (retry-after: {retry_ms / 1000:g})"
    failure_scope = "unknown"
    if response.status_code == 406:
        # Only a generic edge rejection is evidence of endpoint health. Query
        # validation errors (and unrecognized bodies) remain request-specific.
        body = response.text[:8192].lower()
        request_error = re.search(r"query|syntax|parameter|invalid|unsupported|malformed", body)
        edge_error = ("error from cloudfront" in response.headers.get("x-cache", "").lower()
                      or response.headers.get("cf-mitigated") == "challenge"
                      or re.search(r"<title>\s*(?:406\s+)?not acceptable\s*</title>", body))
        failure_scope = "request" if request_error else "endpoint" if edge_error else "unknown"
    metadata = {"statusCode": response.status_code,
                "endpoint": f"{response.request.url.scheme}://{response.request.url.host}",
                "failureScope": failure_scope}
    if retry_ms is not None:
        metadata["retryAfterMs"] = retry_ms
    # FastMCP preserves exception text across stdio. This provider-owned JSON
    # envelope avoids guessing endpoint attribution from arbitrary error prose.
    raise RuntimeError(message + " SOURCE_HTTP_ERROR:" + json.dumps(metadata, separators=(",", ":")))
