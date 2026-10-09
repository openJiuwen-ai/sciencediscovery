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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginCollection, endCollection, descriptors } from './node.mjs';
import { auditNodeSource } from './audit-node.mjs';

export async function collectNode(root, files) {
  beginCollection(root);
  for (const file of [...files].sort()) {
    const path = resolve(root, file);
    auditNodeSource(readFileSync(path, 'utf8'), file);
    const before = descriptors().length;
    await import(pathToFileURL(path).href);
    if (descriptors().length === before) throw new Error(`EMPTY_MODULE: ${file} registered no tests`);
  }
  endCollection();
  return descriptors();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  try {
    const request = JSON.parse(readFileSync(input, 'utf8'));
    const catalog = await collectNode(request.root, request.files);
    writeFileSync(output, JSON.stringify({ catalog }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
