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

"""Putting the packages a search needs into the runtime its candidates use.

The person who types "把误差降下来" has no way to know the search wants a
gradient-boosting library, and no reason to. The drafting agent does know, so it
says, and this is the half that acts on it.

**Only what is missing, and only into the candidate runtime.** `find_spec`
first: on a warm host the common case is that everything asked for is already
there and nothing runs at all.

**A name is a name.** Anything that could redirect where the package comes from
— an index URL, an editable path, a VCS reference, an environment marker — is
refused rather than passed through, because the whole value of the list is that
a reader can see what it says. `lightgbm` is legible; `-i http://…/simple` is a
different supply chain wearing the same field.

**Failure is a refusal, not a warning.** A run whose candidates were promised
`xgboost` and did not get it fails every expansion with `ModuleNotFoundError`
and reads as a model that cannot write code — the same failure this module's
sibling `missing_candidate_runtime` exists to prevent at the other end.
"""

from __future__ import annotations

import importlib
import importlib.util
import re
import shutil
import subprocess
import sys
from typing import Iterable, List, Sequence, Tuple

from .logging_config import get_logger

log = get_logger("provision")

#: A bare distribution name, optionally with a version pin. Deliberately narrow:
#: everything pip would read as an option, a path or a URL falls outside it.
_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}(==[A-Za-z0-9][A-Za-z0-9.*+!-]{0,31})?$")

#: How long one install may take before it is abandoned. A wheel for a boosting
#: library is tens of megabytes; a source build is not something to wait out
#: while a user watches a wizard.
TIMEOUT_SECONDS = 600.0

#: The import name for distributions that do not share one with their package.
_IMPORT_NAME = {
    "scikit-learn": "sklearn",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "pyyaml": "yaml",
}


class ProvisionError(RuntimeError):
    """The runtime could not be made to match what the run was promised."""


def _installer(packages: Sequence[str]) -> List[str]:
    """The command that puts `packages` into *this* interpreter's environment.

    `uv` first, because on this deployment `uv` is what created the venv and a
    uv-made venv has no `pip` in it — the first real attempt to provision one
    came back "No module named pip", which reads as a broken runtime rather
    than as a missing tool. `--python sys.executable` rather than an activated
    environment: this process is the one whose import cache the AST gate reads,
    so it has to be this environment and not whichever one uv would guess.
    """
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", sys.executable, *packages]
    if importlib.util.find_spec("pip") is not None:
        return [sys.executable, "-m", "pip", "install", "--no-input",
                "--disable-pip-version-check", *packages]
    raise ProvisionError(
        "这个候选运行时里既没有 uv 也没有 pip，装不了东西。"
        "要么在部署时把包一起装上，要么让 uv 出现在 PATH 上"
    )


def import_name(package: str) -> str:
    """What `import` would spell this distribution."""
    base = package.split("==")[0].strip().lower()
    return _IMPORT_NAME.get(base, base.replace("-", "_"))


def missing(packages: Iterable[str]) -> List[str]:
    """Those not importable here, in the order given, without duplicates."""
    seen, absent = set(), []
    for package in packages:
        name = package.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        if importlib.util.find_spec(import_name(name)) is None:
            absent.append(name)
    return absent


def ensure(packages: Sequence[str]) -> Tuple[List[str], str]:
    """Install whatever is missing. `(what was installed, one line about it)`.

    Raises :class:`ProvisionError` when a name is not a name, or when pip
    refuses: both are things the user has to see before a run starts, and both
    are invisible afterwards — the run would just report that every candidate
    failed to import something.
    """
    wanted = [package.strip() for package in packages if package.strip()]
    for package in wanted:
        if not _NAME.match(package):
            raise ProvisionError(
                f"{package!r} 不是一个包名。这里只接受包名（可以带 ==版本），"
                "不接受路径、URL、索引地址或 pip 选项"
            )

    absent = missing(wanted)
    if not absent:
        return [], ("这次要的包都已经装好了" if wanted else "")

    command = _installer(absent)
    log.info("installing %s with %s", ", ".join(absent), command[0])
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise ProvisionError(
            f"装 {'、'.join(absent)} 超过 {TIMEOUT_SECONDS:.0f} 秒还没结束"
        ) from error
    if completed.returncode != 0:
        tail = ((completed.stderr or "") + (completed.stdout or "")).strip()[-400:]
        raise ProvisionError(f"装 {'、'.join(absent)} 失败了：{tail or '（没有输出）'}")

    # The interpreter cached the failed lookups on the way in, and this process
    # is the one that runs the AST gate — without this the gate keeps reporting
    # that a package installed a second ago is not installed.
    importlib.invalidate_caches()
    still = missing(absent)
    if still:
        raise ProvisionError(
            f"装完了但还是 import 不到：{'、'.join(still)}。"
            "多半是包名和 import 名对不上"
        )
    return absent, f"给候选运行时装了 {'、'.join(absent)}"
