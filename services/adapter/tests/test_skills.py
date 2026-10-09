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

import json
import re
import shutil
from pathlib import Path

from sciencediscovery_adapter.skills import MARKER, SkillSync, sandbox_skill_paths
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

URL = "ws://gw/ws"


class FakeJiuwenSwarm:
    """skills.list and skills.import_local over a real directory, as JiuwenSwarm does them."""

    def __init__(self, root: Path):
        self.root = root
        self.imports = []
        self.disabled = set()

    async def rpc(self, url, method, params=None, **kwargs):
        if method == "skills.list":
            return {"skills": [{"name": d.name, "path": str(d / "SKILL.md"), "description": f"{d.name} things", "installed": True,
                                "enabled": d.name not in self.disabled, "is_builtin_source": not (d / MARKER).exists(), "source": "builtin"}
                               for d in sorted(self.root.iterdir()) if d.is_dir()]
                              + [{"name": "not-installed", "path": "", "installed": False}]}
        if method == "skills.toggle":
            (self.disabled.discard if params["enabled"] else self.disabled.add)(params["name"])
            return {"success": True}
        assert method == "skills.import_local"
        source = Path(params["path"])
        name = re.search(r"^name:\s*(\S+)", (source / "SKILL.md").read_text(), re.MULTILINE).group(1)
        dest = self.root / name
        if dest.exists():
            if not (dest / MARKER).exists():
                return {"success": False, "detail": f"内置 Skill 不可覆盖: {name}"}
            shutil.rmtree(dest)
        shutil.copytree(source, dest)
        self.imports.append(name)
        return {"success": True, "skill": {"name": name}}


def package(tmp: Path, skill_id: str, body: str = "Do it.") -> Path:
    path = tmp / "staged" / skill_id
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(f"---\nname: {skill_id}\ndescription: {skill_id} things\n---\n\n{body}\n")
    (path / "scripts").mkdir()
    (path / "scripts" / "run.py").write_text("print(1)\n")
    for item in [path, *path.rglob("*")]:
        item.chmod(0o555 if item.is_dir() else 0o444)  # staged packages are read-only
    return path


