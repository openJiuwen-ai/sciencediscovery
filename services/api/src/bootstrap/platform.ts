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

import { resolve } from "node:path";

import { McpSourceCatalog, type McpTransportClient } from "@sciencediscovery/data-source";
import { RemoteComputeClient } from "@sciencediscovery/executor";
import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { CustomMcpServers } from "../mcp/custom-servers.js";
import { shortErrorMessage } from "@sciencediscovery/operational-logging";
import { reviewerLog } from "@sciencediscovery/provenance";
import type {
  EvolveGoal, EvolveRunProposal, ModelsDevPayload, ResolvedProxy,
} from "@sciencediscovery/schema";

import { apiLog, configureApiLogging } from "../logging.js";
import { MemoryGraphClient, MemoryGraphSink, mgLog } from "@sciencediscovery/memory";
import { GovernedDownloadManager } from "@sciencediscovery/artifact-manager";
import { McpGovernanceBroker } from "@sciencediscovery/data-source";
import { McpNodeClient } from "../mcp/node-client.js";
import { PaperService } from "../papers.js";
import { PermissionDecisionQueue } from "@sciencediscovery/governance";
import { ProvenanceRecorder } from "@sciencediscovery/provenance";
import { RunnerClient } from "@sciencediscovery/executor";
import { CasStore, VersionStore } from "@sciencediscovery/cas";
import { storeEvolutionInput } from "../evolution/workspace-input.js";
import { CandidateSources } from "../evolution/candidates.js";
import { RunTokenRegistry } from "../evolution/llm-proxy.js";
import { EvolveOrchestrator } from "../evolution/orchestrator.js";
import { EvolveSidecarClient } from "../evolution/sidecar.js";
import { EvolutionStore } from "../evolution/store.js";
import { startProposedRun, summariseRun } from "../evolution/proposal.js";
import type { EvolveRuntimeFactory } from "../runs/index.js";
import { recoverSessionRuns, scheduleSessionRuns } from "../runs/index.js";
import type { SkillLibraryCatalog } from "../skill-library-catalog.js";
import { SkillCatalog } from "@sciencediscovery/specialist";
import { SessionStore } from "../store.js";
import { NativeWebProviderClient, WebBroker } from "@sciencediscovery/data-source";
import type { ServerConfig } from "./config.js";

export interface ApiServerDependencies {
  connectorFetch?: typeof fetch;
  /** Test seam: resolve the model catalog from a fixture instead of models.dev. */
  fetchModelCatalog?: (options: { proxy?: ResolvedProxy; url: string }) => Promise<ModelsDevPayload>;
  /** Test seam: drive MCP through a stub transport instead of live servers. */
  mcpTransport?: McpTransportClient;
  /** Test seam: exercise remote-host HTTP flows without connecting to a real SSH machine. */
  remoteCompute?: RemoteComputeClient;
}

/**
 * What a run's result artifact is called: `evolve/<run>/<entrypoint>`.
 *
 * Scoped by run, after the unscoped version was measured doing the wrong
 * thing. An earlier revision used the bare entrypoint on the reasoning that
 * two runs over the same file are the same logical artifact — but for a
 * scripted search the entrypoint is always the literal `candidate.py`, so a
 * compression run, a peak-detection run and an enzyme-kinetics run in one
 * project piled into a single artifact ten versions deep, interleaved with
 * versions the sessions' own agents had declared under that name. Version 10
 * being a Michaelis-Menten fitter "derived from" version 8's peak detector is
 * lineage said backwards.
 *
 * One run, one artifact, exactly two versions: v1 the seed, v2 the winner.
 */
export function evolveArtifactName(run: { goal: EvolveGoal; id: string }): string {
  const target = run.goal.target;
  const raw = target.kind === "program"
    ? target.entrypoint
    : target.kind === "text"
      ? "evolved.md"
      : "";
  const cleaned = raw.trim().replace(/^\/+/, "");
  const leaf = !cleaned || cleaned.includes("..") || cleaned.includes("\0")
    ? "result.txt"
    : cleaned;
  return `evolve/${run.id.slice(0, 8)}/${leaf}`;
}


