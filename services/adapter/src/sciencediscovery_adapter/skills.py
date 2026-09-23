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

"""Install ScienceDiscovery's skills as JiuwenSwarm skills.

With the JiuwenSwarm backend, skills are JiuwenSwarm's: its prompt lists the installed ones and the model
loads one with its `skill_tool`. A run's skills (the frozen packages the API staged for it) are imported
with `skills.import_local`, which copies a package into JiuwenSwarm's skills directory.

Each imported package carries a marker file with the skill's id and content hash. It tells an imported
ScienceDiscovery skill from one of JiuwenSwarm's own, and an unchanged skill is not imported again, also
after the adapter restarts. JiuwenSwarm's own skills are never overwritten: a ScienceDiscovery skill whose
name is taken is installed as `sciencediscovery-<id>`.

Limit: JiuwenSwarm has one skills directory for every session, so a skill imported for one session is
listed in the others too, at the revision imported last.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

Rpc = Callable[..., Awaitable[dict[str, Any]]]

MARKER = ".sciencediscovery.json"
RENAMED_PREFIX = "sciencediscovery-"
_NAME_LINE = re.compile(r"^name:.*$", re.MULTILINE)

logger = logging.getLogger(__name__)


def _marker(skill_dir: Path) -> dict[str, Any] | None:
    try:
        value = json.loads((skill_dir / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _renamed(skill_md: str, name: str) -> str:
    """SKILL.md with its frontmatter `name` replaced (JiuwenSwarm installs a package under that name)."""
    if not skill_md.lstrip().startswith("---"):
        return skill_md
    start = skill_md.index("---") + 3
    end = skill_md.find("\n---", start)
    if end < 0:
        return skill_md
    head = _NAME_LINE.sub(f"name: {name}", skill_md[start:end], count=1)
    return skill_md[:start] + head + skill_md[end:]


class SkillSync:
    def __init__(self, rpc: Rpc, mgmt_url: str) -> None:
        self._rpc = rpc
        self._url = mgmt_url
        self._lock = asyncio.Lock()
        # JiuwenSwarm's directory of each imported skill -> its ScienceDiscovery id, for sandbox_skill_paths.
        self.directories: dict[str, str] = {}

    async def _installed(self) -> dict[str, Path]:
        """Every skill JiuwenSwarm has, by name, with its directory."""
        listed = (await self._rpc(self._url, "skills.list", {})).get("skills", [])
        found: dict[str, Path] = {}
        for skill in listed:
            name, path = skill.get("name"), skill.get("path")
            if isinstance(name, str) and isinstance(path, str) and path:
                found[name] = Path(path).parent
        return found

    async def listed(self) -> list[dict[str, Any]]:
        """The skills JiuwenSwarm has installed, each with where it came from: `sciencediscovery` (imported from
        ScienceDiscovery, with its id there), `builtin` (shipped with JiuwenSwarm) or JiuwenSwarm's own source name."""
        listed = (await self._rpc(self._url, "skills.list", {})).get("skills", [])
        skills: list[dict[str, Any]] = []
        for skill in listed:
            name, path = skill.get("name"), skill.get("path")
            if not isinstance(name, str) or skill.get("installed") is False:
                continue
            marker = _marker(Path(path).parent) if isinstance(path, str) and path else None
            source = "sciencediscovery" if marker else "builtin" if skill.get("is_builtin_source") else str(skill.get("source") or "local")
            skills.append({
                "name": name,
                "description": str(skill.get("description") or "").strip(),
                "enabled": skill.get("enabled") is not False,
                "source": source,
                **({"skillId": marker.get("id")} if marker and isinstance(marker.get("id"), str) else {}),
            })
        return sorted(skills, key=lambda item: (item["source"] != "sciencediscovery", item["name"]))

    async def set_enabled(self, name: str, enabled: bool) -> None:
        """Switch a skill on or off for every session (JiuwenSwarm applies it to sessions started afterwards)."""
        answer = await self._rpc(self._url, "skills.toggle", {"name": name, "enabled": enabled})
        if not answer.get("success", False):
            raise RuntimeError(str(answer.get("detail") or answer)[:300])

    async def sync(self, skills: list[dict[str, str]]) -> dict[str, dict[str, str]]:
        """Import each `{id, path, hash}` that JiuwenSwarm lacks or has at another hash.

        Returns, by id, the name JiuwenSwarm lists it under, or the reason it could not be imported.
        """
        async with self._lock:
            result = await self._sync(skills)
            try:
                for directory in (await self._installed()).values():
                    marker = _marker(directory)
                    if marker and isinstance(marker.get("id"), str):
                        self.directories[str(directory)] = marker["id"]
            except Exception as error:  # only path rewriting depends on it
                logger.warning("could not list JiuwenSwarm's skill directories: %s", error)
            return result

    async def _sync(self, skills: list[dict[str, str]]) -> dict[str, dict[str, str]]:
        installed = await self._installed()
        result: dict[str, dict[str, str]] = {}
        for skill in skills:
            skill_id, source, digest = skill["id"], Path(skill["path"]), skill["hash"]
            name = skill_id
            if name in installed and _marker(installed[name]) is None:
                name = RENAMED_PREFIX + skill_id  # JiuwenSwarm's own skill of that name stays
            current = _marker(installed[name]) if name in installed else None
            if current and current.get("id") == skill_id and current.get("hash") == digest:
                result[skill_id] = {"name": name}
                continue
            try:
                await self._import(source, skill_id, name, digest)
                result[skill_id] = {"name": name}
            except Exception as error:  # a refused package must not stop the run
                logger.warning("could not import skill %s into JiuwenSwarm: %s", skill_id, error)
                result[skill_id] = {"error": str(error)[:300]}
        return result

    async def _import(self, source: Path, skill_id: str, name: str, digest: str) -> None:
        if not (source / "SKILL.md").is_file():
            raise ValueError(f"no SKILL.md in {source}")
        with tempfile.TemporaryDirectory(prefix="sd-skill-") as staging:
            package = Path(staging) / name
            # The staged package is read-only; the copy gets the marker (and a new name, if it has one).
            shutil.copytree(source, package)
            for path in [package, *package.rglob("*")]:
                path.chmod(path.stat().st_mode | 0o200)
            if name != skill_id:
                skill_md = package / "SKILL.md"
                skill_md.write_text(_renamed(skill_md.read_text(encoding="utf-8"), name), encoding="utf-8")
            (package / MARKER).write_text(json.dumps({"id": skill_id, "hash": digest}), encoding="utf-8")
            answer = await self._rpc(self._url, "skills.import_local", {"path": str(package), "force": True}, timeout=120)
        if not answer.get("success", False):
            raise RuntimeError(str(answer.get("detail") or answer)[:300])


