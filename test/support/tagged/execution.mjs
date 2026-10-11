// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

// Execution settings are independent of the case selector. In particular a
// backend cannot filter out cases that it does not implement.
export function backendName(value = 'jiuwenswarm') {
  if (!['jiuwenswarm', 'legacy'].includes(value)) throw new Error(`Unknown E2E backend: ${value}; use jiuwenswarm or legacy (native)`);
  return value;
}

export function executionConfig(env = process.env, backend = env.CI_E2E_BACKEND ?? 'jiuwenswarm') {
  return {
    backend: backendName(backend),
    model: env.E2E_LLM_MODEL ?? null,
    judge: env.E2E_JUDGE_MODEL ?? null,
  };
}

// Keep short API scenarios in one serialized worker; long research cases each
// receive an isolated job. The source plan, never a workflow case list, owns
// this partition. Even a quarantined required case gets a worker and a verdict.
export function realShards(plan) {
  const basic = plan.entries.filter(e => e.tags.includes('tier:l3'));
  const research = plan.entries.filter(e => !e.tags.includes('tier:l3'));
  return [
    ...(basic.length ? [{ name: 'basic', keys: basic.map(e => e.key) }] : []),
    ...research.map((e, i) => ({ name: `research-${i + 1}`, keys: [e.key] })),
  ];
}
