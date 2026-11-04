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

"""Score one candidate by a Runner shell execution, not by the local sandbox.

The fixed program in the execution template is what runs. The candidate is a
JSON object handed to that program as ``_EVOLVE_CANDIDATE``. Each candidate
gets its own execution id. Success is ``completed`` with ``device`` equal to
``npu``. A job that is still queued, running, or unknown, or that finished
without an NPU result, is invalid and carries no numeric score.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Mapping, Optional, Tuple
from urllib.parse import quote

from .vendor.puct.domain import Domain
from .vendor.puct.program import Program

NOT_FINISHED = frozenset({"waiting", "queued", "running", "unknown"})
FAULT_STATUSES = frozenset({"failed", "cancelled", "interrupted"})
SIGNATURE_HEADER = "x-science-execution-signature"
TIMESTAMP_HEADER = "x-science-execution-timestamp"


class NpuJobError(RuntimeError):
    """This search asked for an NPU job and cannot submit one."""


def execution_signature(token: str, timestamp: str, body: str) -> str:
    """The Runner's execution signature: HMAC-SHA256 of timestamp and body hash."""
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return hmac.new(token.encode("utf-8"), f"{timestamp}\n{body_hash}".encode("utf-8"), hashlib.sha256).hexdigest()


def score_for_search(metrics: Mapping[str, Any]) -> float:
    """The number ``search.py`` ranks by.

    A waiting, faulted, or rejected job has no measurement. The unchanged
    aggregator still indexes ``metrics["score"]``, so the sentinel is ``-inf``,
    which is not a stored ``0``. A completed job may legitimately score ``0``.
    """
    value = metrics.get("score")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return float("-inf")
    return float(value)


def with_search_score(metrics: Mapping[str, Any]) -> dict[str, Any]:
    """Copy ``metrics``, filling the search sentinel when no score was measured."""
    copied = dict(metrics)
    if "score" not in copied:
        copied["score"] = float("-inf")
    return copied


