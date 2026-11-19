// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Which artifacts a single assistant turn produced (#1252).
 *
 * The conversation used to say nothing about the files a turn wrote: they only
 * appeared in the right panel, grouped by Session, so the reader had to guess
 * which of a Session's artifacts came from the answer in front of them. The link
 * exists in the data — a version names the turn that wrote it — and this file
 * turns that into the strip the turn renders.
 *
 * The link is `version.turnId`, which is the `SessionRun` the transcript draws
 * (`packages/schema/src/artifact-provenance.ts`: "The client assigns it to the
 * visible top-level Run from `version.turnId`"). It is *not*
 * `version.executionRunIds`: those name the `ExecutionRun` — the code or shell
 * execution that wrote the bytes — a different identifier entirely. A real
 * version reads `{turnId: <SessionRun.id>, executionRunIds: [<ExecutionRun.id>]}`
 * and the two never share a value, so joining on the latter matches nothing.
 *
 * Two rules keep the strip honest:
 *
 *  - a version with no turn id is never attached. Uploads and hand-registered
 *    files have no turn, and pretending they do would put a file under an answer
 *    that never touched it;
 *  - one row per artifact, at the version that answers "what does this file look
 *    like now". That is the highest `version` ordinal, not the latest timestamp:
 *    an imported Session keeps the package's ordinals while `createdAt` can be
 *    the import time, so the two disagree exactly where it matters.
 *
 * A child agent's version names the *subagent* as its `turnId`, and the child
 * names the turn that delegated it in `parentTurnId`. Those are resolved up to
 * the run before anything is attached — four versions in one local catalog were
 * subagent-produced, and leaving them out silently would be a strip that quietly
 * omits half of what a run wrote.
 */
import type {
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  SessionArtifactOutput,
  Subagent,
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

/**
 * What is needed to say which Run a version belongs to.
 *
 * `runIds` is every Session run the transcript draws; `parentTurnBySubagent` maps
 * a child agent to the turn that delegated it, which is how a child's version
 * climbs back to its run.
 */
export interface TurnLineage {
  parentTurnBySubagent: ReadonlyMap<string, string>;
  runIds: ReadonlySet<string>;
}

export const EMPTY_LINEAGE: TurnLineage = { parentTurnBySubagent: new Map(), runIds: new Set() };

export const TURN_ARTIFACT_LIMIT = 5;

/** Build the lineage from the runs and children a Session's transcript holds. */
export function turnLineage(
  runIds: readonly string[],
  subagents: readonly Subagent[],
): TurnLineage {
  return {
    parentTurnBySubagent: new Map(subagents.map((subagent) => [subagent.id, subagent.parentTurnId])),
    runIds: new Set(runIds),
  };
}

/**
 * The Run a version belongs to, or `undefined` when the transcript cannot say.
 *
 * A main-agent version names the run directly; a child's names the child, so the
 * walk follows `parentTurnId` until it reaches a run. A cycle or an unknown id
 * yields nothing rather than a guess: attributing a file by timestamp would turn
 * project history into invented chat history, and the version stays reachable
 * from the panel's artifact list either way.
 */
export function ownerRunId(
  version: ScientificArtifactVersion,
  lineage: TurnLineage,
): string | undefined {
  const visited = new Set<string>();
  let current = version.turnId;
  while (current !== undefined && !visited.has(current)) {
    if (lineage.runIds.has(current)) return current;
    visited.add(current);
    current = lineage.parentTurnBySubagent.get(current);
  }
  return undefined;
}

function rank(kind: ScientificArtifactKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/** Negative when `a` is the newer version: ordinal, then time, then id.
 *
 * The id tiebreak makes picking one file's newest version deterministic when two
 * of its versions share an ordinal. It must not be used to order *different*
 * files — their ids always differ, so it would always fire and decide the whole
 * list. See `compareRows`. */
function compareVersion(a: ScientificArtifactVersion, b: ScientificArtifactVersion): number {
  if (a.version !== b.version) return b.version - a.version;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The same order without the id, so a tie reaches the name. */
function compareRows(a: TurnArtifact, b: TurnArtifact): number {
  if (a.version.version !== b.version.version) return b.version.version - a.version.version;
  if (a.version.createdAt !== b.version.createdAt) return a.version.createdAt < b.version.createdAt ? 1 : -1;
  const byName = a.artifact.name.localeCompare(b.artifact.name);
  if (byName !== 0) return byName;
  // Two artifacts can share a name; only then does the id settle the order.
  return a.artifact.id < b.artifact.id ? -1 : a.artifact.id > b.artifact.id ? 1 : 0;
}

/** The artifacts of one run, ready to render. `limit` 0 disables the cap. */
export function turnArtifacts(
  outputs: readonly SessionArtifactOutput[],
  runId: string | undefined,
  lineage: TurnLineage = EMPTY_LINEAGE,
  limit: number = TURN_ARTIFACT_LIMIT,
): TurnArtifacts {
  if (!runId) return { visible: [], hidden: 0 };
  return select(
    outputs.filter((output) => ownerRunId(output.version, lineage) === runId),
    limit,
  );
}

function select(outputs: readonly SessionArtifactOutput[], limit: number): TurnArtifacts {
  const byArtifact = new Map<string, TurnArtifact>();
  for (const { artifact, version } of outputs) {
    const existing = byArtifact.get(artifact.id);
    if (existing && compareVersion(existing.version, version) <= 0) continue;
    byArtifact.set(artifact.id, { artifact, updated: Boolean(version.baseVersionId), version });
  }

  const rows = [...byArtifact.values()].sort((a, b) =>
    rank(a.artifact.kind) - rank(b.artifact.kind) || compareRows(a, b));

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
  lineage: TurnLineage = EMPTY_LINEAGE,
  limit: number = TURN_ARTIFACT_LIMIT,
): Map<string, TurnArtifacts> {
  const perRun = new Map<string, SessionArtifactOutput[]>();
  for (const output of outputs) {
    const runId = ownerRunId(output.version, lineage);
    if (runId === undefined) continue;
    const bucket = perRun.get(runId);
    if (bucket) bucket.push(output);
    else perRun.set(runId, [output]);
  }

  const summary = new Map<string, TurnArtifacts>();
  for (const [runId, subset] of perRun) summary.set(runId, select(subset, limit));
  return summary;
}
