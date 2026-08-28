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
 * Client for the evolve search sidecar (`services/evolve`, loopback :4313).
 *
 * The sidecar streams NDJSON event records on the response to `POST /runs`, so
 * the connection *is* the run's liveness signal: while it is open the search is
 * alive, and when it closes the run is over one way or another. That is why
 * there is no polling here and no callback endpoint on the API side.
 *
 * Nothing in this module writes to disk or decides a run's fate — it turns bytes
 * into records and hands them to the orchestrator.
 */

import type { EvolveEventRecord } from "@sciencediscovery/schema";

export interface EvolveRunSpec {
  algorithm: string;
  /** What the control plane's probe found; the sidecar never probes itself. */
  sandbox?: Record<string, unknown>;
  /** The program the search starts from. Empty means the engine's own seed. */
  baselineCode?: string;
  baselineScore?: number;
  candidateTimeoutSeconds?: number;
  /** Where this run's shards were staged. The split policy is decided here and
   *  read there; deciding it twice is how two answers start to disagree. */
  datasetDir?: string;
  engine?: string;
  expansions: number;
  /** `{url, token}` for the judge model, when the scorecard is graded by one.
   *  A second token because the proxy pins the model to the token. */
  judge?: { token: string; url: string };
  /** `{url, token}` — an **absolute** proxy URL. A sidecar that had to guess
   *  the API's origin would turn every expansion into a failed candidate. */
  llm?: { token: string; url: string };
  /** A snapshot of the project, for a test-gated search. */
  workspaceDir?: string;
  /** The rubric a judged scorecard grades against, inline. Small, frozen with
   *  the goal, and needed on every grading call. */
  /** Packages to put into the candidate runtime before anything runs. */
  packages?: string[];
  rubric?: string;
  /** The evaluator a scripted scorecard scores with, inline. Same reason as the
   *  rubric: the sidecar has no CAS access, and an evaluator is a page of
   *  Python — smaller than one candidate. */
  script?: string;
  maxTokensPerCall?: number;
  options?: Record<string, unknown>;
  /** Continue a previous run's numbering instead of restarting at 1. */
  resumeFromSequence?: number;
  /** The frozen scorecard body. The sidecar grades with it; the hash is the
   *  identity both sides agree on. */
  scorecard?: unknown;
  scorecardHash: string;
  searchId: string;
  statement?: string;
  /** `"disabled"` / `"enabled"`, or absent for the provider's own default. */
  thinking?: string;
  workers?: number;
}

export class EvolveSidecarError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A record the sidecar sent that did not parse as an event. Skipped rather
 * than fatal: one malformed line must not discard the run around it. */
export type EvolveSidecarWarning = (message: string) => void;

export interface EvolveSidecarOptions {
  internalToken: string;
  url: string;
}

export class EvolveSidecarClient {
  private readonly url: string;
  private readonly token: string;

  constructor(options: EvolveSidecarOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.token = options.internalToken;
  }

  /** The wire body, built once: `/runs` and `/probe` have to agree about every
   *  field, or the probe measures a different search than the one that runs. */
  private body(spec: EvolveRunSpec): Record<string, unknown> {
    return {
        algorithm: spec.algorithm,
        baseline_code: spec.baselineCode ?? "",
        baseline_score: spec.baselineScore,
        candidate_timeout_seconds: spec.candidateTimeoutSeconds ?? 60,
        dataset_dir: spec.datasetDir ?? "",
        engine: spec.engine ?? "stub",
        expansions: spec.expansions,
        judge: spec.judge ?? {},
        llm: spec.llm ?? {},
        max_tokens_per_call: spec.maxTokensPerCall ?? 16_000,
        options: spec.options ?? {},
        resume_from_sequence: spec.resumeFromSequence ?? 0,
        sandbox: spec.sandbox ?? {},
        scorecard: spec.scorecard ?? {},
        scorecard_hash: spec.scorecardHash,
        search_id: spec.searchId,
        packages: spec.packages ?? [],
        rubric: spec.rubric ?? "",
        script: spec.script ?? "",
        statement: spec.statement ?? "",
        thinking: spec.thinking ?? "",
        workspace_dir: spec.workspaceDir ?? "",
        workers: spec.workers ?? 1,
    };
  }

