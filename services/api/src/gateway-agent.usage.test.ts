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

import { parseGatewayUsage } from "./gateway-agent.js";

test("USG-010 gateway usage parser keeps cache fields and rejects incomplete totals", () => {
  const reported = parseGatewayUsage({
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      cache_read_tokens: 3,
      cache_write_tokens: 1,
    },
    usage_reported: true,
  });
  assert.equal(reported.usageReported, true);
  assert.deepEqual(reported.usage, {
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
  });

  const missing = parseGatewayUsage({
    usage: { input_tokens: 12 },
    usage_reported: true,
  });
  assert.equal(missing.usageReported, false);
  assert.equal(missing.usage, undefined);
});
