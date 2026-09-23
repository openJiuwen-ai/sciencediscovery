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

"""Measure every Python process a `--coverage` run starts.

The shared runner puts this directory on PYTHONPATH only when it records
coverage, so the interpreter imports it at startup: the pytest worker itself,
and any Python a test starts — a Node test launching the paper worker, a Python
test launching a helper — measure themselves the same way. Nothing else about
the process changes.

Each start is logged with whether it could be measured, because "no data" and
"never measured" must not look alike: an interpreter without `coverage`, or a
sandbox that cannot write the data directory, is reported rather than silently
missing.
"""

import json
import os
import sys

_rc = os.environ.get("COVERAGE_PROCESS_START")
if _rc:
    _status = "measured"
    _data = os.environ.get("SCIENCE_COVERAGE_DATA_DIR", "")
    try:
        import coverage
        _startup = getattr(coverage, "process_startup", None)
    except Exception:
        _startup = None
    if _startup is None:  # an interpreter the run did not provision
        _status = "no-coverage-module"
    elif not _data or not os.access(_data, os.W_OK):
        # A sandboxed process may see the directory read-only; starting a
        # collector there would only fail at exit, on the test's stderr.
        _status = "data-dir-not-writable"
    else:
        try:
            _startup()
        except Exception:
            _status = "startup-failed"
    _log = os.environ.get("SCIENCE_COVERAGE_PROCESS_LOG")
    if _log:
        try:
            with open(_log, "a", encoding="utf-8") as _stream:
                _stream.write(json.dumps({
                    "status": _status,
                    "executable": sys.executable,
                    "argv": list(getattr(sys, "orig_argv", sys.argv))[:4],
                }) + "\n")
        except Exception:  # the log is evidence, never a reason to fail the process
            pass
