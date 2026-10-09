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
 * The catalog classifies existing repository entry points; it does not define
 * a second test suite. Keep every environment fact explicit so a CI scheduler
 * can select work without inspecting implementation-specific runner syntax.
 */
export const tagDimensions = {
  arch: {
    description: "Native CPU architecture supported by the case",
    multiple: true,
    values: {
      amd64: "x86_64 / Node x64",
      arm64: "aarch64 or Apple Silicon / Node arm64",
    },
  },
  container: {
    description: "Generic .ci/Dockerfile execution support",
    values: {
      conditional: "Runs in Docker only when the documented host capability is available",
      supported: "Runs in the generic Docker environment",
      unsupported: "Requires a dedicated host or image",
    },
  },
  layer: {
    description: "Repository CI layer",
    values: {
      e2e: "Browser end-to-end",
      st: "Hermetic or explicitly real system/smoke",
      ut: "Unit/static/package checks",
    },
  },
  llm: {
    description: "LLM endpoint requirement",
    values: {
      none: "No LLM endpoint",
      real: "Live LLM API and credentials",
      stub: "Local deterministic model stub only",
      unreviewed: "Legacy coverage whose external behavior is not audited",
    },
  },
  network: {
    description: "Runtime network requirement after dependency installation",
    values: {
      external: "Outbound access to a live service",
      local: "Loopback services only",
      none: "No runtime network",
      unreviewed: "Legacy coverage whose egress is not audited",
    },
  },
  npu: {
    description: "Ascend NPU requirement",
    values: {
      none: "No NPU",
      required: "Ascend device, driver and runtime required",
      unreviewed: "Legacy coverage whose hardware dependency is not audited",
    },
  },
  sandbox: {
    description: "Execution sandbox requirement",
    values: {
      bubblewrap: "A working bubblewrap/user-namespace sandbox",
      seatbelt: "A native macOS Seatbelt sandbox",
      host: "Dedicated native host capability",
      none: "No execution sandbox",
      unreviewed: "Legacy coverage whose sandbox dependency is not audited",
    },
  },
};

/**
 * Run one slice of the one shared plan. Everything a layer executes is selected
 * from source tags by `test/support/tagged/profiles.mjs`; the catalog holds no
 * second list of cases for CI to run instead.
 */
const sharedSlice = (slice) => ["node", "test/support/tagged/shared.mjs", "run", "--slice", slice];

/**
 * What runs a command with JiuwenSwarm, the agent backend, and its adapter
 * (`scripts/with-jiuwenswarm.sh`). On this branch agent turns in the UT slice
 * run on a real JiuwenSwarm behind a real adapter: the wrapper installs and
 * starts one of each for the whole run, and the tests reach it through
 * `SCIENCE_AGENT_ADAPTER_URL`. It is part of the layer's definition, not of
 * the machine, so `pnpm ci:ut` means the same run on a laptop and in CI.
 */
export const jiuwenSwarmWrapper = ["bash", "scripts/with-jiuwenswarm.sh"];

const step = (command) => [command[0], command.slice(1)];

/**
 * The arguments a layer step runs with, given what the entry point was asked
 * for (`pnpm ci:ut -- --profile daily --coverage`). They belong to the shared
 * runner, which may sit behind a wrapper that only provides its environment;
 * its own arguments always end the step, so that is where these go. A step
 * that does not run the shared runner — the opt-in layers' install and build —
 * gets none, since a planner flag would break it.
 */
export function stepArguments([command, args], forwarded) {
  const full = [command, ...args];
  const plans = full.some((part, index) => part === "test/support/tagged/shared.mjs" && full[index - 1] === "node");
  return plans ? [...args, ...forwarded] : args;
}
const installStep = ["pnpm", ["install", "--frozen-lockfile"]];
const buildStep = ["pnpm", ["build"]];

