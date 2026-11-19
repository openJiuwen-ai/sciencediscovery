// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Which artifacts a single assistant turn produced (#1252).
 *
 * The conversation used to say nothing about the files a turn wrote: they only
 * appeared in the right panel, grouped by Session, so the reader had to guess
 * which of a Session's artifacts came from the answer in front of them. The link
 * exists in the data — a version records the runs that wrote it — and this file
 * turns that into the strip the turn renders.
 *
 * Two rules keep the strip honest:
 *
 *  - a version with no `executionRunIds` is never attached. Uploads and
 *    hand-registered files have no run, and pretending they do would put a file
 *    under an answer that never touched it;
 *  - one row per artifact, at the version that answers "what does this file look
 *    like now". That is the highest `version` ordinal, not the latest timestamp:
 *    an imported Session keeps the package's ordinals while `createdAt` can be
 *    the import time, so the two disagree exactly where it matters.
 */
import type {
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  SessionArtifactOutput,
} from "@sciencediscovery/schema";

/** Kinds that answer "what did this turn hand me", most useful first. */
const KIND_ORDER: ScientificArtifactKind[] = [
  "report",
  "figure",
  "dataset",
  "structure",
  "notebook",
  "markdown",
  "html",
  "latex",
  "json",
  "other",
];

/**
 * Kinds that are usually intermediate plumbing — a JSON dump, an execution log —
 * rather than something the reader wants first. They are folded behind the
 * overflow row unless they are all the turn produced.
 */
const FOLDED: ReadonlySet<ScientificArtifactKind> = new Set<ScientificArtifactKind>(["json", "other"]);

export interface TurnArtifact {
  artifact: ScientificArtifact;
  version: ScientificArtifactVersion;
  /**
   * The turn changed an existing artifact rather than creating one.
   *
   * Read from the version the row points at, i.e. from the final derivation: a run
   * that created v1 and then wrote v2 leaves v2 with a `baseVersionId`, so a file
   * this turn created is marked 已更新. That is rare and accepted — the marker
   * answers "did the last write derive from an earlier one", not "did this run
   * create the artifact".
   */
  updated: boolean;
}

export interface TurnArtifacts {
  visible: TurnArtifact[];
  /** Everything the strip does not show: folded kinds plus the cap overflow. */
  hidden: number;
}

export const TURN_ARTIFACT_LIMIT = 5;

function rank(kind: ScientificArtifactKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/** Negative when `a` is the newer version: ordinal, then time, then id. */
function compareVersion(a: ScientificArtifactVersion, b: ScientificArtifactVersion): number {
  if (a.version !== b.version) return b.version - a.version;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The artifacts one run produced, ready to render.
 *
 * `limit` is the number of rows shown before the strip stops and offers the rest;
 * passing 0 disables the cap.
 */
export function turnArtifacts(
  outputs: readonly SessionArtifactOutput[],
  runId: string | undefined,
  limit: number = TURN_ARTIFACT_LIMIT,
): TurnArtifacts {
  if (!runId) return { visible: [], hidden: 0 };

  const byArtifact = new Map<string, TurnArtifact>();
  for (const { artifact, version } of outputs) {
    if (!version.executionRunIds.includes(runId)) continue;
    const existing = byArtifact.get(artifact.id);
    if (existing && compareVersion(existing.version, version) <= 0) continue;
    byArtifact.set(artifact.id, { artifact, updated: Boolean(version.baseVersionId), version });
  }

  const rows = [...byArtifact.values()].sort((a, b) => {
    const byKind = rank(a.artifact.kind) - rank(b.artifact.kind);
    if (byKind !== 0) return byKind;
    const byVersion = compareVersion(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return a.artifact.name.localeCompare(b.artifact.name);
  });

  const important = rows.filter((row) => !FOLDED.has(row.artifact.kind));
  const folded = rows.filter((row) => FOLDED.has(row.artifact.kind));
  // Intermediate kinds sit behind the overflow row when the turn also produced
  // something better; a turn that produced *only* plumbing still shows it, because
  // an empty strip with "3 more" and nothing behind it reads as a bug.
  const pool = important.length > 0 ? important : folded;
  const visible = limit > 0 ? pool.slice(0, limit) : pool;

  return { visible, hidden: rows.length - visible.length };
}

/**
 * The same selection for every run in one Session, computed once.
 *
 * The conversation draws one `AssistantTurns` per turn and the panel already
 * rebuilds its grouping on every render; asking each turn to walk the whole
 * output list would make typing in the composer cost O(turns × outputs). The
 * caller memoises this on the `outputs` reference instead.
 */
export function turnArtifactsByRun(
  outputs: readonly SessionArtifactOutput[],
  limit: number = TURN_ARTIFACT_LIMIT,
): Map<string, TurnArtifacts> {
  const perRun = new Map<string, SessionArtifactOutput[]>();
  for (const output of outputs) {
    for (const runId of output.version.executionRunIds) {
      const bucket = perRun.get(runId);
      if (bucket) bucket.push(output);
      else perRun.set(runId, [output]);
    }
  }

  const summary = new Map<string, TurnArtifacts>();
  for (const [runId, subset] of perRun) summary.set(runId, turnArtifacts(subset, runId, limit));
  return summary;
}
