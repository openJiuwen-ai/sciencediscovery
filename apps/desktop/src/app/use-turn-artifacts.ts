// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { listSubagents } from "../api/sessions.js";
import type { SessionArtifactOutput, SessionRun, Subagent } from "../api/types.js";
import { allSubagents, type RunStreamState } from "../run-stream/model.js";
import type { RunReplay } from "../run-stream/replay.js";
import { ownerRunId, turnArtifactsByRun, turnLineage, TURN_ARTIFACT_LIMIT } from "./turn-artifacts.js";

interface Catalog {
  client: ApiClient;
  sessionId: string;
  origins: string;
  subagents: Subagent[];
}

/** AR-1/2: recover lineage without a second artifact selection algorithm. */
export function useTurnArtifacts(
  client: ApiClient,
  sessionId: string | undefined,
  outputs: readonly SessionArtifactOutput[],
  terminalRuns: readonly SessionRun[],
  replays: readonly RunReplay[],
  run: RunStreamState,
) {
  const [catalog, setCatalog] = useState<Catalog>();
  const sessionOutputs = useMemo(
    () => outputs.filter(output => sessionId !== undefined && output.version.sessionId === sessionId),
    [outputs, sessionId],
  );
  const snapshot = useMemo(() => {
    const runIds = [
      ...terminalRuns.filter(row => row.sessionId === sessionId).map(row => row.id),
      ...replays.map(replay => replay.runId),
      ...(run.runId ? [run.runId] : []),
    ];
    const children = [...allSubagents(run), ...replays.flatMap(replay => allSubagents(replay.state))];
    return { runIds, children, lineage: turnLineage(runIds, children) };
  }, [terminalRuns, sessionId, replays, run]);
  const origins = useMemo(() => JSON.stringify([...new Set(sessionOutputs
    .filter(output => output.version.turnId && ownerRunId(output.version, snapshot.lineage) === undefined)
    .map(output => output.version.turnId))].sort()), [sessionOutputs, snapshot]);
  const matchingCatalog = catalog?.client === client && catalog.sessionId === sessionId && catalog.origins === origins
    ? catalog : undefined;

  useEffect(() => {
    if (!sessionId || origins === "[]" || matchingCatalog) return;
    let current = true;
    void listSubagents(client, sessionId).then(subagents => {
      if (current) setCatalog({ client, sessionId, origins, subagents });
    }).catch(() => {
      // No failed-result cache: the next outputs refresh retries even if the
      // only change is another version from the same unresolved child.
    });
    return () => { current = false; };
  }, [client, sessionId, origins, matchingCatalog, sessionOutputs]);

  return useMemo(() => turnArtifactsByRun(sessionOutputs,
    turnLineage(snapshot.runIds, [...(matchingCatalog?.subagents ?? []), ...snapshot.children]),
    TURN_ARTIFACT_LIMIT, true), [sessionOutputs, snapshot, matchingCatalog]);
}
