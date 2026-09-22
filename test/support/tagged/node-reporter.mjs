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

// A native node:test reporter. stdout is never parsed as a success signal.
export default async function* reporter(source) {
  for await (const event of source) {
    if (['test:pass', 'test:fail'].includes(event.type)) {
      const d = event.data;
      yield `${JSON.stringify({ type: event.type, name: d.name, skip: Boolean(d.skip),
        todo: Boolean(d.todo), kind: d.details?.type, message: d.details?.error?.message ?? null })}\n`;
    }
    if (event.type === 'test:diagnostic' && event.data.message?.startsWith('LLM_EVIDENCE ')) {
      yield `${JSON.stringify({ type: 'evidence', content: event.data.message.slice(13) })}\n`;
    }
  }
}
