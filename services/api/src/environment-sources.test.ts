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

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_SOURCE_SETTINGS,
  ENVIRONMENT_CONDA_SOURCE_PRESETS,
  ENVIRONMENT_PACKAGE_SOURCE_PRESETS,
  ENVIRONMENT_PIP_SOURCE_PRESETS,
} from "@science-agent/schema";

import {
  normalizeEnvironmentSourceSettings,
  resolveEnvironmentInstallRequest,
} from "./environment-sources.js";

test("environment source settings preserve upstream compatibility and validate presets", () => {
  assert.deepEqual(
    ENVIRONMENT_PACKAGE_SOURCE_PRESETS.find((preset) => preset.id === "huawei"),
    {
      condaChannels: [],
      id: "huawei",
      label: "Huawei Cloud",
      pipIndexUrl: "https://mirrors.huaweicloud.com/repository/pypi/simple",
    },
  );
  assert.deepEqual(
    ENVIRONMENT_PIP_SOURCE_PRESETS.map((preset) => preset.id),
    ["upstream", "tsinghua", "ustc", "huawei"],
  );
  assert.deepEqual(
    ENVIRONMENT_CONDA_SOURCE_PRESETS.map((preset) => preset.id),
    ["upstream", "tsinghua", "ustc"],
  );
  assert.deepEqual(
    normalizeEnvironmentSourceSettings(undefined, false),
    DEFAULT_ENVIRONMENT_SOURCE_SETTINGS,
  );
  assert.deepEqual(normalizeEnvironmentSourceSettings({
    condaSource: "tsinghua",
    pipSource: "huawei",
  }), {
    condaSource: "tsinghua",
    pipSource: "huawei",
  });
  assert.deepEqual(normalizeEnvironmentSourceSettings({
    condaSource: "huawei",
    pipSource: "huawei",
  }, false), {
    condaSource: "upstream",
    pipSource: "huawei",
  });
  assert.deepEqual(normalizeEnvironmentSourceSettings({
    condaSource: "removed-mirror",
    pipSource: "removed-mirror",
  }, false), DEFAULT_ENVIRONMENT_SOURCE_SETTINGS);
  assert.throws(
    () => normalizeEnvironmentSourceSettings({ pipSource: "unknown" }),
    /known package source/,
  );
  assert.throws(
    () => normalizeEnvironmentSourceSettings({ condaSource: "huawei" }),
    /known package source/,
  );
  assert.throws(
    () => normalizeEnvironmentSourceSettings({ pipSource: "upstream", extra: true }),
    /Unknown environment source setting/,
  );
});

test("install source resolution applies global mirrors and one-time pip override", () => {
  const settings = { condaSource: "tsinghua", pipSource: "huawei" } as const;
  assert.deepEqual(resolveEnvironmentInstallRequest({
    packages: ["numpy=2.0", "pandas=2.2"],
  }, settings), {
    channels: ["https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"],
    manager: "conda",
    packages: ["numpy=2.0", "pandas=2.2"],
  });
  assert.deepEqual(resolveEnvironmentInstallRequest({
    manager: "pip",
    packages: ["torch", "torchvision"],
  }, settings), {
    indexUrl: "https://mirrors.huaweicloud.com/repository/pypi/simple",
    manager: "pip",
    packages: ["torch", "torchvision"],
  });
  assert.deepEqual(resolveEnvironmentInstallRequest({
    indexUrl: "https://download.pytorch.org/whl/cpu/",
    manager: "pip",
    packages: ["torch", "torchvision"],
  }, settings, "/workspace/session"), {
    indexUrl: "https://download.pytorch.org/whl/cpu",
    manager: "pip",
    packages: ["torch", "torchvision"],
    workspaceRoot: "/workspace/session",
  });
  assert.deepEqual(resolveEnvironmentInstallRequest({
    channels: ["conda-forge"],
    packages: ["numpy"],
  }, settings), {
    channels: ["conda-forge"],
    manager: "conda",
    packages: ["numpy"],
  });
});

test("install source resolution rejects cross-manager and injectable source inputs", () => {
  const settings = DEFAULT_ENVIRONMENT_SOURCE_SETTINGS;
  assert.throws(
    () => resolveEnvironmentInstallRequest({
      indexUrl: "https://pypi.org/simple",
      manager: "conda",
      packages: ["numpy"],
    }, settings),
    /only be used with manager=pip/,
  );
  assert.throws(
    () => resolveEnvironmentInstallRequest({
      channels: ["conda-forge"],
      manager: "pip",
      packages: ["numpy"],
    }, settings),
    /only be used with manager=conda/,
  );
  for (const indexUrl of [
    "http://mirror.example/simple",
    "https://user:secret@mirror.example/simple",
    "https://mirror.example/simple?option=1",
    "https://mirror.example/simple#fragment",
    "https://mirror.example/simple --trusted-host attacker",
    "--index-url=https://attacker.example/simple",
  ]) {
    assert.throws(
      () => resolveEnvironmentInstallRequest({
        indexUrl,
        manager: "pip",
        packages: ["numpy"],
      }, settings),
      /pip indexUrl/,
    );
  }
});
