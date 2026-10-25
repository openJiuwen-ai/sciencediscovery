// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateSuite, renderSuite } from './biomni-gate.mjs';

const [planPath, metricsPath, output] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath));
const policy = JSON.parse(readFileSync(new URL('./biomni-gate.json', import.meta.url)));
const baseline = policy.mode === 'compare' ? JSON.parse(readFileSync(policy.baseline)) : undefined;
const report = evaluateSuite(plan, JSON.parse(readFileSync(metricsPath)), policy, baseline);
writeFileSync(join(output, 'biomni-gate.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(output, 'biomni-gate.md'), renderSuite(report));
console.log(renderSuite(report));
process.exitCode = report.problems.length ? 1 : 0;
