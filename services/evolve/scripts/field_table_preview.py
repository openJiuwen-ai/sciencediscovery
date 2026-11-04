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

"""A loopback page for the inner-loop field table in issue #812.

The table is the confirmation view: field name, current value, and a tick for
whether this run may change it. After start, each row is the changed field, the
old value, the new value, and the score. A waiting, rejected, or non-NPU result
is shown empty, never as 0. The numbers are scripted so the page can be opened
without a card; they do not claim an antibody result.
"""

from __future__ import annotations

import html
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs

from sciencediscovery_evolve.direction import baseline_rows
from sciencediscovery_evolve.field_table import scripted_rounds

EXAMPLE = {"pos_2": "T", "pos_4": "K", "model": "fixed"}
PREVIEW = "这是一次界面核对。分数是写死的状态，不代表抗体设计变好。"


def _page(baseline: dict[str, Any], editable: list[str], rounds: list[dict[str, str]], message: str) -> bytes:
    rows = baseline_rows(json.dumps(baseline, ensure_ascii=False))
    body = [
        "<!doctype html><html lang=zh-CN><head><meta charset=utf-8>",
        "<meta name=viewport content='width=device-width, initial-scale=1'>",
        "<title>Evolve 字段表</title><style>",
        "body{margin:0;font:16px/1.5 ui-sans-serif,system-ui;background:#10140f;color:#e7f0df}",
        "main{max-width:880px;margin:0 auto;padding:28px 20px 64px}",
        "h1{font-size:28px;margin:0 0 8px} p.lead{color:#b7c7ae}",
        "table{width:100%;border-collapse:collapse;margin:16px 0 24px}",
        "th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #2a3326;vertical-align:top}",
        "th{color:#8ea386;font-weight:600;font-size:13px}",
        "button,label.tick{min-height:44px} button{background:#d6f5a2;color:#17210f;border:0;border-radius:8px;padding:0 18px;font:inherit;cursor:pointer}",
        "code{font-family:ui-monospace,monospace} .note{color:#b7c7ae} .warn{color:#f0c674}",
        "</style></head><body><main>",
        "<h1>这一次可以改哪些字段</h1>",
        f"<p class=lead>{html.escape(PREVIEW)}</p>",
    ]
    if message:
        body.append(f"<p class=warn>{html.escape(message)}</p>")
    body.append("<form method=post action=/start><table><thead><tr><th>字段</th><th>当前值</th><th>这次可以改</th></tr></thead><tbody>")
    for row in rows:
        checked = " checked" if row["field"] in editable else ""
        value = row["value"]
        shown = value if len(value) <= 24 else value[:24] + "…"
        body.append(
            "<tr><td><code>" + html.escape(row["field"]) + "</code></td><td>"
            + (html.escape(shown) if shown == value else f"<details><summary>{html.escape(shown)}</summary><code>{html.escape(value)}</code></details>")
            + f"</td><td><label class=tick><input type=checkbox name=editable value='{html.escape(row['field'])}'{checked}> 可以改</label></td></tr>"
        )
    body.append("</tbody></table><button type=submit>同意开始</button></form>")
    if rounds:
        body.append("<h2>运行中</h2><table><thead><tr><th>发生了什么</th><th>字段</th><th>旧值</th><th>新值</th><th>分数</th><th>说明</th></tr></thead><tbody>")
        for row in rounds:
            body.append("<tr>" + "".join(f"<td>{html.escape(row[key])}</td>" for key in ("title", "field", "old", "new", "score", "note")) + "</tr>")
        body.append("</tbody></table>")
    body.append("</main></body></html>")
    return "".join(body).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    baseline = dict(EXAMPLE)
    editable = ["pos_2", "pos_4"]
    rounds: list[dict[str, str]] = []
    message = ""

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/":
            self.send_error(404)
            return
        self._send(_page(self.baseline, self.editable, self.rounds, self.message))

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/start":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length") or 0)
        form = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
        editable = form.get("editable", [])
        if not editable:
            Handler.message = "至少勾选一个字段。"
            Handler.rounds = []
        else:
            Handler.editable = editable
            Handler.message = ""
            Handler.rounds = scripted_rounds(self.baseline, editable)
        self.send_response(303)
        self.send_header("location", "/")
        self.end_headers()

    def _send(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        del fmt, args


def main() -> None:
    host = os.environ.get("PREVIEW_HOST", "127.0.0.1")
    port = int(os.environ.get("PREVIEW_PORT", "18787"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"field table preview http://{host}:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
