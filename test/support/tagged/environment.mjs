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

import { validatePlan } from './plan.mjs';

export const hostPlatform = platform => ({ linux: 'linux', darwin: 'macos', win32: 'windows' })[platform] ?? platform;
export const hostArch = arch => ({ x64: 'amd64', arm64: 'arm64' })[arch] ?? arch;

/** Only this post-plan layer may inspect environment. Missing data fails closed. */
export async function preflight(plan, {
  platform = process.platform, arch = process.arch, env = process.env, probes = {},
} = {}) {
  validatePlan(plan);
  const problems = [];
  const checked = new Map();
  const actualHost = { os: hostPlatform(platform), arch: hostArch(arch) };
  const needEnv = (entry, names) => {
    for (const name of names) if (typeof env[name] !== 'string' || !env[name].trim()) {
      problems.push({ key: entry.key, code: 'MISSING_ENVIRONMENT', requirement: name });
    }
  };
  const check = async (entry, name) => {
    if (!checked.has(name)) {
      try {
        const answer = probes[name] ? await probes[name]() : false;
        checked.set(name, answer === true ? null : `${name} capability was not verified`);
      } catch { checked.set(name, `${name} capability check failed`); }
    }
    if (checked.get(name)) problems.push({ key: entry.key, code: 'UNVERIFIED_CAPABILITY', requirement: name });
  };
  for (const entry of plan.entries) {
    if (entry.target.os !== actualHost.os || entry.target.arch !== actualHost.arch) {
      problems.push({ key: entry.key, code: 'HOST_MISMATCH', required: entry.target, actual: actualHost });
    }
    if (entry.tags.includes('npu:required')) await check(entry, 'npu');
    if (entry.tags.includes('model:real')) {
      needEnv(entry, ['E2E_LLM_BASE_URL', 'E2E_LLM_MODEL', 'E2E_LLM_TOKEN']);
      if (env.CI_ALLOW_REAL !== '1') problems.push({ key: entry.key, code: 'OPT_IN_REQUIRED', requirement: 'CI_ALLOW_REAL=1' });
    }
    if (entry.tags.includes('judge:llm')) {
      needEnv(entry, ['E2E_JUDGE_BASE_URL', 'E2E_JUDGE_MODEL', 'E2E_JUDGE_TOKEN']);
      if (env.CI_ALLOW_REAL !== '1') problems.push({ key: entry.key, code: 'OPT_IN_REQUIRED', requirement: 'CI_ALLOW_REAL=1' });
    }
  }
  return { ok: !problems.length, planDigest: plan.digest, actualHost, problems };
}
