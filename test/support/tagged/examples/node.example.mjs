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

import assert from 'node:assert/strict';
import { createTest } from '../node.mjs';
import { normalizeTags, compileSelector } from '../tags.mjs';
const { test, describe } = createTest(import.meta.url, {
  tags: ['category:ut', 'os:linux', 'os:macos', 'os:windows', 'arch:amd64', 'arch:arm64'],
});

describe('tag vocabulary', () => {
  test('rejects misspelled model tags', () => {
    assert.throws(() => normalizeTags(['model:moke']), /Unknown tag/);
  });
  test('selects by a fixed conjunction', () => {
    assert.equal(compileSelector('category:ut and judge:none')(['category:ut']), true);
  });
});
