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

"""Putting what a search needs into the runtime its candidates use.

The tests that matter are the two edges: nothing runs when nothing is missing,
and a "name" that is not a name never reaches pip. The middle — an actual
install — is not something a test suite should be doing to its own interpreter.
"""

from __future__ import annotations

import pytest

from sciencediscovery_evolve.provision import ProvisionError, ensure, import_name, missing


def test_nothing_runs_when_nothing_is_missing() -> None:
    # The common case on a warm host, and it must not shell out to pip to
    # discover that: the wizard is waiting on this before it can probe.
    installed, note = ensure(["numpy", "pandas"])
    assert installed == []
    assert "already installed" in note


def test_a_distribution_whose_import_name_differs_is_still_found() -> None:
    assert import_name("scikit-learn") == "sklearn"
    assert import_name("PyYAML") == "yaml"
    assert import_name("lightgbm==4.3.0") == "lightgbm"
    # …and the general rule for everything not in the table.
    assert import_name("some-package") == "some_package"


@pytest.mark.parametrize("name", [
    "-i http://evil.invalid/simple",
    "--index-url=http://evil.invalid",
    "git+https://example.invalid/x.git",
    "/tmp/wheel-that-is-not-a-name",
    "numpy; python_version<'3'",
    "-e .",
])
def test_anything_that_could_redirect_where_a_package_comes_from_is_refused(name: str) -> None:
    """The value of the list is that a reader can see what it says.

    `lightgbm` is legible. `-i http://…/simple` is a different supply chain
    wearing the same field, and it is a model that fills this field in.
    """
    with pytest.raises(ProvisionError, match="is not a package name"):
        ensure([name])


def test_a_refused_name_stops_the_whole_list_rather_than_installing_the_rest() -> None:
    # Checked before anything runs: a half-provisioned runtime is worse than a
    # refusal, because the run would start and fail somewhere else.
    with pytest.raises(ProvisionError):
        ensure(["numpy", "--index-url=http://evil.invalid"])


def test_duplicates_and_blanks_do_not_reach_pip() -> None:
    assert missing(["numpy", "numpy", "  ", "pandas"]) == []