/**
 * The ordered commands each layer entry point runs.
 *
 * The hermetic layers carry no install or build step: the shared runner
 * prepares exactly what its own slice needs (the workspace build, the four
 * service virtualenvs, the pinned Chromium) before it freezes a plan, so a
 * second preparation here would only be a chance for the two to disagree. The
 * opt-in live layers below still drive their own scripts and keep theirs.
 *
 * `e2e` is deliberately not here. `pnpm ci:e2e` calls the slice directly,
 * because `.ci/run-e2e.sh` already owns `<results>/e2e/run.log` and a layer
 * wrapper would be a second writer of that same file.
 */
export const layers = {
  st: [step(sharedSlice("st"))],
  "st-npu": [
    [process.env.SCIENCE_AGENT_NPU_PYTHON?.trim() || "python3", ["services/runner/workloads/npu-smoke-test.py"]],
  ],
  "st-real": [installStep, buildStep, ["bash", ["test/api/run_real_smoke.sh"]]],
  ut: [step([...jiuwenSwarmWrapper, ...sharedSlice("ut")])],
};

export const testCases = [
  {
    id: "ut.all",
    description: "The whole UT category: static checks, every workspace package's tests, the Python suites, and the sandbox tests that execute a real bubblewrap",
    command: ["pnpm", "ci:ut"],
    resultPath: "ut",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:ut",
      "llm:none", "network:local", "npu:none", "sandbox:bubblewrap",
    ],
  },
  {
    id: "st.agent-loop-mocked",
    description: "Node-native agent loop through a deterministic local model stub",
    command: ["pnpm", "ci:st"],
    resultPath: "st",
    tags: [
      "arch:amd64", "arch:arm64", "container:supported", "layer:st",
      "llm:stub", "network:local", "npu:none", "sandbox:none",
    ],
  },
  {
    id: "st.agent-loop-real",
    description: "Node-native agent loop against an explicitly authorized live model",
    command: ["pnpm", "ci:st:real"],
    gates: {
      allowEnv: "CI_ALLOW_REAL",
      requiredEnv: [
        "SCIENCE_AGENT_LLM_BASE_URL",
        "SCIENCE_AGENT_LLM_MODEL",
        "SCIENCE_AGENT_LLM_API_TOKEN",
      ],
    },
    resultPath: "st-real",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:st",
      "llm:real", "network:external", "npu:none", "sandbox:none",
    ],
  },
  {
    id: "e2e.mocked",
    description: "Deterministic Playwright journeys against an isolated local stack",
    command: ["pnpm", "ci:e2e"],
    resultPath: "e2e",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:e2e",
      "llm:stub", "network:local", "npu:none", "sandbox:bubblewrap",
    ],
  },
  {
    id: "e2e.real",
    description: "Opt-in Playwright real-user smoke against a live model",
    command: ["pnpm", "ci:e2e:real"],
    gates: {
      allowEnv: "CI_ALLOW_REAL",
      requiredEnv: ["E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN"],
    },
    resultPath: "e2e-real",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:e2e",
      "llm:real", "network:external", "npu:none", "sandbox:bubblewrap",
    ],
  },
  {
    id: "e2e.legacy",
    description: "Explicitly quarantined Playwright specs pending dependency audit",
    command: ["pnpm", "ci:e2e:legacy"],
    gates: { allowEnv: "CI_ALLOW_LEGACY", requiredEnv: [] },
    resultPath: "e2e-legacy",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:e2e",
      "llm:unreviewed", "network:unreviewed", "npu:unreviewed", "sandbox:unreviewed",
    ],
  },
  {
    id: "st.npu-smoke",
    description: "Ascend MindSpore runner workload smoke on dedicated NPU hardware",
    command: ["pnpm", "ci:st:npu"],
    gates: {
      allowEnv: "CI_ALLOW_NPU",
      requiredEnv: ["SCIENCE_AGENT_NPU_PYTHON"],
    },
    limitation: "The generic image has no Ascend device, driver, MindSpore runtime, or model assets",
    resultPath: "st-npu",
    tags: [
      "arch:amd64", "arch:arm64", "container:unsupported", "layer:st", "llm:none",
      "network:none", "npu:required", "sandbox:host",
    ],
  },
];
