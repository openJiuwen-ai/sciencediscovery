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

"""FastAPI app: health, start a search (NDJSON stream), stop a search.

Routes:

- ``GET  /health`` → ``{status, engine}`` (no auth; the stack's readiness probe)
- ``POST /runs`` (Bearer) → ``application/x-ndjson`` stream of event records
- ``POST /runs/{search_id}/stop`` (Bearer) → ``{stopped}``

Loopback only. Bearer via ``SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN``.

**Why the events stream back on the request rather than being posted to the
API**: the API already owns the run's lifetime — it opened the request and will
close it — so the connection *is* the run's liveness signal. A callback design
would need its own retry, auth and orphan-detection story to answer "is this run
still alive", and the answer would still be worse than "the socket is open".

For PUCT/OpenEvolve, everything needed to replay, resume or audit a run
lives in the API's ``events.ndjson``; this process only holds the stop flags of
searches currently in flight.

Idea Tree uses a separate autonomous lifecycle router and persists its stages
in idea-research/. Run this service with one ASGI worker.
"""

from __future__ import annotations

import os
import threading
from queue import Empty, Queue
from typing import Any, Iterator

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import events
from .auth import require_internal_token
from .engine import Engine, RunSpec
from .events import HEARTBEAT, EventStream, encode_ndjson
from .logging_config import get_logger
from .openevolve_engine import OpenEvolveEngine
from .puct_engine import PuctEngine
from .stub_engine import StubEngine
from .vendor.puct.sandbox import SandboxCapability, detect_local_capability

log = get_logger("server")

from .vendor.idea_tree.idea_tree_service import router as idea_tree_router

from .vendor.idea_tree.research_service import router as idea_research_router

app = FastAPI(title="sciencediscovery-evolve")
app.include_router(idea_tree_router)
app.include_router(idea_research_router)

#: Engines by name; the request's ``engine`` field selects, so an operator can
#: pin the stub for a reproduction without touching the API.
#:
#: The default is still ``stub``. Flipping it to follow ``algorithm`` waits for
#: the control plane to stage datasets: until then a ``puct`` run has nothing to
#: measure, and defaulting to it would replace a working demo with a run that
#: refuses at the first expansion.
#: ``"era"`` is the name this engine shipped under before the rename, kept as an
#: alias because the control plane sends whatever a stored goal recorded and a
#: run created back then recorded the old one. Unknown engine names are a 400,
#: so dropping it would turn an old run into a refusal rather than a fallback.
ENGINES: dict[str, Engine] = {
    "puct": PuctEngine(),
    "era": PuctEngine(),
    "openevolve": OpenEvolveEngine(),
    "stub": StubEngine(),
}

_ALGORITHMS = {"puct", "era", "openevolve"}

#: Bounded so a slow reader blocks the engine rather than growing memory.
_QUEUE_DEPTH = 1024
#: How long the stream waits for the engine thread after the client goes away.
_SHUTDOWN_TIMEOUT_SECONDS = 5.0

#: A bare newline down the wire when nothing has happened for this long.
#:
#: One expansion is one model call plus a sandboxed execution per shard, and on
#: a reasoning model that is minutes of silence. The client's HTTP stack does
#: not know the difference between "thinking" and "dead": undici's body timeout
#: is 300 seconds, so the API aborted the response mid-run and the search died
#: reporting ``terminated`` — after which the sidecar's remaining calls 401'd
#: against a token that had been revoked with the run.
#:
#: A blank line rather than an event: the NDJSON reader already skips empty
#: lines, so this costs no sequence number, writes nothing to ``events.ndjson``
#: and cannot be mistaken for something that happened.
_HEARTBEAT_SECONDS = 15.0

#: Searches currently in flight, and their stop flags. Cleared when the
#: generator finishes, so a crashed stream cannot leak a flag forever.
_running: dict[str, threading.Event] = {}
_running_lock = threading.Lock()