def jiuwenswarm(tmp: Path, *own: str) -> FakeJiuwenSwarm:
    root = tmp / "jw-skills"
    root.mkdir()
    for name in own:
        (root / name).mkdir()
        (root / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: theirs\n---\n")
    return FakeJiuwenSwarm(root)


async def test_a_skill_is_imported_whole_with_its_marker(tmp_path):
    jw = jiuwenswarm(tmp_path)
    result = await SkillSync(jw.rpc, URL).sync([{"id": "evolve-design", "path": str(package(tmp_path, "evolve-design")), "hash": "h1"}])
    assert result == {"evolve-design": {"name": "evolve-design"}}
    installed = jw.root / "evolve-design"
    assert (installed / "scripts" / "run.py").read_text() == "print(1)\n"
    assert json.loads((installed / MARKER).read_text()) == {"id": "evolve-design", "hash": "h1"}


async def test_an_unchanged_skill_is_not_imported_again_even_by_a_new_adapter(tmp_path):
    jw = jiuwenswarm(tmp_path)
    skill = {"id": "evolve-design", "path": str(package(tmp_path, "evolve-design")), "hash": "h1"}
    await SkillSync(jw.rpc, URL).sync([skill])
    await SkillSync(jw.rpc, URL).sync([skill])
    assert jw.imports == ["evolve-design"]


async def test_a_new_revision_replaces_the_imported_one(tmp_path):
    jw = jiuwenswarm(tmp_path)
    sync = SkillSync(jw.rpc, URL)
    await sync.sync([{"id": "evolve-design", "path": str(package(tmp_path, "evolve-design")), "hash": "h1"}])
    newer = package(tmp_path / "v2", "evolve-design", body="Do it better.")
    await sync.sync([{"id": "evolve-design", "path": str(newer), "hash": "h2"}])
    assert jw.imports == ["evolve-design", "evolve-design"]
    assert "Do it better." in (jw.root / "evolve-design" / "SKILL.md").read_text()


async def test_a_name_jiuwenswarm_already_uses_is_kept_for_its_own_skill(tmp_path):
    jw = jiuwenswarm(tmp_path, "skill-creator")
    result = await SkillSync(jw.rpc, URL).sync([{"id": "skill-creator", "path": str(package(tmp_path, "skill-creator")), "hash": "h1"}])
    assert result == {"skill-creator": {"name": "sciencediscovery-skill-creator"}}
    assert (jw.root / "skill-creator" / "SKILL.md").read_text().count("theirs") == 1
    ours = (jw.root / "sciencediscovery-skill-creator" / "SKILL.md").read_text()
    assert ours.startswith("---\nname: sciencediscovery-skill-creator\n") and "Do it." in ours


async def test_a_refused_skill_is_reported_and_the_others_still_imported(tmp_path):
    jw = jiuwenswarm(tmp_path)
    broken = tmp_path / "broken"
    broken.mkdir()
    result = await SkillSync(jw.rpc, URL).sync([
        {"id": "broken", "path": str(broken), "hash": "h"},
        {"id": "evolve-design", "path": str(package(tmp_path, "evolve-design")), "hash": "h1"},
    ])
    assert "error" in result["broken"] and result["evolve-design"] == {"name": "evolve-design"}


async def test_the_list_says_which_skills_came_from_sciencediscovery_and_which_are_on(tmp_path):
    jw = jiuwenswarm(tmp_path, "xlsx", "skill-creator")
    sync = SkillSync(jw.rpc, URL)
    await sync.sync([{"id": "skill-creator", "path": str(package(tmp_path, "skill-creator")), "hash": "h1"}])
    await sync.set_enabled("xlsx", False)
    listed = await sync.listed()
    assert listed == [
        {"name": "sciencediscovery-skill-creator", "description": "sciencediscovery-skill-creator things", "enabled": True, "source": "sciencediscovery", "skillId": "skill-creator"},
        {"name": "skill-creator", "description": "skill-creator things", "enabled": True, "source": "builtin"},
        {"name": "xlsx", "description": "xlsx things", "enabled": False, "source": "builtin"},
    ]


async def test_sync_records_where_jiuwenswarm_keeps_each_imported_skill(tmp_path):
    jw = jiuwenswarm(tmp_path, "evolve-design")  # its own skill of that name: ours is renamed
    sync = SkillSync(jw.rpc, URL)
    await sync.sync([{"id": "evolve-design", "path": str(package(tmp_path, "evolve-design")), "hash": "h1"}])
    assert sync.directories == {str(jw.root / "sciencediscovery-evolve-design"): "evolve-design"}


def test_a_command_reading_jiuwenswarms_copy_of_a_skill_reads_the_sandbox_package():
    # Observed: skill_tool pointed the model at JiuwenSwarm's skills directory and it ran
    # `cat <that>/references/custom-script.md`, which the sandbox does not have.
    jw = "/root/.jiuwenswarm-instances/sd/agent/workspace/skills/sciencediscovery-evolve-design"
    dirs = {jw: "evolve-design"}
    assert sandbox_skill_paths(f"cat {jw}/references/custom-script.md", dirs) \
        == 'cat "$SCIENCEDISCOVERY_SKILLS_DIR"/evolve-design/references/custom-script.md'
    assert sandbox_skill_paths(f'cat "{jw}/a b.md"', dirs) == 'cat "$SCIENCEDISCOVERY_SKILLS_DIR/evolve-design/a b.md"'
    assert sandbox_skill_paths(f"cat '{jw}/a.md'", dirs) == "cat ''\"$SCIENCEDISCOVERY_SKILLS_DIR\"'/evolve-design/a.md'"
    assert sandbox_skill_paths(f"ls {jw}", dirs) == 'ls "$SCIENCEDISCOVERY_SKILLS_DIR"/evolve-design'
    # A longer name that only starts the same is another skill; a command without the path is untouched.
    assert sandbox_skill_paths(f"ls {jw}-2", dirs) == f"ls {jw}-2"
    assert sandbox_skill_paths("ls /workspace", dirs) == "ls /workspace"
