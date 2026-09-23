// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Only called for the disposable real E2E stack, after health and before tasks.
const url = new URL('/api/quota-settings', process.env.E2E_API_URL);
const headers = { authorization: `Bearer ${process.env.E2E_API_TOKEN}`, 'content-type': 'application/json' };
const current = await fetch(url, { headers });
if (!current.ok) throw new Error(`Read quotas: HTTP ${current.status}`);
const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ ...await current.json(), maxConcurrentSubagents: 2 }) });
if (!saved.ok) throw new Error(`Save quotas: HTTP ${saved.status}`);
const checked = await fetch(url, { headers });
if (!checked.ok || (await checked.json()).maxConcurrentSubagents !== 2) throw new Error('Concurrency read-back failed');
console.log('Real E2E: maxConcurrentSubagents=2 verified');
