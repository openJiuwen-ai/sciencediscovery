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

import type * as native from 'node:test';
type Options = native.TestOptions & { tags?: string[]; id?: string };
interface Declaration {
  (name: string, fn: (context: native.TestContext) => void | Promise<void>): void;
  (name: string, options: Options, fn: (context: native.TestContext) => void | Promise<void>): void;
}
export function createTest(file: string, options: { tags: string[] }): Omit<typeof native, 'test' | 'it' | 'describe'> & {
  test: Declaration & Pick<typeof native, 'before' | 'after' | 'beforeEach' | 'afterEach'>; it: Declaration; describe: Declaration;
};