def interpret_npu_job(
    job: Mapping[str, Any],
    artifact: Optional[Mapping[str, Any]],
    *,
    metric_key: str,
) -> Tuple[bool, dict[str, Any], str]:
    """Turn a Runner record into a measurement. A missing result is not ``0``."""
    status = str(job.get("status") or job.get("state") or "")
    if status in NOT_FINISHED:
        return False, {"job_status": "waiting"}, "job not finished"
    if status in FAULT_STATUSES:
        return False, {"job_status": "fault"}, f"job {status}"
    if status != "completed":
        return False, {"job_status": "fault"}, "job status unknown"
    if not artifact:
        return False, {"job_status": "fault"}, "artifact missing"
    if artifact.get("device") != "npu":
        return False, {"job_status": "fault"}, "device is not npu"
    value = artifact.get(metric_key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False, {"job_status": "fault"}, f"{metric_key} missing"
    score = float(value)
    return True, {"job_status": "completed", "device": "npu", metric_key: score, "score": score}, ""


def program_with_candidate(fixed: str, candidate: str) -> str:
    """Return the fixed program, with the candidate bound as data.

    The candidate text is not the program. It is parsed as a JSON object and
    assigned to ``_EVOLVE_CANDIDATE`` before the fixed program runs.
    """
    if not fixed.strip():
        raise NpuJobError("the NPU execution has no fixed program")
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as error:
        raise NpuJobError("the candidate is not JSON") from error
    if not isinstance(parsed, dict):
        raise NpuJobError("the candidate is not a JSON object")
    binding = "_EVOLVE_CANDIDATE = " + json.dumps(parsed, separators=(",", ":"), sort_keys=True)
    return binding + "\n" + fixed


class RunnerNpuClient:
    """Submit one signed shell execution and wait for its terminal state."""

    def __init__(
        self,
        *,
        url: str,
        token: str,
        execution: Mapping[str, Any],
        session_id: str,
        agent_id: str,
        timeout: float,
        poll_seconds: float = 0.25,
        clock: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        transport: str = "runner",
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.execution = dict(execution)
        self.session_id = session_id
        self.agent_id = agent_id
        self.timeout = timeout
        self.transport = transport
        self.poll_seconds = poll_seconds
        self.clock = clock
        fixed = self.execution.get("code")
        if not isinstance(fixed, str) or not fixed.strip():
            raise NpuJobError("the NPU execution has no fixed program")

    def run(
        self,
        code: str,
        should_stop: Optional[Callable[[], bool]] = None,
    ) -> Tuple[dict[str, Any], Optional[dict[str, Any]]]:
        body = dict(self.execution)
        body["code"] = program_with_candidate(str(self.execution.get("code") or ""), code)
        execution_id = f"evolve-{uuid.uuid4().hex}"
        body["executionId"] = execution_id
        raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
        _status, accepted = self._send("POST", "/shell-executions", raw)
        if not isinstance(accepted, dict):
            raise NpuJobError("the runner did not accept the NPU execution")
        deadline = time.monotonic() + self.timeout
        while True:
            if should_stop is not None and should_stop():
                self._send("POST", self._execution_path(execution_id, "cancel"), "")
                return {"status": "cancelled", "execution_id": execution_id}, None
            record = self._send("GET", self._execution_path(execution_id), None)[1]
            if not isinstance(record, dict):
                raise NpuJobError("the runner returned a status that is not an object")
            state = str(record.get("state") or record.get("status") or "")
            if state in NOT_FINISHED:
                if time.monotonic() >= deadline:
                    self._send("POST", self._execution_path(execution_id, "cancel"), "")
                    return {"status": "unknown", "execution_id": execution_id}, None
                time.sleep(self.poll_seconds)
                continue
            if state != "completed":
                return {"status": state or "unknown", "execution_id": execution_id}, None
            stdout = str((record.get("result") or {}).get("stdout") or "")
            return {"status": "completed", "execution_id": execution_id}, _artifact(stdout)

    def _execution_path(self, execution_id: str, suffix: str = "") -> str:
        path = f"/shell-executions/{quote(execution_id, safe='')}"
        if suffix:
            path = f"{path}/{suffix}"
        return f"{path}?sessionId={quote(self.session_id, safe='')}&agentId={quote(self.agent_id, safe='')}"

    def _send(self, method: str, path: str, body: Optional[str]) -> Tuple[int, Any]:
        data = None if body is None else body.encode("utf-8")
        request = urllib.request.Request(self.url + path, data=data, method=method)
        if self.transport == "api":
            request.add_header("authorization", f"Bearer {self.token}")
        if body is not None:
            timestamp = str(self.clock())
            request.add_header(TIMESTAMP_HEADER, timestamp)
            request.add_header(SIGNATURE_HEADER, execution_signature(self.token, timestamp, body))
            request.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
                status = response.status
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise NpuJobError(f"runner {method} {path} returned {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise NpuJobError(f"runner {method} {path} failed: {error.reason}") from error
        if not payload:
            return status, {}
        loaded = json.loads(payload)
        return status, loaded


def _artifact(stdout: str) -> Optional[dict[str, Any]]:
    text = stdout.strip()
    if not text:
        return None
    try:
        loaded = json.loads(text.splitlines()[-1])
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def npu_domain(
    *,
    scorecard: Mapping[str, Any],
    baseline_code: str,
    client: RunnerNpuClient,
    statement: str,
    should_stop: Optional[Callable[[], bool]] = None,
) -> Domain:
    """A domain whose score comes back from the Runner."""
    criteria = list(scorecard.get("criteria") or [])
    metric_key = str(criteria[0].get("id") or "score") if criteria else "score"

    def evaluate(code: str, shards) -> Tuple[bool, dict[str, Any], str]:
        del shards
        try:
            job, artifact = client.run(code, should_stop)
        except NpuJobError as error:
            return False, with_search_score({"job_status": "fault"}), str(error)
        valid, metrics, error = interpret_npu_job(job, artifact, metric_key=metric_key)
        return valid, with_search_score(metrics), error

    def reward(metrics: Mapping[str, Any]) -> float:
        return score_for_search(metrics)

    def prompt(program: Program) -> str:
        return f"{statement}\n{program.code}"

    def task_prompt(shard: int) -> str:
        return f"NPU job does not use shard {shard}"

    return Domain(
        name="npu-job",
        entrypoint="main",
        metric_key=metric_key,
        metric_better="higher",
        initial_program=baseline_code,
        initial_summary="NPU job result; a missing result is not a score",
        evaluate=evaluate,
        reward=reward,
        prompt=prompt,
        task_prompt=task_prompt,
        test_shards=(),
        data_summary={"metric": metric_key},
    )


def npu_client_from_spec(options: Mapping[str, Any], timeout: float) -> RunnerNpuClient:
    """Build the client from ``options['npu']``. Refuse when the runner is absent."""
    npu = options.get("npu")
    if not isinstance(npu, dict):
        raise NpuJobError("this search scores on NPU but was given no runner")
    url = npu.get("url")
    token = npu.get("token")
    execution = npu.get("execution")
    if not isinstance(url, str) or not url or not isinstance(token, str) or not token:
        raise NpuJobError("this search scores on NPU but was given no runner")
    if not isinstance(execution, dict):
        raise NpuJobError("this search scores on NPU but was given no execution template")
    if not isinstance(execution.get("code"), str) or not str(execution.get("code")).strip():
        raise NpuJobError("the NPU execution has no fixed program")
    return RunnerNpuClient(
        url=url,
        token=token,
        execution=execution,
        session_id=str(npu.get("sessionId") or ""),
        agent_id=str(npu.get("agentId") or ""),
        timeout=timeout,
        poll_seconds=float(npu.get("pollSeconds") or 0.25),
        transport=str(npu.get("transport") or "runner"),
    )
