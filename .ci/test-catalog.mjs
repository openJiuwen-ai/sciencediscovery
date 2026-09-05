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
 *
 * UT is split into exactly two tiers and nothing else: `ut:host` runs on an
 * ordinary CI host, `ut:guest` needs a Linux guest kernel that grants the user
 * namespaces bubblewrap requires. `.ci/ci-contract.mjs` fails the build when a
 * UT case, workload, or workspace package escapes that partition.
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
  ut: {
    description: "UT execution tier; required on layer:ut cases and forbidden elsewhere",
    scope: "layer:ut",
    values: {
      guest: "Needs a Linux guest kernel that grants the user namespaces bubblewrap requires",
      host: "Runs on an ordinary CI host with no execution sandbox",
    },
  },
};

/**
 * The packages whose tests belong to the guest tier. Everything else in the
 * workspace is the host tier: the two commands below are generated from this
 * one list, so no package can land in both tiers or in neither.
 */
export const utGuestPackages = [
  {
    name: "@sciencediscovery/runner",
    directory: "services/runner",
    reason: "its tests execute a real bubblewrap sandbox and assert the remapped /workspace view",
  },
];

const guestPackageFilters = utGuestPackages.flatMap(({ name }) => ["--filter", name]);
const hostPackageFilters = utGuestPackages.flatMap(({ name }) => ["--filter", `!${name}`]);

/** Every UT workload, each carrying exactly one tier. */
export const utWorkloads = [
  { command: ["pnpm", "architecture:check"], id: "architecture", tier: "host" },
  { command: ["pnpm", "typecheck"], id: "typecheck", tier: "host" },
  { command: ["pnpm", "ci:selftest"], id: "ci-contract", tier: "host" },
  { command: ["pnpm", "binary:test"], id: "binary-scripts", tier: "host" },
  { command: ["pnpm", "--recursive", ...hostPackageFilters, "test"], id: "workspace-packages", tier: "host" },
  { command: ["pnpm", "paper:test"], id: "paper", tier: "host" },
  { command: ["pnpm", "gateway:test"], id: "gateway", tier: "host" },
  { command: ["pnpm", "memory-graph:test"], id: "memory-graph", tier: "host" },
  { command: ["pnpm", "evolve:test"], id: "evolve", tier: "host" },
  { command: ["pnpm", ...guestPackageFilters, "test"], id: "sandbox-packages", tier: "guest" },
];

const installStep = ["pnpm", ["install", "--frozen-lockfile"]];
// Both project virtualenvs are prerequisites, not test steps: the API package
// spawns services/paper/.venv/bin/python and the gateway interpreter, so the
// package tests fail with ENOENT unless these exist before they run.
const gatewaySyncStep = ["uv", ["sync", "--project", "services/gateway"]];
const paperSyncStep = ["uv", ["sync", "--project", "services/paper"]];
const buildStep = ["pnpm", ["build"]];
const workloadSteps = (tier) =>
  utWorkloads.filter((workload) => workload.tier === tier).map(({ command }) => [command[0], command.slice(1)]);

/**
 * The ordered commands each layer entry point runs. `ut` is exactly
 * `ut-host` followed by `ut-guest`, so the aggregate cannot drift from the sum
 * of the tiers. `ut-guest` deliberately has no install or build step: its host
 * hands it an installed, built workspace and it spends emulated CPU on tests
 * only.
 */
export const layers = {
  st: [installStep, buildStep, ["bash", ["test/api/run_m1_smoke.sh"]]],
  "st-npu": [
    [process.env.SCIENCE_AGENT_NPU_PYTHON?.trim() || "python3", ["services/runner/workloads/npu-smoke-test.py"]],
  ],
  "st-real": [installStep, buildStep, ["bash", ["test/api/run_real_smoke.sh"]]],
  ut: [installStep, gatewaySyncStep, paperSyncStep, buildStep, ...workloadSteps("host"), ...workloadSteps("guest")],
  "ut-guest": [...workloadSteps("guest")],
  "ut-host": [installStep, gatewaySyncStep, paperSyncStep, buildStep, ...workloadSteps("host")],
};

export const testCases = [
  {
    id: "ut.host",
    description: "The UT tier that needs no execution sandbox: static checks, Node package tests outside the sandbox packages, and the Python suites",
    command: ["pnpm", "ci:ut:host"],
    resultPath: "ut-host",
    tags: [
      "arch:amd64", "arch:arm64", "container:supported", "layer:ut",
      "llm:none", "network:none", "npu:none", "sandbox:none", "ut:host",
    ],
  },
  {
    id: "ut.guest",
    description: "The UT tier that needs a real bubblewrap sandbox; its host installs and builds the workspace and the guest runs only the tests",
    command: ["pnpm", "ci:ut:guest"],
    resultPath: "ut-guest",
    tags: [
      "arch:amd64", "arch:arm64", "container:conditional", "layer:ut",
      "llm:none", "network:none", "npu:none", "sandbox:bubblewrap", "ut:guest",
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
