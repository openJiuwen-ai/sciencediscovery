#!/usr/bin/env python3
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Fixed Ascend MindSpore smoke test for the Runner NPU Broker."""

from __future__ import annotations

import json

import mindspore as ms


ms.set_context(device_target="Ascend")
value = ms.Tensor([1, 2, 3], ms.float32) + ms.Tensor([3, 2, 1], ms.float32)
print(json.dumps({
    "ok": True,
    "device_target": ms.get_context("device_target"),
    "result": value.asnumpy().tolist(),
}, sort_keys=True))