  /**
   * Score the starting point and a deliberately worse copy of it.
   *
   * Two evaluations before a run exists, which is what the answer costs. It
   * cannot be derived from the goal: "can this scoring tell a good candidate
   * from a bad one" is a fact about the data and the scorer, and its failure is
   * the silent one — a flat scorecard produces a search that emits every event
   * and finds nothing.
   */
  async probe(spec: EvolveRunSpec): Promise<{
    baseline: number;
    flat: boolean;
    label: string;
    worsened: number | null;
  }> {
    const response = await fetch(`${this.url}/probe`, {
      body: JSON.stringify(this.body(spec)),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      // The sidecar's own sentence, not its response body. A probe refusal is
      // the one sidecar error a user is expected to read and act on — it is
      // what stands between them and starting a run — and pasting
      // `{"detail":{"code":"probe_failed","message":"…"}}` onto the screen
      // hands them the wrapper and buries the sentence inside it.
      throw new EvolveSidecarError(
        await refusal(response, "the discrimination probe could not be taken"),
        response.status,
      );
    }
    return await response.json() as {
      baseline: number; flat: boolean; label: string; worsened: number | null;
    };
  }

  async health(): Promise<{ engine?: string; status: string } | undefined> {
    try {
      const response = await fetch(`${this.url}/health`);
      if (!response.ok) return undefined;
      return await response.json() as { engine?: string; status: string };
    } catch {
      return undefined;
    }
  }

  /**
   * Start a search and yield every event record it emits.
   *
   * `signal` aborts the HTTP request, which closes the sidecar's generator and
   * winds the engine down — the same path a crashed API takes, so it is
   * exercised by every cancelled run rather than only by a disaster.
   */
  async *stream(spec: EvolveRunSpec, signal?: AbortSignal, warn?: EvolveSidecarWarning): AsyncGenerator<EvolveEventRecord> {
    const response = await fetch(`${this.url}/runs`, {
      body: JSON.stringify(this.body(spec)),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      method: "POST",
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new EvolveSidecarError(
        `evolve sidecar refused the run (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        response.status,
      );
    }
    yield* parseNdjsonStream(response.body, warn);
  }

  /** Idempotent by contract: stopping an unknown or finished search is a
   * no-op, because the API races the stream's own completion. */
  async stop(searchId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/runs/${encodeURIComponent(searchId)}/stop`, {
        headers: { authorization: `Bearer ${this.token}` },
        method: "POST",
      });
      if (!response.ok) return false;
      const body = await response.json() as { stopped?: boolean };
      return body.stopped === true;
    } catch {
      return false;
    }
  }
}

/**
 * Split an NDJSON byte stream into event records.
 *
 * The buffer matters: a chunk boundary lands mid-line often enough that parsing
 * per chunk would drop roughly one event per network buffer. A trailing partial
 * line at end-of-stream is dropped — it is a torn write from a killed sidecar,
 * and the same tolerance the on-disk log reader applies.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  warn?: EvolveSidecarWarning,
): AsyncGenerator<EvolveEventRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseRecord(line, warn);
      if (record) yield record;
    }
    if (done) break;
  }
  if (buffer.trim()) warn?.(`dropped a torn trailing line (${buffer.length} bytes)`);
}

function parseRecord(line: string, warn?: EvolveSidecarWarning): EvolveEventRecord | undefined {
  if (!line.trim()) return undefined;
  let parsed: EvolveEventRecord;
  try {
    parsed = JSON.parse(line) as EvolveEventRecord;
  } catch {
    warn?.(`skipped a malformed NDJSON line (${line.slice(0, 120)})`);
    return undefined;
  }
  if (typeof parsed.sequence !== "number" || typeof parsed.createdAt !== "string" || !parsed.event?.type) {
    warn?.("skipped a record that is not an event");
    return undefined;
  }
  return parsed;
}

/**
 * The message inside a sidecar error response, or a plain fallback.
 *
 * FastAPI wraps a refusal as `{"detail": {"code": …, "message": …}}` and a
 * validation failure as `{"detail": [...]}`; older handlers send a bare string.
 * All three read as noise on a screen, and the sentence a user needs is one
 * level in.
 */
export async function refusal(response: Response, prefix: string): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    const detail = body.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  } catch {
    // Not JSON at all — a proxy page, an empty body. Falls through.
  }
  return `${prefix} (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`;
}
