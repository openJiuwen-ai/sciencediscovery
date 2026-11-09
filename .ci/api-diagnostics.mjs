// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { channel } from "node:diagnostics_channel";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { join } from "node:path";

/** CI-only observers. No request wrapping, payloads, headers, env dumps or
 * exception handlers; sampling must not alter service exit or keep it alive. */
export function startApiDiagnostics(directory, { intervalMs = 2000, slowRequestMs = 1000 } = {}) {
  let file;
  try { mkdirSync(directory, { recursive: true }); file = join(directory, `api-${process.pid}.jsonl`); }
  catch { return; }
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let gcCount = 0, gcMs = 0, requests = 0, slowRequests = 0, maxRequestMs = 0, writing = false;
  let runsRequests = 0, runsMaxMs = 0;
  const gc = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { gcCount++; gcMs += entry.duration; }
  });
  gc.observe({ entryTypes: ["gc"] });
  const starts = new WeakMap();
  const onStart = ({ request }) => { if (request && typeof request === "object") starts.set(request, performance.now()); };
  const onFinish = ({ request }) => {
    const started = starts.get(request);
    if (started === undefined) return;
    starts.delete(request);
    const duration = performance.now() - started;
    requests++; maxRequestMs = Math.max(maxRequestMs, duration);
    if (duration >= slowRequestMs) slowRequests++;
    if (request.method === "GET" && /^\/api\/sessions\/[^/]+\/runs$/.test((request.url ?? "").split("?")[0])) {
      runsRequests++; runsMaxMs = Math.max(runsMaxMs, duration);
    }
  };
  const start = channel("http.server.request.start"), finish = channel("http.server.response.finish");
  start.subscribe(onStart); finish.subscribe(onFinish);
  const sample = (phase, code) => {
    const memory = process.memoryUsage();
    const row = { time: new Date().toISOString(), pid: process.pid, phase,
      ...(code === undefined ? {} : { code }), heapUsed: memory.heapUsed, rss: memory.rss,
      external: memory.external, eventLoopMaxMs: loop.max / 1e6, gcCount, gcMs,
      requests, slowRequests, maxRequestMs, runsRequests, runsMaxMs };
    loop.reset(); gcCount = 0; gcMs = 0; requests = 0; slowRequests = 0; maxRequestMs = 0;
    runsRequests = 0; runsMaxMs = 0;
    return JSON.stringify(row) + "\n";
  };
  const timer = setInterval(() => {
    if (writing) return; // A slow diagnostics disk must not queue unbounded writes.
    writing = true;
    void appendFile(file, sample("sample"), { mode: 0o600 }).catch(() => {}).finally(() => { writing = false; });
  }, intervalMs);
  timer.unref();
  process.once("exit", code => {
    clearInterval(timer); gc.disconnect(); loop.disable();
    start.unsubscribe(onStart); finish.unsubscribe(onFinish);
    try { appendFileSync(file, sample("exit", code), { mode: 0o600 }); } catch { /* observations are best effort */ }
  });
}

const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
if (process.env.SD_CI_DIAGNOSTICS_DIR && (entry.endsWith("/services/api/dist/server.js")
    || (process.env.SCIENCE_AGENT_API_ENTRYPOINT && process.argv[1] === process.env.SCIENCE_AGENT_API_ENTRYPOINT))) {
  try { startApiDiagnostics(process.env.SD_CI_DIAGNOSTICS_DIR); } catch { /* diagnostics cannot block product startup */ }
}