/**
 * The API composition root. It selects concrete adapters and wires domain
 * components, while the HTTP layer is limited to protocol translation.
 */
export function createPlatformServices(
  config: ServerConfig,
  repositoryRoot: string,
  dependencies: ApiServerDependencies = {},
) {
  configureApiLogging(config.dataDir);
  const store = new SessionStore(config.dataDir, {
    gatewayIdleTimeoutMs: config.gatewayIdleTimeoutMs,
    gatewayTurnTimeoutMs: config.gatewayTurnTimeoutMs,
    kernelIdleTimeoutMs: config.kernelIdleTimeoutMs,
    permissionWaitTimeoutMs: config.permissionWaitTimeoutMs,
    runnerExecTimeoutMs: config.runnerExecTimeoutMs,
  }, {
    runnerMaxOutputBytes: config.runnerMaxOutputBytes,
    runnerMaxWorkspaceBytes: config.runnerMaxWorkspaceBytes,
    uploadMaxFileBytes: config.workspaceUpload.maxFileBytes,
    uploadMaxRequestBytes: config.workspaceUpload.maxRequestBytes,
  }, config.memoryGraph.neo4jPassword);
  const skillCatalog = new SkillCatalog(config.dataDir, repositoryRoot);
  const runnerClient = new RunnerClient(config.runnerUrl, config.runnerToken);

  mgLog.setDataDir(config.dataDir);
  reviewerLog.setLogDir(resolve(config.dataDir, "logs"));
  mgLog.setToggle(() => store.getMemoryGraphSettings().enabled);

  const memoryGraphClient = new MemoryGraphClient({
    url: config.memoryGraph.url,
    token: config.memoryGraph.internalToken,
  });
  const memoryGraphSink = new MemoryGraphSink(memoryGraphClient, () => store.getMemoryGraphSettings().enabled);
  const memoryGraphEnabled = () => store.getMemoryGraphSettings().enabled;
  const provenanceRecorder = new ProvenanceRecorder(config.dataDir, store, memoryGraphSink);
  const mcpRegistry = createBuiltinMcpSourceRegistry();
  const customMcpServers = new CustomMcpServers(config.dataDir, mcpRegistry, (ids) => store.setCustomConnectorIds(ids), () => mcpCatalog.refresh(), (id) => store.removeCustomConnectorReferences(id));
  const mcpGateway: McpTransportClient = dependencies.mcpTransport ?? new McpNodeClient(() => customMcpServers.transportConfig(), customMcpServers.oauth);
  const mcpProxyMap = (): Record<string, ResolvedProxy> => {
    const serverIds = new Set<string>();
    for (const manifest of mcpRegistry.listManifests()) serverIds.add(manifest.transport.mcpServerId);
    for (const serverId of Object.keys(store.getMcpProxyPolicies())) serverIds.add(serverId);
    const map: Record<string, ResolvedProxy> = {};
    for (const serverId of serverIds) {
      try {
        map[serverId] = store.resolveProxy(store.mcpProxyPolicy(serverId));
      } catch {
        // Resolution errors are surfaced on invoke instead of blocking startup.
      }
    }
    return map;
  };
  const mcpCatalog = new McpSourceCatalog(mcpRegistry, mcpGateway, mcpProxyMap, (catalog) => customMcpServers.applyCatalog(catalog));
  const webBroker = new WebBroker(config.dataDir, store, new NativeWebProviderClient());
  const mcpBroker = new McpGovernanceBroker(
    config.dataDir,
    store,
    mcpRegistry,
    mcpCatalog,
    mcpGateway,
    { memoryGraphSink },
  );
  const paperService = new PaperService(store, config.paperPythonPath, config.paperWorkerPath);
  const artifactManager = new GovernedDownloadManager(
    store,
    mcpRegistry,
    mcpBroker,
    // No `?? fetch` fallback: the manager's own default is the proxy-capable
    // fetch, and the global one silently breaks every proxied download.
    dependencies.connectorFetch,
  );
  artifactManager.setCompletedHandler(async ({ candidate, job, plan }) => {
    const location = store.workspaceLocation(job.sessionId, plan.destination.path);
    await provenanceRecorder.registerWorkspaceArtifact({
      logicalName: candidate.logicalName,
      origin: "mcp_download",
      originMeta: {
        artifactJobId: job.id,
        license: candidate.license,
        sourceId: candidate.sourceId,
        sourceRecordId: candidate.sourceRecordId,
        sourceUrl: candidate.sourceUrl,
      },
      path: location.path,
      sessionId: job.sessionId,
      sourcePath: plan.destination.path,
      title: candidate.logicalName,
      workspaceRoot: location.root,
    });
  });

  // The evolve store/orchestrator are constructed unconditionally and cost
  // nothing until a run is created: no connection is opened, no directory is
  // touched until `initialize()`.
  const evolutionStore = new EvolutionStore(config.dataDir);
  // Run-scoped model tokens. In memory only: a token that outlived the process
  // would outlive the run it belongs to, and that is the property it exists for.
  const evolveRunTokens = new RunTokenRegistry();
  const evolveCas = new CasStore(config.dataDir);
  const evolveCandidates = new CandidateSources(
    config.dataDir, process.env.SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR?.trim() || undefined,
  );
  const evolveOrchestrator = new EvolveOrchestrator(
    evolutionStore,
    new EvolveSidecarClient({ internalToken: config.evolve.internalToken, url: config.evolve.url }),
    memoryGraphSink,
    undefined,
    evolveRunTokens,
    // The sidecar reaches the model proxy at this origin. `0.0.0.0` is a bind
    // address, not somewhere to connect to, so it is dialled back to loopback —
    // the sidecar is loopback-only anyway.
    {
      apiOrigin: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
      cas: evolveCas,
      workspacePath: (sessionId: string) => store.workspacePath(sessionId),
      workspaceVersions: new VersionStore(store.dataDir),
      // Wired here because this is the only scope holding both the evolve
      // subsystem's stores and the session store that owns artifacts.
      publishResult: async ({ run, winnerCodeHash }) => {
        const winner = await evolveCandidates.read(run.id, winnerCodeHash);
        if (winner === undefined) return;
        const name = evolveArtifactName(run);
        const kind = name.endsWith(".md") || name.endsWith(".txt") ? "markdown" : "other";
        // The seed first, so it is version 1 and the winner is version 2: a
        // result is only meaningful next to what it improved on, and the
        // version numbers are the cheapest way to say which came first.
        const seed = await store.createArtifactVersion({
          // Read then put: the seed is already in the store, and `put` is how
          // a hash becomes the {hash, size} reference a version needs. Content
          // addressing makes the write a no-op.
          content: await evolveCas.put(
            await evolveCas.read(run.goal.baselineProgramCas.replace(/^sha256:/, "")),
          ),
          description: `Evolution starting point: ${run.goal.statement}`.slice(0, 500),
          executionRunIds: [run.id],
          kind,
          logicalName: name,
          mediaType: "text/plain; charset=utf-8",
          origin: "llm_declared",
          originMeta: { evolveRunId: run.id, role: "seed" },
          sessionId: run.sessionId,
        });
        const winnerVersion = await store.createArtifactVersion({
          content: await evolveCas.put(Buffer.from(winner, "utf-8")),
          description: `Evolution result: ${run.goal.statement}`.slice(0, 500),
          executionRunIds: [run.id],
          // The lineage the version numbers only imply: this came from that.
          inputArtifactVersionIds: [seed.version.id],
          kind,
          logicalName: name,
          mediaType: "text/plain; charset=utf-8",
          origin: "llm_declared",
          originMeta: { evolveRunId: run.id, role: "winner" },
          sessionId: run.sessionId,
        });
        provenanceRecorder.notifyArtifactRegistered({
          mediaType: "text/plain; charset=utf-8",
          sessionId: run.sessionId,
          version: seed.version,
        });
        provenanceRecorder.notifyArtifactRegistered({
          mediaType: "text/plain; charset=utf-8",
          sessionId: run.sessionId,
          version: winnerVersion.version,
        });
        // Mirror both versions onto the graph's evolve SubTask. Without this
        // the run's node carried a `searches` edge and nothing else — the one
        // thing the search existed to produce was in SessionStore but invisible
        // to trace_provenance, so the winner looked unrooted the moment anyone
        // asked where it came from.
        memoryGraphSink.linkSearchArtifacts({
          artifacts: [
            {
              artifactId: seed.artifact.id,
              logicalName: name,
              mediaType: "text/plain; charset=utf-8",
              role: "seed",
              version: seed.version.version,
            },
            {
              artifactId: winnerVersion.artifact.id,
              logicalName: name,
              mediaType: "text/plain; charset=utf-8",
              role: "winner",
              version: winnerVersion.version.version,
            },
          ],
          searchId: run.id,
          sessionId: run.sessionId,
        });
      },
    },
  );

  const casHasEvolve = async (hash: string) => {
    try {
      await evolveCas.read(hash);
      return true;
    } catch {
      return false;
    }
  };
  const storeEvolveInput = (sessionId: string) =>
    (input: { content?: string; path?: string }) => storeEvolutionInput(
      new VersionStore(store.dataDir), store.workspacePath(sessionId), input,
    );

  /**
   * The `/evolve` capability, registered once.
   *
   * The run loop calls this per turn and spreads whatever comes back into the
   * agent's options; it never sees `EvolutionStore`, the orchestrator, or the
   * proposal validator. A composition root that has no evolve sidecar returns
   * `undefined` here and the tools simply do not exist — this one always has
   * one, so it always returns a runtime.
   *
   * The main loop designs the run; this only turns the design into one. Every
   * gate the wizard used to sit in front of still runs on this side — the
   * probe, pre-flight, the frozen scoring — because the agent is the designer
   * and never the authority on whether its own scoring can rank.
   */
  const evolveRuntimeFactory: EvolveRuntimeFactory = (turn) => ({
    approvalMode: turn.approvalMode,
    createEvolveRun: async (input: EvolveRunProposal) => {
      store.assertSessionWritable(turn.sessionId);
      // The probe runs real evaluations in the sandbox — two or three, each
      // with the candidate timeout as its ceiling. That is minutes, and the
      // agent's idle clock is four: without pausing it the turn dies with "no
      // gateway progress" while the probe is doing exactly what it was asked
      // to do, and the design work of the whole turn is lost. Same treatment a
      // permission prompt gets, for the same reason — the wait is real work.
      const releaseWait = turn.beginExternalWait?.();
      try {
        const result = await startProposedRun(input, {
          casHas: casHasEvolve,
          model: (id: string) => store.getModel(id),
          modelId: turn.modelId,
          orchestrator: evolveOrchestrator,
          sessionId: turn.sessionId,
          store: storeEvolveInput(turn.sessionId),
        });
        if (result.run) await turn.emit({ run: result.run, type: "evolve_run.created" });
        return result;
      } finally {
        releaseWait?.();
      }
    },
    getEvolveRun: async (runId?: string) => {
      // The id is optional and prefix-tolerant, because the caller is a model
      // whose context routinely does not contain it: a search started in an
      // earlier turn, a compaction in between. Watched live: one call with an
      // invented number, one with the memory-graph's `subtask:evolve:` handle
      // — a legitimate id it had just read off the graph.
      const wanted = runId?.trim().replace(/^subtask:evolve:/, "");
      const runs = await evolutionStore.listRuns(turn.sessionId);
      const run = wanted
        ? await evolutionStore.readRun(wanted)
        : runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (!run) {
        // The reader is a model deciding what to call next; a bare "not found"
        // leaves it guessing again. The real ids are right here.
        const known = runs.slice(0, 8)
          .map((item) => `${item.id}（${item.status}）`).join("、");
        throw new Error(wanted
          ? `no such search: ${wanted}. ${
            known ? `The searches in this session: ${known}` : "This session has no searches yet."}`
          : "this session has no searches yet.");
      }
      return summariseRun(run, await evolutionStore.readEvents(run.id));
    },
  });

  return {
    artifactManager,
    customMcpServers,
    evolutionStore,
    evolveCandidates,
    evolveOrchestrator,
    evolveRunTokens,
    evolveRuntimeFactory,
    mcpBroker,
    mcpCatalog,
    mcpGateway,
    mcpRegistry,
    memoryGraphClient,
    memoryGraphEnabled,
    memoryGraphSink,
    paperService,
    permissionDecisions: new PermissionDecisionQueue(),
    provenanceRecorder,
    // Credentials and trusted host keys live in the store, so the compute
    // client asks for them per machine instead of inheriting an ambient SSH
    // agent or the user's known_hosts.
    remoteCompute: dependencies.remoteCompute ?? new RemoteComputeClient(
      config.sshConfigPath,
      async (hostId) => store.remoteHostSshAccess(hostId),
    ),
    runnerClient,
    skillCatalog,
    store,
    webBroker,
  };
}

