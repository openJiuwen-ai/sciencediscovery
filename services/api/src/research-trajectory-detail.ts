// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import type { TrajectoryDetail, TrajectoryEntry, TrajectoryIndex } from "@sciencediscovery/trajectory";

/**
 * Read one trajectory entry's detail, turning an unreadable record into an
 * omission instead of failing the whole preview or export (#1083).
 *
 * The trajectory reader throws `ENOENT` when an index entry points at a record
 * that was pruned, not yet published, or is being written by a live run. An
 * uncaught throw there surfaced as a bare 404 for
 * `level=complete&includeFullTrajectory=1` while the same session's other
 * combinations answered normally, and a reader that simply had no entry raised
 * a plain `Error`, i.e. a 500. Both are the same defect from the client's side:
 * one record it cannot show takes down a request that names nothing.
 *
 * This records the entry the way the package builder already records an
 * unreadable artifact version, CAS object or workspace file, and returns
 * `undefined` so the caller skips that entry. The resulting `details` stay
 * sparse, which both `trimTrajectory` and the importer tolerate: they look
 * details up by entry id rather than by position.
 */
export async function readTrajectoryDetail(
  view: { detail(id: string): Promise<TrajectoryDetail | undefined> },
  entry: { id: string },
  sessionId: string,
  omit: (message: string) => void,
  signal?: AbortSignal,
): Promise<TrajectoryDetail | undefined> {
  try {
    const detail = await view.detail(entry.id);
    if (!detail) throw new Error("trajectory detail is not available");
    return detail;
  } catch (error) {
    // A cancelled export is not an unreadable record: let the abort through so
    // the request ends as an abort rather than as a quietly thinner package.
    signal?.throwIfAborted();
    omit(`trajectory:${sessionId}:${entry.id}:${error instanceof Error ? error.message : "unreadable"}`);
    return undefined;
  }
}

/**
 * Drop the entries whose detail could not be read.
 *
 * The importer is the reason this exists: `validatePackageTrajectory` rejects a
 * package whose `details.length` differs from `entries.length`, so skipping a
 * detail while leaving its index entry produced a package that exported fine
 * and then failed to import as `Invalid research package trajectory` (#1083).
 * Filtering all three index lists keeps the two sides 1:1.
 */
export function filterTrajectoryIndex(index: TrajectoryIndex, retained: ReadonlySet<string>): TrajectoryIndex {
  const keep = (list: TrajectoryEntry[]): TrajectoryEntry[] => list.filter((entry) => retained.has(entry.id));
  return { ...index,
    entries: keep(index.entries),
    ...(index.untimedEntries ? { untimedEntries: keep(index.untimedEntries) } : {}),
    ...(index.historicalEntries ? { historicalEntries: keep(index.historicalEntries) } : {}) };
}
