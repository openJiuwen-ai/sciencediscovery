// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = () => randomBytes(24).toString("hex");

async function run(env) {
  const child = spawn(process.execPath, [".ci/run-desktop-e2e.mjs", "real"], { stdio: "inherit", env });
  const [code] = await once(child, "exit");
  return code ?? 1;
}

async function runIsolated() {
  const env = { ...process.env, E2E_MODEL_ID: "" };
  const modelVariables = ["E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN"];
  if (env.CI_ALLOW_REAL !== "1" || modelVariables.some(name => !env[name]?.trim())) {
    // Let the normal wrapper produce its BLOCKED summary without starting services.
    return run({ ...env, E2E_API_TOKEN: "", E2E_BASE_URL: "" });
  }

  const { createRunnerServer, loadRunnerConfig } = await import("../services/runner/dist/server.js");
  const { createApiServer, closeApiServer, loadServerConfig } = await import("../services/api/dist/server.js");
  const dataDir = await mkdtemp(join(tmpdir(), "desktop-real-"));
  const stop = [];
  const listen = async (server) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  };
  const startRunner = async (directory, runnerToken) => {
    const server = createRunnerServer(loadRunnerConfig({
      SCIENCE_AGENT_DATA_DIR: join(dataDir, directory),
      SCIENCE_AGENT_RUNNER_TOKEN: runnerToken,
      SCIENCE_AGENT_NPU_BROKER: "0",
      SCIENTIFIC_ENVS: "0",
    }));
    stop.push(() => new Promise(done => {
      server.close(done);
      server.closeAllConnections();
    }));
    return listen(server);
  };

  try {
    const apiToken = token();
    const localToken = token();
    const remoteToken = token();
    const localPort = await startRunner("api", localToken);
    const remotePort = await startRunner("remote", remoteToken);
    process.env.SCIENCE_AGENT_EXECUTOR = "native";
    const api = createApiServer(loadServerConfig({
      SCIENCE_AGENT_DATA_DIR: join(dataDir, "api"),
      SCIENCE_AGENT_AUTH_TOKEN: apiToken,
      SCIENCE_AGENT_RUNNER_URL: `http://127.0.0.1:${localPort}`,
      SCIENCE_AGENT_RUNNER_TOKEN: localToken,
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0",
      SCIENCE_AGENT_SAMPLE_SESSION: "0",
    }));
    stop.push(() => closeApiServer(api));
    const origin = `http://127.0.0.1:${await listen(api)}`;
    const request = async (path, method, body) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      return response.json();
    };
    const host = await request("/api/runners", "POST", {
      alias: "ci-desktop-remote",
      connectionKind: "direct",
      endpoint: { host: "127.0.0.1", port: remotePort, protocol: "http" },
      token: remoteToken,
    });
    await request(`/api/runners/${encodeURIComponent(host.id)}/connect`, "POST");
    const catalog = await request("/api/runners", "GET");
    const status = catalog.find(target => target.id === host.id)?.runnerStatus;
    if (status?.state !== "ready" || !status.resources) {
      throw new Error("The isolated remote Runner did not report resources");
    }
    return await run({ ...env, E2E_API_TOKEN: apiToken, E2E_BASE_URL: origin });
  } finally {
    try {
      for (const close of stop.reverse()) await close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

process.exitCode = await runIsolated();
