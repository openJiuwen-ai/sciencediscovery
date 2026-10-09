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

// Checks that are a command rather than a framework test still get exactly one
// planned identity each, so they are selected, executed and counted like any
// other case instead of living in a separate list of CI steps.
const host = ['category:ut', 'os:linux', 'arch:amd64'];
export const checks = [
  { id: 'check:research-python-ut', command: ['bash', '.ci/run-research-python.sh', 'unit'], tags: host },
  { id: 'check:swarm-sdk-contract', command: ['bash', '.ci/run-research-python.sh', 'contract'], tags: ['category:st', 'os:linux', 'arch:amd64'] },
  { id: 'check:architecture', command: ['node', 'scripts/check-architecture.mjs'], tags: host },
  { id: 'check:typecheck', command: ['pnpm', 'typecheck'], tags: host },
  // Markdown lint and every relative link in the documentation.
  { id: 'check:docs', command: ['pnpm', 'docs:check'], tags: host },
  // The harness decides what every other case is, so its own regression suite
  // is planned with them rather than trusted.
  { id: 'check:tagged-selftest', command: ['node', 'test/support/tagged/selftest.mjs'], tags: host },
];