export type PlatformServices = ReturnType<typeof createPlatformServices>;

/** Restore durable work and make the composed platform ready for requests. */
export async function initializePlatformServices(
  services: PlatformServices,
  config: ServerConfig,
  skillLibraryCatalog: SkillLibraryCatalog,
): Promise<void> {
  const {
    artifactManager,
    evolutionStore,
    evolveOrchestrator,
    evolveRuntimeFactory,
    mcpBroker,
    mcpCatalog,
    mcpRegistry,
    memoryGraphClient,
    memoryGraphSink,
    paperService,
    provenanceRecorder,
    remoteCompute,
    runnerClient,
    skillCatalog,
    store,
    webBroker,
  } = services;
  await skillCatalog.load();
  store.setAvailableSkillIds(skillCatalog.ids());
  await services.customMcpServers.load();
  await store.load();
  await mcpCatalog.refresh().catch((error) => {
    apiLog.warn("mcp_catalog_startup_failed", { errorMessage: shortErrorMessage(error) });
    console.warn("MCP catalog was unavailable during API startup:", error);
  });
  await artifactManager.resumeInterrupted();
  await recoverSessionRuns(store, memoryGraphClient);
  // A run left "running" by a previous process is never going to finish: the
  // sidecar's stream died with that connection. Settle them at boot so the UI
  // never shows a spinner for a run nobody is driving.
  void evolutionStore.initialize()
    .then(() => evolveOrchestrator.adoptOrphanedRuns())
    .catch((error: unknown) => {
      apiLog.warn("evolve_boot_failed", { reason: error instanceof Error ? error.message : String(error) });
    });

  const storedNeo4jPassword = store.getMemoryGraphNeo4jPassword();
  if (storedNeo4jPassword) {
    mgLog.info("startup: pushing stored Neo4j credential to memory-graph");
    const connection = store.getMemoryGraphSettings();
    await memoryGraphClient
      .pushNeo4jPassword(storedNeo4jPassword, { httpUri: connection.neo4jHttp, user: connection.neo4jUser })
      .then(() => mgLog.info("startup: credential push complete"))
      .catch((error) => {
        mgLog.warn(
          "startup: credential push failed (non-fatal): %s",
          error instanceof Error ? error.message : String(error),
        );
      });
  } else {
    mgLog.info("startup: no stored Neo4j password, skipping push (set it in System Settings → Memory graph)");
  }

  for (const project of store.listProjects()) {
    for (const session of store.listSessions(project.id, "all")) {
      if (!(await store.listSessionRuns(session.id)).some((run) => run.status === "queued")) continue;
      scheduleSessionRuns(
        store,
        runnerClient,
        provenanceRecorder,
        mcpBroker,
        webBroker,
        mcpRegistry,
        mcpCatalog,
        artifactManager,
        paperService,
        remoteCompute,
        skillCatalog,
        skillLibraryCatalog,
        memoryGraphSink,
        session.id,
        config,
        memoryGraphClient,
        evolveRuntimeFactory,
      );
    }
  }
}
