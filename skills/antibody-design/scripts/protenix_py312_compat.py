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

"""Run MindScience Protenix inference with Python 3.12 compatibility patches.

The deployed Protenix checkout used by this skill is an operator-managed host
asset.  Do not edit it in-place from ScienceDiscovery.  This wrapper applies the
minimal runtime compatibility shim needed by Python 3.12 before executing the
checkout's inference.py entrypoint.
"""

from __future__ import annotations

import random
import runpy
import sys
from pathlib import Path


def _coerce_index_bound(value):
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


_ORIGINAL_RANDOM_RANDINT = random.Random.randint


def _randint_accept_integral_float(self, a, b):
    return _ORIGINAL_RANDOM_RANDINT(
        self,
        _coerce_index_bound(a),
        _coerce_index_bound(b),
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: protenix_py312_compat.py /path/to/protenix/inference.py [args...]", file=sys.stderr)
        return 2

    inference_script = Path(sys.argv[1]).resolve()
    if not inference_script.is_file():
        print(f"error: Protenix inference.py not found: {inference_script}", file=sys.stderr)
        return 2

    random.Random.randint = _randint_accept_integral_float
    random.randint = random._inst.randint

    sys.argv = [str(inference_script), *sys.argv[2:]]
    runpy.run_path(str(inference_script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