class RunRequest(BaseModel):
    search_id: str = Field(min_length=1, max_length=200)
    algorithm: str = "puct"
    expansions: int = Field(default=6, ge=1, le=10_000)
    scorecard_hash: str = Field(min_length=1, max_length=200)
    #: The frozen scorecard body. Absent for engines that grade nothing.
    scorecard: dict[str, Any] = Field(default_factory=dict)
    statement: str = ""
    #: Where the control plane staged this run's shards.
    dataset_dir: str = ""
    baseline_code: str = ""
    candidate_timeout_seconds: float = Field(default=60.0, gt=0, le=86_400)
    max_tokens_per_call: int = Field(default=16_000, ge=1)
    thinking: str = ""
    #: Packages the candidates need that this runtime may not have.
    packages: list[str] = Field(default_factory=list)
    rubric: str = ""
    #: The evaluator a `custom_script` scorecard scores with. Sent as text for
    #: the same reason the rubric is: this side has no CAS, and an evaluator is
    #: a page of Python — smaller than one candidate.
    script: str = ""
    source_material: str = ""
    workspace_dir: str = ""
    #: ``{url, token}`` for the judge model. Separate from `llm` because they
    #: are different models and the proxy pins one model per token.
    judge: dict[str, Any] = Field(default_factory=dict)
    baseline_score: float | None = None
    workers: int = Field(default=1, ge=1, le=64)
    resume_from_sequence: int = Field(default=0, ge=0)
    engine: str = "stub"
    options: dict[str, Any] = Field(default_factory=dict)
    #: From the control plane's probe. Absent means "no isolation", which every
    #: engine that executes candidates must refuse — the stub does not execute
    #: anything, so it runs either way.
    sandbox: dict[str, Any] = Field(default_factory=dict)
    #: ``{url, token}`` for the control plane's model proxy. Absent for engines
    #: that make no model calls (the stub).
    llm: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, str]:
    with _running_lock:
        in_flight = len(_running)
    # The local probe is reported for diagnosis only. What a run actually uses
    # comes from the control plane, which knows about the container corrections.
    local = detect_local_capability()
    return {
        "engine": ",".join(sorted(ENGINES)),
        "running": str(in_flight),
        "sandbox_local": local.backend or "none",
        "status": "healthy",
    }


def spec_sandbox(request: "RunRequest") -> SandboxCapability:
    return SandboxCapability(
        backend=request.sandbox.get("backend"),
        bwrap_path=request.sandbox.get("bwrap_path", "bwrap"),
        disable_userns=bool(request.sandbox.get("disable_userns", False)),
        proc_mode=request.sandbox.get("proc_mode", "proc"),
    )


@app.post("/probe", dependencies=[Depends(require_internal_token)])
def probe(request: RunRequest) -> dict[str, Any]:
    """Score the starting point, and a copy of it that was made worse.

    The one pre-flight check that cannot be answered by reading the goal: does
    this scoring function have any ordering power? A wrong scale makes the
    engine throw and a wrong direction is caught by the normalisation table, but
    a scorecard that gives the same number to a good candidate and a bad one
    fails **silently** — every event is emitted, every candidate is recorded,
    and the search walks randomly on flat terrain.

    Two evaluations, which is what it costs. A search costs that per expansion,
    times the budget.
    """
    from .probe import ProbeError, run_probe

    spec = _spec_of(request)
    try:
        return run_probe(spec)
    except ProbeError as error:
        raise HTTPException(status_code=400, detail={
            "code": "probe_failed", "message": str(error),
        }) from error


@app.post("/runs", dependencies=[Depends(require_internal_token)])
def start_run(request: RunRequest) -> StreamingResponse:
    if request.algorithm not in _ALGORITHMS:
        raise HTTPException(status_code=400, detail={
            "code": "unknown_algorithm",
            "message": f"algorithm must be one of {sorted(_ALGORITHMS)}",
        })
    engine = ENGINES.get(request.engine)
    if engine is None:
        raise HTTPException(status_code=400, detail={
            "code": "unknown_engine",
            "message": f"engine must be one of {sorted(ENGINES)}",
        })

    # A judged scorecard executes nothing: the candidate is text and a model
    # reads it. Requiring isolation there would refuse a run that never runs
    # anything, which is the opposite of what the refusal is for.
    executes = any(
        (criterion.get("measure") or {}).get("kind") != "llm_judge"
        for criterion in (request.scorecard.get("criteria") or [])
    ) or not request.scorecard
    if getattr(engine, "requires_sandbox", True) and executes and not spec_sandbox(request).available:
        # The refusal is the feature. A candidate is model-written Python that
        # gets executed; running it unconfined because the sandbox is missing
        # would be the wrong way to make anything portable.
        raise HTTPException(status_code=400, detail={
            "code": "sandbox_unavailable",
            "message": "no candidate isolation available: install Bubblewrap (bwrap) on Linux, "
                       "or run on macOS where sandbox-exec ships with the system",
        })

    stop = threading.Event()
    with _running_lock:
        if request.search_id in _running:
            raise HTTPException(status_code=409, detail={
                "code": "already_running",
                "message": f"search {request.search_id} is already in flight",
            })
        _running[request.search_id] = stop

    spec = _spec_of(request)
    log.info(
        "run %s starting: engine=%s algorithm=%s expansions=%d",
        spec.search_id, engine.name, spec.algorithm, spec.expansions,
    )
    return StreamingResponse(
        encode_ndjson(_run_events(engine, spec, stop)),
        media_type="application/x-ndjson",
    )


