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

"""Protocol experiments against a live JiuwenSwarm gateway (issue 86).

Answers the questions the source does not settle, by doing them:

  disconnect   what happens to a run when its client goes away
  two-clients  what a second connection on the same session sees and can do
  faults       which frames a failing model produces (401, 429, 500, no endpoint, bad stream)
  resume       what chat.resume does from a new connection after the first one dropped

    JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:21001/tui JIUWENSWARM_MGMT_URL=ws://127.0.0.1:21000/ws \
      python tools/probe_gateway.py disconnect two-clients faults

It starts its own scripted model on a free port, adds it under a private alias and removes
it afterwards. Output is one line per frame so it can be pasted into an issue.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import websockets

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from sciencediscovery_adapter.gateway import ChatRun, rpc  # noqa: E402

GATEWAY = os.environ["JIUWENSWARM_GATEWAY_URL"]
MGMT = os.environ["JIUWENSWARM_MGMT_URL"]


class Model(BaseHTTPRequestHandler):
    """Behaviour is chosen per model name: ok, slow, http401, http429, http500, brokenstream."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        mode = body.get("model", "ok").removeprefix("probe-")
        if not body.get("tools"):  # JiuwenSwarm's modality probe on a new model
            self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}).encode())
            return
        if mode.startswith("http"):
            self.send_response(int(mode[4:])); self.send_header("content-type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": f"scripted {mode}"}}).encode())
            return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        chunk = lambda delta, finish=None: "data: " + json.dumps({"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"
        if mode == "slow":
            for _ in range(20):
                self.wfile.write(chunk({"content": "tick "}).encode()); self.wfile.flush(); time.sleep(1)
        elif mode == "brokenstream":
            self.wfile.write(chunk({"content": "half an ans"}).encode()); self.wfile.write(b"data: {not json\n\n"); self.wfile.flush()
            return
        else:
            self.wfile.write(chunk({"content": "fine"}).encode())
        self.wfile.write(chunk({}, "stop").encode()); self.wfile.write(b"data: [DONE]\n\n")


def start_model() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def params(session: str, text: str, model: str) -> dict:
    return {"session_id": session, "content": text, "query": text, "mode": "agent.work.normal", "cwd": "/tmp",
            "project_dir": "/tmp", "trusted_dirs": ["/tmp"], "supports_user_interaction": False,
            "agent_ref": {"mode": "agent.work.normal", "id": "default"}, "model_name": model}


def line(t0: float, who: str, frame: dict) -> None:
    what = frame.get("event") or f"{frame.get('type')} ok={frame.get('ok')}"
    payload = frame.get("payload") or {}
    detail = payload.get("error") or payload.get("content") or payload.get("message") or ""
    print(f"  {time.time() - t0:5.1f}s {who:<7} {what:<28} {str(detail)[:110]!r}")


async def watch(url: str, who: str, t0: float, seconds: float, send: dict | None = None) -> list[dict]:
    seen: list[dict] = []
    async with websockets.connect(url, max_size=None) as ws:
        await ws.recv()
        if send:
            await ws.send(json.dumps(send))
        end = time.time() + seconds
        while time.time() < end:
            try:
                frame = json.loads(await asyncio.wait_for(ws.recv(), max(0.1, end - time.time())))
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                break
            if frame.get("event") not in ("context.usage",):
                seen.append(frame)
                line(t0, who, frame)
    return seen


def req(session: str, text: str, model: str) -> dict:
    return {"type": "req", "id": "chat-" + uuid.uuid4().hex[:8], "method": "chat.send", "is_stream": True, "params": params(session, text, model)}


async def disconnect(port: int) -> None:
    print("\n== disconnect: a client drops its connection mid-run")
    session, t0 = f"probe-dc-{uuid.uuid4().hex[:6]}", time.time()
    async with websockets.connect(GATEWAY, max_size=None) as ws:
        await ws.recv()
        await ws.send(json.dumps(req(session, "count slowly", "probe-slow")))
        end = time.time() + 4
        while time.time() < end:
            try:
                line(t0, "client", json.loads(await asyncio.wait_for(ws.recv(), max(0.1, end - time.time()))))
            except asyncio.TimeoutError:
                break
    print("  --- connection closed by the client; watching from a new connection ---")
    await watch(GATEWAY, "watcher", t0, 6)
    print("  --- a new request on the same session ---")
    await watch(GATEWAY, "second", t0, 15, req(session, "are you free?", "probe-ok"))


async def resume(port: int) -> None:
    print("\n== resume: chat.resume from a new connection after the first one dropped (and with no run to resume)")
    session, t0 = f"probe-rs-{uuid.uuid4().hex[:6]}", time.time()
    async with websockets.connect(GATEWAY, max_size=None) as ws:
        await ws.recv()
        await ws.send(json.dumps(req(session, "count slowly", "probe-slow")))
        end = time.time() + 3
        while time.time() < end:
            try:
                line(t0, "client", json.loads(await asyncio.wait_for(ws.recv(), max(0.1, end - time.time()))))
            except asyncio.TimeoutError:
                break
    gap = float(os.environ.get("PROBE_RESUME_GAP", "0"))
    print(f"  --- connection closed; {gap}s later, chat.resume from a new connection ---")
    await asyncio.sleep(gap)
    resume_request = {**req(session, "", "probe-slow"), "method": "chat.resume"}
    await watch(GATEWAY, "resume", t0, 12, resume_request)
    print("  --- chat.resume on a session that never ran ---")
    idle = {**req(f"probe-rs-{uuid.uuid4().hex[:6]}", "", "probe-ok"), "method": "chat.resume"}
    await watch(GATEWAY, "idle", time.time(), 6, idle)


async def two_clients(port: int) -> None:
    print("\n== two clients on one session")
    session, t0 = f"probe-2c-{uuid.uuid4().hex[:6]}", time.time()
    first = asyncio.create_task(watch(GATEWAY, "first", t0, 12, req(session, "count slowly", "probe-slow")))
    await asyncio.sleep(2)
    listener = asyncio.create_task(watch(GATEWAY, "listener", t0, 8))           # connects, asks nothing
    second = asyncio.create_task(watch(GATEWAY, "second", t0, 8, req(session, "me too", "probe-ok")))  # same session
    await asyncio.gather(first, listener, second)


async def faults(port: int) -> None:
    print("\n== faults: what a failing model looks like")
    for mode in ("http401", "http429", "http500", "brokenstream"):
        print(f"  -- model behaviour: {mode}")
        await watch(GATEWAY, mode[:7], time.time(), 25, req(f"probe-f-{uuid.uuid4().hex[:6]}", "hello", f"probe-{mode}"))


async def main() -> None:
    server, port = start_model()
    models = (await rpc(MGMT, "models.list")).get("models", [])
    added = [{"model_name": f"probe-{mode}", "api_base": f"http://127.0.0.1:{port}/v1", "api_key": "k", "model_provider": "OpenAI", "is_default": False}
             for mode in ("ok", "slow", "http401", "http429", "http500", "brokenstream")]
    keep = [{k: v for k, v in m.items() if k != "origin_index"} for m in models]
    await rpc(MGMT, "models.replace_all", {"models": [*keep, *added]})
    try:
        for name in sys.argv[1:] or ["disconnect", "two-clients", "faults"]:
            await {"disconnect": disconnect, "two-clients": two_clients, "faults": faults, "resume": resume}[name](port)
    finally:
        await rpc(MGMT, "models.replace_all", {"models": keep})
        server.shutdown()


asyncio.run(main())
