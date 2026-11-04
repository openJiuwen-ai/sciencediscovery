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

import { compactTokenCount } from "../src/ProviderModelFields.js";
import { formatCompactTokenValue } from "../src/usageFormat.js";

test("USG-020 the usage page and the model badge agree from one million up", () => {
  // A declared 10.5M context window: the badge used to round whole millions
  // from 10M ("11M") while the usage page kept one decimal ("10.5M").
  assert.equal(compactTokenCount(10_500_000), formatCompactTokenValue(10_500_000));
  assert.equal(formatCompactTokenValue(10_500_000), "10.5M");

  // Neighbour just under ten million: the shared rule rounds once, so both
  // screens must print "10M" rather than "9.9M" on one and "10M" on the other.
  assert.equal(compactTokenCount(9_960_000), formatCompactTokenValue(9_960_000));
  assert.equal(formatCompactTokenValue(9_960_000), "10M");

  // The 1M-10M tier keeps its single decimal on both screens.
  assert.equal(compactTokenCount(1_500_000), formatCompactTokenValue(1_500_000));
  assert.equal(formatCompactTokenValue(1_500_000), "1.5M");

  // A whole million loses the trailing ".0" on both screens.
  assert.equal(compactTokenCount(1_000_000), formatCompactTokenValue(1_000_000));
  assert.equal(formatCompactTokenValue(1_000_000), "1M");

  // Below one million the number is shared; only the unit glyph still differs,
  // as it already did on both screens (the badge prints lowercase "k").
  assert.equal(compactTokenCount(200_000), "200k");
  assert.equal(formatCompactTokenValue(200_000), "200K");
});