SKILLS_VARIABLE = "SCIENCEDISCOVERY_SKILLS_DIR"


def sandbox_skill_paths(command: str, directories: dict[str, str]) -> str:
    """A shell command with JiuwenSwarm's copy of a skill replaced by the package the sandbox mounts.

    JiuwenSwarm's `skill_tool` points the model at the skill in its own skills directory, which the Runner
    sandbox does not have; the same frozen package is there as `$SCIENCEDISCOVERY_SKILLS_DIR/<id>`. The
    variable is written so that it expands where the path stood: bare, in double quotes, or in single quotes.
    """
    found = sorted((d for d in directories if d and d in command), key=len, reverse=True)
    if not found:
        return command
    out: list[str] = []
    single = double = False
    index = 0
    while index < len(command):
        char = command[index]
        match = next((d for d in found if command.startswith(d, index)
                      and (index + len(d) == len(command) or not (command[index + len(d)].isalnum() or command[index + len(d)] in "-_."))), None)
        if match:
            target = f"/{directories[match]}"
            variable = f"${SKILLS_VARIABLE}"
            out.append(f"'\"{variable}\"'{target}" if single else f"{variable}{target}" if double else f"\"{variable}\"{target}")
            index += len(match)
            continue
        if char == "\\" and not single:
            out.append(command[index:index + 2])
            index += 2
            continue
        if char == "'" and not double:
            single = not single
        elif char == '"' and not single:
            double = not double
        out.append(char)
        index += 1
    return "".join(out)