def _spec_of(request: "RunRequest") -> RunSpec:
    """One place that turns a request into a spec, because `/runs` and `/probe`
    have to agree about every field or the probe measures a different search."""
    return RunSpec(
        search_id=request.search_id,
        algorithm=request.algorithm,
        expansions=request.expansions,
        scorecard_hash=request.scorecard_hash,
        scorecard=dict(request.scorecard),
        statement=request.statement,
        dataset_dir=request.dataset_dir,
        baseline_code=request.baseline_code,
        candidate_timeout_seconds=request.candidate_timeout_seconds,
        max_tokens_per_call=request.max_tokens_per_call,
        thinking=request.thinking,
        packages=tuple(request.packages),
        rubric=request.rubric,
        script=request.script,
        source_material=request.source_material,
        workspace_dir=request.workspace_dir,
        judge_url=str(request.judge.get("url", "")),
        judge_token=str(request.judge.get("token", "")),
        baseline_score=request.baseline_score,
        workers=request.workers,
        resume_from_sequence=request.resume_from_sequence,
        options=dict(request.options),
        sandbox=spec_sandbox(request),
        llm_url=str(request.llm.get("url", "")),
        llm_token=str(request.llm.get("token", "")),
    )


@app.post("/runs/{search_id}/stop", dependencies=[Depends(require_internal_token)])
def stop_run(search_id: str) -> dict[str, bool]:
    """Idempotent: stopping an unknown or finished search is not an error —
    the API may well be racing the stream's own completion."""
    with _running_lock:
        flag = _running.get(search_id)
    if flag is None:
        return {"stopped": False}
    flag.set()
    log.info("run %s stop requested", search_id)
    return {"stopped": True}


def _run_events(
    engine: Engine, spec: RunSpec, stop: threading.Event,
) -> Iterator[dict[str, Any] | bytes]:
    """Drive the engine on a worker thread and yield records as they are produced.

    Three properties this shape buys, none of which a "collect then return"
    version has:

    * **The dashboard moves while the search runs.** A real search is minutes
      long; buffering would show a frozen screen for all of it.
    * **Backpressure.** A bounded queue makes a slow reader block the engine
      instead of growing memory without limit.
    * **A disconnect winds the run down.** If the API goes away mid-stream the
      generator is closed, the ``finally`` sets the stop flag, and the engine
      stops burning budget for an audience that left.
    """
    stream = EventStream(start_at=spec.resume_from_sequence)
    queue: Queue[dict[str, Any] | None] = Queue(maxsize=_QUEUE_DEPTH)
    failure: list[BaseException] = []

    def emit(event: dict[str, Any]) -> None:
        queue.put(stream.record(event))

    def drive() -> None:
        try:
            engine.run(spec, emit, stop.is_set)
        except BaseException as exc:  # noqa: BLE001 - reported as a failed run below
            failure.append(exc)
            log.exception("run %s engine failed", spec.search_id)
        finally:
            queue.put(None)

    worker = threading.Thread(target=drive, name=f"evolve-{spec.search_id}", daemon=True)
    worker.start()
    try:
        while True:
            try:
                record = queue.get(timeout=_HEARTBEAT_SECONDS)
            except Empty:
                # Nothing happened, and that is normal: keep the socket warm so
                # the client's read timeout does not mistake a long expansion
                # for a dead sidecar.
                yield HEARTBEAT
                continue
            if record is None:
                break
            yield record
        if failure:
            # An engine that dies mid-run must still close the stream with a
            # terminal event: without one the API cannot tell "died" from
            # "still running", and the run would sit active forever.
            yield stream.record(events.log("error", f"engine failed: {failure[0]!r}"))
            yield stream.record(events.search_finished("failed", None, 0))
    finally:
        stop.set()
        worker.join(timeout=_SHUTDOWN_TIMEOUT_SECONDS)
        with _running_lock:
            _running.pop(spec.search_id, None)


def main() -> None:
    import uvicorn

    host = os.environ.get("SCIENCE_AGENT_EVOLVE_HOST", "127.0.0.1")
    port = int(os.environ.get("SCIENCE_AGENT_EVOLVE_PORT", "4313"))
    log.info("evolve service starting on %s:%s", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
