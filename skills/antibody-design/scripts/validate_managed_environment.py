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

"""Validate the selected Runner environment against this Skill's requirements."""

from __future__ import annotations

from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import re
import sys
from typing import Callable, NamedTuple


class Requirement(NamedTuple):
    distribution: str
    expected_version: str | None


# Only import-name exceptions live here. The dependency set and every version
# constraint remain single-sourced in requirements.txt.
IMPORT_NAME_OVERRIDES = {
    "biopython": "Bio",
    "scikit-learn": "sklearn",
    "pyyaml": "yaml",
    "hydra-core": "hydra",
    "ml-collections": "ml_collections",
    "dm-tree": "tree",
    "protobuf": "google.protobuf",
}
REQUIREMENT_PATTERN = re.compile(r"^([A-Za-z0-9_.-]+)(?:==([^\s]+))?$")


def read_requirements(path: Path) -> list[Requirement]:
    requirements: list[Requirement] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = REQUIREMENT_PATTERN.fullmatch(line)
        if not match:
            raise ValueError(
                f"unsupported requirement at {path}:{line_number}: {line}; "
                "use an unpinned package or an exact == version"
            )
        requirements.append(Requirement(match.group(1), match.group(2)))
    return requirements


def import_name(distribution: str) -> str:
    normalized = distribution.lower().replace("_", "-")
    return IMPORT_NAME_OVERRIDES.get(normalized, normalized.replace("-", "_"))


def validate_environment(
    requirements: list[Requirement],
    importer: Callable[[str], object] = import_module,
    distribution_version: Callable[[str], str] = version,
) -> list[str]:
    """Return all missing, broken, or incompatible dependency errors."""
    errors: list[str] = []
    for requirement in requirements:
        distribution = requirement.distribution
        module = import_name(distribution)
        try:
            installed = distribution_version(distribution)
        except PackageNotFoundError:
            suffix = f"=={requirement.expected_version}" if requirement.expected_version else ""
            errors.append(f"missing distribution {distribution}{suffix}")
            continue
        if requirement.expected_version and installed != requirement.expected_version:
            errors.append(
                f"{distribution}=={installed}; required {requirement.expected_version}"
            )
            continue
        try:
            importer(module)
        except Exception as exc:  # also report broken transitive imports
            errors.append(
                f"cannot import {module} (from {distribution}): "
                f"{type(exc).__name__}: {exc}"
            )
    return errors


def main() -> int:
    requirements_path = (
        Path(sys.argv[1]).resolve()
        if len(sys.argv) == 2
        else Path(__file__).resolve().parent.parent / "requirements.txt"
    )
    if len(sys.argv) > 2:
        print("usage: validate_managed_environment.py [requirements.txt]")
        return 2
    try:
        requirements = read_requirements(requirements_path)
    except (OSError, ValueError) as exc:
        print(f"Managed environment validation failed:\n  - {exc}")
        return 2
    errors = validate_environment(requirements)
    if errors:
        print("Managed environment validation failed:")
        for error in errors:
            print(f"  - {error}")
        return 2
    print("MANAGED_ENV_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
