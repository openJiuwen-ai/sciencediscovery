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

"""Workspace-first manager for the sandboxed antibody design pipeline.

The manager runs directly from the frozen, read-only Skill package. Scientific
inputs, model code, checkpoints and outputs must live in the selected Runner's
workspace; Python comes from the selected managed scientific environment.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


MINDSCIENCE_REPO_URL = "https://gitcode.com/mindspore/mindscience.git"
MINDSCIENCE_REF = "971c015b0111d229608ff05b9e77704dbb0793b4"
SHARKER_REPO_URL = "https://gitee.com/sunhaoneng/gnn.git"
SHARKER_REF = "face6e69112866d69b102839d7aeff3a6822bc8e"
RF_DIFFUSION_IO_PATCH = Path(__file__).with_name("rfdiffusion_mindspore_io.patch")
RF_DIFFUSION_IO_TARGET = Path(
    "MindSPONGE/applications/rf_diffusion/rfdiffusion/inference/ab_util.py"
)
RF_DIFFUSION_CKPT = {
    "url": "https://tools.mindspore.cn/dataset/workspace/mindspore_ckpt/ckpt/RFdiffusion/RFdiffusion_Ab.ckpt",
    "size": 480_719_938,
    "sha256": "19432e2789016d3e25543771c69147ea7a1a8bbc2099d7c93678090e63e7e581",
}
PROTENIX_CKPT = {
    "url": "https://tools.mindspore.cn/dataset/workspace/mindspore_ckpt/ckpt/Protenix/ms_model_v0.5.0.ckpt",
    "size": 1_472_707_161,
    "sha256": "b0944db8b3ecf48db7c73c4538194bda86b9ce8b036812e0a1c950bebc26fde0",
}
PROTEINMPNN_CKPT = {
    "url": "https://tools.mindspore.cn/dataset/workspace/mindspore_ckpt/ckpt/ProteinMPNN/vanilla_model_weights/v_48_020.ckpt",
    "size": 6_654_507,
    "sha256": "abb333dde811e2b5a4909a3e6a0ef67c762809e14dd3e1ebd8dca0feea7bcd3a",
}


WORKSPACE_PATH_KEYS = {
    "workspace",
    "models_dir",
    "mindscience_root",
    "app_dir",
    "rf_diffusion_dir",
    "proteinmpnn_dir",
    "protenix_dir",
    "ckpt",
    "protenix_ckpt",
    "proteinmpnn_ckpt",
    "hmmer_home",
    "target_pdb",
    "framework_pdb",
    "run_dir",
}

SANDBOX_FORBIDDEN_CONFIG_KEYS = {
    "python",
    "pipeline_env",
    "cann_set_env",
    "scripts_dir",
    "proteinmpnn_ckpt",
}


def posix_path(value: Any) -> str:
    text = str(value)
    if text.startswith("/"):
        return str(PurePosixPath(text))
    return str(Path(text))


def join_path(base: Any, *parts: str) -> str:
    base_text = posix_path(base)
    if base_text.startswith("/"):
        return str(PurePosixPath(base_text, *parts))
    return str(Path(base_text, *parts))


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"config must be a JSON object: {path}")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def env_or_empty(name: str) -> str:
    return os.environ.get(name, "").strip()


def env_bool(name: str, default: bool = False) -> bool:
    value = env_or_empty(name).lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def normalize_hotspots(value: Any) -> str:
    """Return RFdiffusion-style [A13,A14] hotspots from common user formats."""
    if isinstance(value, (list, tuple)):
        text = ",".join(str(item).strip() for item in value if str(item).strip())
    else:
        text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    parts = [part.strip() for part in re.split(r"[,;\s]+", text) if part.strip()]
    if not parts:
        return ""
    return "[" + ",".join(parts) + "]"


def target_pdb_residues(path: Path) -> tuple[set[tuple[str, int]], set[str]]:
    """Return chain-labelled CA residues from a target PDB."""
    residues: set[tuple[str, int]] = set()
    chains: set[str] = set()
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if not line.startswith("ATOM") or line[12:16].strip() != "CA":
                continue
            chain = line[21].strip() or "_"
            try:
                residue = int(line[22:26])
            except ValueError:
                continue
            chains.add(chain)
            residues.add((chain, residue))
    return residues, chains


def hotspot_target_errors(cfg: dict[str, Any]) -> list[str]:
    """Reject hotspot labels that are absent from the uploaded target PDB."""
    target = Path(str(cfg.get("target_pdb", "")))
    match = re.fullmatch(
        r"\[([A-Za-z][0-9]+(?:,[A-Za-z][0-9]+)*)\]",
        str(cfg.get("hotspots", "")),
    )
    if not target.is_file() or not match:
        return []
    residues, chains = target_pdb_residues(target)
    requested = [
        (item[0], int(item[1:]))
        for item in match.group(1).split(",")
    ]
    missing = [f"{chain}{residue}" for chain, residue in requested if (chain, residue) not in residues]
    if not missing:
        return []
    available = ",".join(sorted(chains)) or "none"
    return [
        "hotspots do not exist in target_pdb "
        f"{target}: {','.join(missing)} (available chains: {available})"
    ]


def default_scripts_dir() -> str:
    return posix_path(Path(__file__).resolve().parent)


def executable_file(path: str) -> bool:
    return bool(path) and Path(path).is_file() and os.access(path, os.X_OK)


def workspace_root_path(workspace_root: Path | None = None) -> Path:
    """Return the current Runner workspace root used by this execution."""
    return (workspace_root or Path.cwd()).resolve()


def resolve_workspace_value(value: Any, workspace_root: Path) -> str:
    """Resolve one Agent-authored path against the selected Runner workspace."""
    text = str(value or "").strip()
    if not text:
        return ""
    path = Path(text)
    if not path.is_absolute():
        path = workspace_root / path
    return posix_path(path.resolve())


def sandbox_config_errors(
    raw: dict[str, Any],
    cfg: dict[str, Any],
    *,
    workspace_root: Path | None = None,
) -> list[str]:
    """Reject host paths and config fields owned by the Runner/runtime."""
    root = workspace_root_path(workspace_root)
    errors = [
        f"{key} is runtime-owned and must not be set in config.json"
        for key in sorted(SANDBOX_FORBIDDEN_CONFIG_KEYS)
        if key in raw and str(raw.get(key, "")).strip()
    ]
    for key in sorted(WORKSPACE_PATH_KEYS):
        raw_value = raw.get(key)
        if raw_value is not None and str(raw_value).strip() and Path(str(raw_value)).is_absolute():
            errors.append(f"{key} must be relative to the selected Runner workspace: {raw_value}")
            continue
        resolved = str(cfg.get(key, "")).strip()
        if not resolved:
            continue
        try:
            Path(resolved).resolve().relative_to(root)
        except ValueError:
            errors.append(f"{key} escapes the selected Runner workspace: {raw_value or resolved}")
    return errors


def discover_python() -> str:
    """Return the Python selected by ScienceDiscovery's managed scientific env.

    Runner shell sessions expose the selected environment as SCIENCE_ENV_PYTHON
    and put that environment first on PATH. Older prompts may still set
    SCIENCE_AGENT_MANAGED_PYTHON/PYTHON_BIN explicitly, so keep those aliases.
    Never fall back to host pipeline venvs.
    """
    for name in ("SCIENCE_ENV_PYTHON", "SCIENCE_AGENT_MANAGED_PYTHON", "PYTHON_BIN", "ANTIBODY_PIPELINE_PYTHON"):
        configured = env_or_empty(name)
        if executable_file(configured):
            return configured
    current = posix_path(sys.executable)
    if executable_file(current) and ("/scientific-envs/revisions/" in current or current.startswith("/opt/science-env/")):
        return current
    return ""


def env_truthy(name: str, default: bool = True) -> bool:
    value = env_or_empty(name).lower()
    if not value:
        return default
    return value not in {"0", "false", "no", "off"}


def require_managed_env() -> bool:
    """Managed-environment gate. The former variable name is still honoured."""
    if env_or_empty("ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV"):
        return env_truthy("ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV", True)
    return env_truthy("ANTIBODY_REQUIRE_SCIENCEAGENT_ENV", True)


def managed_python_errors(cfg: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    python_bin = str(cfg.get("python", "")).strip()
    if not python_bin:
        return [
            "python is unresolved; select/create a ScienceDiscovery scientific environment "
            "and use the runner-injected SCIENCE_ENV_PYTHON or PATH python"
        ]
    py_text = posix_path(python_bin)
    pipeline_home = env_or_empty("ANTIBODY_PIPELINE_HOME")
    blocked_fragments = ["/antibody_pipeline/venv/", "/antibody_pipeline/python_user/"]
    if pipeline_home:
        ph = posix_path(pipeline_home).rstrip("/")
        blocked_fragments.extend([f"{ph}/venv/", f"{ph}/python_user/", f"{ph}/bin/"])
    if any(fragment and fragment in py_text for fragment in blocked_fragments):
        errors.append(f"python points at a host pipeline environment, not ScienceDiscovery managed env: {py_text}")
    managed_env_python = "/scientific-envs/revisions/" in py_text or py_text.startswith("/opt/science-env/")
    if require_managed_env() and not managed_env_python:
        errors.append(
            "python must come from the ScienceDiscovery selected scientific environment "
            f"(SCIENCE_ENV_PYTHON or /opt/science-env/bin/python), got: {py_text}"
        )
    return errors


def managed_pipeline_env_errors(cfg: dict[str, Any]) -> list[str]:
    pipeline_env = str(cfg.get("pipeline_env", "")).strip()
    if require_managed_env() and pipeline_env:
        return [
            "pipeline_env is not allowed in ScienceDiscovery managed-env mode; "
            f"do not source host env.sh, got: {pipeline_env}"
        ]
    return []


def resolve_config(cfg: dict[str, Any], *, workspace_root: Path | None = None) -> dict[str, Any]:
    root = workspace_root_path(workspace_root)
    workspace = resolve_workspace_value(cfg.get("workspace", "antibody_pipeline"), root)
    models_dir = resolve_workspace_value(cfg.get("models_dir") or join_path(workspace, "models"), root)

    mindscience_root = cfg.get("mindscience_root") or join_path(models_dir, "mindscience")
    mindscience_root = resolve_workspace_value(mindscience_root, root)
    app_dir = cfg.get("app_dir")
    if not app_dir and mindscience_root:
        app_dir = join_path(mindscience_root, "MindSPONGE", "applications")
    app_dir = resolve_workspace_value(app_dir, root)

    rf_dir = cfg.get("rf_diffusion_dir") or (join_path(app_dir, "rf_diffusion") if app_dir else "")
    proteinmpnn_dir = cfg.get("proteinmpnn_dir") or (join_path(app_dir, "proteinmpnn") if app_dir else "")
    protenix_dir = cfg.get("protenix_dir") or (join_path(app_dir, "protenix") if app_dir else "")
    rf_dir = resolve_workspace_value(rf_dir, root)
    proteinmpnn_dir = resolve_workspace_value(proteinmpnn_dir, root)
    protenix_dir = resolve_workspace_value(protenix_dir, root)

    python_bin = discover_python() or cfg.get("python")
    pipeline_env = cfg.get("pipeline_env", "")
    rf_ckpt = cfg.get("ckpt") or (join_path(rf_dir, "models", "RFdiffusion_Ab.ckpt") if rf_dir else "")
    protenix_ckpt = cfg.get("protenix_ckpt") or (
        join_path(protenix_dir, "release_data", "checkpoint", "ms_model_v0.5.0.ckpt") if protenix_dir else ""
    )
    proteinmpnn_ckpt = (
        join_path(proteinmpnn_dir, "weights", "vanilla_model_weights", "v_48_020.ckpt")
        if proteinmpnn_dir else ""
    )
    rf_ckpt = resolve_workspace_value(rf_ckpt, root)
    protenix_ckpt = resolve_workspace_value(protenix_ckpt, root)
    proteinmpnn_ckpt = resolve_workspace_value(proteinmpnn_ckpt, root)
    hmmer_home = resolve_workspace_value(cfg.get("hmmer_home", ""), root)
    cann_set_env = cfg.get("cann_set_env", "")

    target_pdb = resolve_workspace_value(cfg.get("target_pdb", ""), root)
    framework_pdb = resolve_workspace_value(cfg.get("framework_pdb", ""), root)

    run_name = cfg.get("run_name") or f"antibody_custom_{cfg.get('num_designs', 0)}_{time.strftime('%Y%m%d_%H%M%S')}"
    run_dir = resolve_workspace_value(cfg.get("run_dir") or join_path(workspace, "runs", run_name), root)

    resolved = dict(cfg)
    resolved.update({
        "workspace": workspace,
        "scripts_dir": posix_path(cfg.get("scripts_dir") or default_scripts_dir()),
        "models_dir": models_dir,
        "mindscience_root": mindscience_root,
        "app_dir": app_dir,
        "rf_diffusion_dir": rf_dir,
        "proteinmpnn_dir": proteinmpnn_dir,
        "protenix_dir": protenix_dir,
        "python": posix_path(python_bin),
        "pipeline_env": posix_path(pipeline_env) if pipeline_env else "",
        "ckpt": rf_ckpt,
        "protenix_ckpt": protenix_ckpt,
        "proteinmpnn_ckpt": proteinmpnn_ckpt,
        "hmmer_home": hmmer_home,
        "cann_set_env": posix_path(cann_set_env) if cann_set_env else "",
        "target_pdb": target_pdb,
        "framework_pdb": framework_pdb,
        "run_name": run_name,
        "run_dir": run_dir,
        "hotspots": normalize_hotspots(cfg.get("hotspots")),
        "design_loops": cfg.get("design_loops") or "[H1:8,H2:6,H3:16]",
        "num_designs": int(cfg.get("num_designs", 0)),
        "npus": str(cfg.get("npus", "0")),
        "workers_per_npu": int(cfg.get("workers_per_npu", 2)),
        "final_step": int(cfg.get("final_step", 160)),
        "diffuser_t": int(cfg.get("diffuser_t", 200)),
        "protenix_use_msa": bool(cfg.get("protenix_use_msa", env_bool("PROTENIX_USE_MSA", False))),
        "protenix_n_sample": int(cfg.get("protenix_n_sample", env_or_empty("PROTENIX_N_SAMPLE") or 1)),
        "protenix_seeds": str(cfg.get("protenix_seeds", env_or_empty("PROTENIX_SEEDS") or "42")),
        "force": bool(cfg.get("force", False)),
    })
    return resolved


def validate_format(cfg: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if int(cfg.get("num_designs", 0)) < 1:
        errors.append("num_designs must be positive")
    run_name = str(cfg.get("run_name") or "")
    if run_name and not re.fullmatch(r"[A-Za-z0-9._-]+", run_name):
        errors.append("run_name must contain only letters, digits, dot, underscore, and hyphen")
    if not re.fullmatch(r"[0-9]+(,[0-9]+)*", str(cfg.get("npus", ""))):
        errors.append("npus must look like 0,1,2,3")
    if not re.fullmatch(r"\[[A-Za-z][0-9]+(,[A-Za-z][0-9]+)*\]", str(cfg.get("hotspots", ""))):
        errors.append("hotspots must look like A13,A14 or [A13,A14]")
    if not re.fullmatch(r"\[[HL][1-3]:[0-9]+(-[0-9]+)?(,[HL][1-3]:[0-9]+(-[0-9]+)?)*\]", str(cfg.get("design_loops", ""))):
        errors.append("design_loops must look like [H1:8,H2:6,H3:12-16]")
    if int(cfg.get("diffuser_t", 0)) < 15:
        errors.append("diffuser_t must be at least 15 for RFdiffusion")
    return errors


def validate_paths(cfg: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    required_dirs = ["app_dir", "rf_diffusion_dir", "proteinmpnn_dir", "protenix_dir"]
    required_files = ["target_pdb", "framework_pdb", "ckpt", "proteinmpnn_ckpt", "protenix_ckpt"]
    for key in required_dirs:
        value = cfg.get(key, "")
        if not value:
            errors.append(f"{key} is unresolved")
        elif not Path(value).is_dir():
            errors.append(f"{key} does not exist or is not a directory: {value}")
    for key in required_files:
        value = cfg.get(key, "")
        if not value:
            errors.append(f"{key} is unresolved")
        elif not Path(value).is_file():
            errors.append(f"{key} does not exist or is not a file: {value}")
    errors.extend(hotspot_target_errors(cfg))
    rf_diffusion_dir = Path(cfg.get("rf_diffusion_dir", ""))
    sharker_init = rf_diffusion_dir / "env" / "sharker" / "__init__.py"
    if rf_diffusion_dir.is_dir() and not sharker_init.is_file():
        errors.append(f"RFdiffusion sharker package does not exist: {sharker_init.parent}")
    mindscience_root = Path(cfg.get("mindscience_root", ""))
    if (mindscience_root / RF_DIFFUSION_IO_TARGET).is_file():
        errors.extend(rfdiffusion_io_patch_errors(mindscience_root))
    python_bin = cfg.get("python", "")
    if not python_bin or not Path(python_bin).exists():
        errors.append(f"python does not exist: {python_bin}")
    errors.extend(managed_python_errors(cfg))
    errors.extend(managed_pipeline_env_errors(cfg))
    hmmer_home = Path(cfg.get("hmmer_home", ""))
    if cfg.get("protenix_use_msa") and not ((hmmer_home / "hmmscan").exists() or (hmmer_home / "bin" / "hmmscan").exists() or shutil.which("hmmscan")):
        warnings.append(f"hmmscan not found under hmmer_home or PATH: {hmmer_home}")
    if cfg.get("cann_set_env") and not Path(cfg["cann_set_env"]).exists():
        warnings.append(f"cann_set_env configured but not found: {cfg['cann_set_env']}")
    if cfg.get("pipeline_env") and not Path(cfg["pipeline_env"]).exists():
        warnings.append(f"pipeline_env configured but not found: {cfg['pipeline_env']}")
    return errors, warnings


def sharker_import_errors(cfg: dict[str, Any]) -> list[str]:
    """Verify that the selected Python resolves sharker through RFdiffusion env."""
    python_bin = str(cfg.get("python", "")).strip()
    rf_diffusion_dir = Path(cfg.get("rf_diffusion_dir", ""))
    sharker_init = rf_diffusion_dir / "env" / "sharker" / "__init__.py"
    if not executable_file(python_bin) or not sharker_init.is_file():
        return []
    app_dir = Path(cfg.get("app_dir", ""))
    python_path = [str(app_dir.parent.parent), str(rf_diffusion_dir / "env")]
    inherited = os.environ.get("PYTHONPATH", "")
    if inherited:
        python_path.append(inherited)
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(python_path)
    try:
        probe = subprocess.run(
            [python_bin, "-c", "import sharker; print(sharker.__file__)"],
            cwd=rf_diffusion_dir,
            env=environment,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return [f"RFdiffusion sharker import probe could not run: {error}"]
    if probe.returncode == 0:
        return []
    detail = (probe.stderr or probe.stdout).strip().splitlines()
    tail = detail[-1] if detail else f"exit code {probe.returncode}"
    return [f"RFdiffusion sharker import failed with selected Python: {tail}"]


def print_clone_hint(cfg: dict[str, Any]) -> None:
    dst = join_path(cfg["models_dir"], "mindscience")
    print("Clone the pinned MindScience source into the Runner workspace:")
    print("  mkdir -p " + shlex.quote(cfg["models_dir"]))
    print("  git clone " + shlex.quote(MINDSCIENCE_REPO_URL) + " " + shlex.quote(dst))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_matches(path: Path, *, size: int, sha256: str) -> bool:
    return path.is_file() and path.stat().st_size == size and sha256_file(path) == sha256


def download_file(url: str, destination: Path, *, size: int, sha256: str) -> None:
    if file_matches(destination, size=size, sha256=sha256):
        print(f"Verified existing checkpoint: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".part")
    tmp.unlink(missing_ok=True)
    print(f"Downloading {url} -> {destination}")
    try:
        with urllib.request.urlopen(url) as response, tmp.open("wb") as handle:
            shutil.copyfileobj(response, handle, length=1024 * 1024)
        actual_size = tmp.stat().st_size
        actual_sha256 = sha256_file(tmp)
        if actual_size != size or actual_sha256 != sha256:
            raise RuntimeError(
                f"checkpoint verification failed for {url}: "
                f"size={actual_size} sha256={actual_sha256}"
            )
        tmp.replace(destination)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def clone_mindscience(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Cloning MindScience {MINDSCIENCE_REF} into workspace: {destination}")
    subprocess.run(
        [
            "git", "clone", "--filter=blob:none", "--no-checkout",
            MINDSCIENCE_REPO_URL, str(destination),
        ],
        check=True,
    )
    ensure_mindscience_checkout(destination)


def ensure_mindscience_checkout(destination: Path) -> None:
    """Verify an existing checkout and leave it detached at the pinned ref."""
    if not destination.is_dir():
        raise RuntimeError(f"MindScience path exists but is not a directory: {destination}")
    try:
        inside = subprocess.run(
            ["git", "-C", str(destination), "rev-parse", "--is-inside-work-tree"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
        current = subprocess.run(
            ["git", "-C", str(destination), "rev-parse", "HEAD"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            f"existing MindScience path is not a valid Git checkout: {destination}"
        ) from error

    if inside != "true":
        raise RuntimeError(f"existing MindScience path is not a Git worktree: {destination}")
    detached = subprocess.run(
        ["git", "-C", str(destination), "symbolic-ref", "-q", "HEAD"],
        text=True,
        capture_output=True,
    ).returncode != 0
    if current == MINDSCIENCE_REF and detached:
        print(f"Verified existing MindScience checkout: {destination} @ {current}")
        return

    has_pin = subprocess.run(
        ["git", "-C", str(destination), "cat-file", "-e", f"{MINDSCIENCE_REF}^{{commit}}"],
        text=True,
        capture_output=True,
    ).returncode == 0
    if not has_pin:
        print(f"Fetching pinned MindScience revision {MINDSCIENCE_REF}")
        subprocess.run(
            [
                "git", "-C", str(destination), "fetch", "--depth", "1",
                MINDSCIENCE_REPO_URL, MINDSCIENCE_REF,
            ],
            check=True,
        )
    print(f"Checking out pinned MindScience revision: {current} -> {MINDSCIENCE_REF}")
    subprocess.run(
        ["git", "-C", str(destination), "checkout", "--detach", MINDSCIENCE_REF],
        check=True,
    )
    verified = subprocess.run(
        ["git", "-C", str(destination), "rev-parse", "HEAD"],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if verified != MINDSCIENCE_REF:
        raise RuntimeError(
            f"MindScience checkout verification failed: expected {MINDSCIENCE_REF}, got {verified}"
        )


def git_patch_check(repository: Path, patch: Path, *, reverse: bool = False) -> subprocess.CompletedProcess[str]:
    patch_text = patch.read_text(encoding="utf-8").replace("\r\n", "\n")
    command = ["git", "-C", str(repository), "apply"]
    if reverse:
        command.append("--reverse")
    command.extend(["--check", "-"])
    return subprocess.run(command, input=patch_text, text=True, capture_output=True)


def rfdiffusion_io_patch_errors(
    mindscience_root: Path,
    patch: Path = RF_DIFFUSION_IO_PATCH,
) -> list[str]:
    """Return a preflight error unless the pinned RFdiffusion I/O patch is present."""
    if not patch.is_file():
        return [f"bundled RFdiffusion MindSpore I/O patch does not exist: {patch}"]
    if git_patch_check(mindscience_root, patch, reverse=True).returncode == 0:
        return []
    return [
        "RFdiffusion MindSpore PDB writer compatibility patch is not applied; "
        "run the Skill preparation step before validation or model launch"
    ]


def apply_rfdiffusion_io_patch(
    mindscience_root: Path,
    patch: Path = RF_DIFFUSION_IO_PATCH,
) -> None:
    """Apply the verified 131 RFdiffusion Tensor-to-PDB compatibility patch."""
    if not patch.is_file():
        raise RuntimeError(f"bundled RFdiffusion MindSpore I/O patch does not exist: {patch}")
    if git_patch_check(mindscience_root, patch, reverse=True).returncode == 0:
        print(f"Verified existing RFdiffusion MindSpore I/O patch: {RF_DIFFUSION_IO_TARGET}")
        return

    applicable = git_patch_check(mindscience_root, patch)
    if applicable.returncode != 0:
        detail = (applicable.stderr or applicable.stdout).strip()
        raise RuntimeError(
            "RFdiffusion MindSpore I/O patch does not match the pinned MindScience source"
            + (f": {detail}" if detail else "")
        )
    patch_text = patch.read_text(encoding="utf-8").replace("\r\n", "\n")
    subprocess.run(
        ["git", "-C", str(mindscience_root), "apply", "-"],
        input=patch_text,
        text=True,
        check=True,
    )
    if git_patch_check(mindscience_root, patch, reverse=True).returncode != 0:
        raise RuntimeError("RFdiffusion MindSpore I/O patch verification failed after apply")
    print(f"Applied RFdiffusion MindSpore I/O patch: {RF_DIFFUSION_IO_TARGET}")


def clone_sharker_source(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Cloning RFdiffusion sharker source {SHARKER_REF} into workspace: {destination}")
    subprocess.run(
        ["git", "clone", "--no-checkout", SHARKER_REPO_URL, str(destination)],
        check=True,
    )
    ensure_sharker_checkout(destination)


def ensure_sharker_checkout(destination: Path) -> None:
    """Verify the RFdiffusion helper checkout and leave it at the pinned ref."""
    if not destination.is_dir():
        raise RuntimeError(f"sharker source path exists but is not a directory: {destination}")
    try:
        inside = subprocess.run(
            ["git", "-C", str(destination), "rev-parse", "--is-inside-work-tree"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
        current = subprocess.run(
            ["git", "-C", str(destination), "rev-parse", "HEAD"],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            f"existing sharker source path is not a valid Git checkout: {destination}"
        ) from error

    if inside != "true":
        raise RuntimeError(f"existing sharker source path is not a Git worktree: {destination}")
    detached = subprocess.run(
        ["git", "-C", str(destination), "symbolic-ref", "-q", "HEAD"],
        text=True,
        capture_output=True,
    ).returncode != 0
    if current == SHARKER_REF and detached:
        print(f"Verified existing sharker source checkout: {destination} @ {current}")
        return

    has_pin = subprocess.run(
        ["git", "-C", str(destination), "cat-file", "-e", f"{SHARKER_REF}^{{commit}}"],
        text=True,
        capture_output=True,
    ).returncode == 0
    if not has_pin:
        print(f"Fetching pinned sharker source revision {SHARKER_REF}")
        subprocess.run(
            [
                "git", "-C", str(destination), "fetch", "--depth", "1",
                SHARKER_REPO_URL, SHARKER_REF,
            ],
            check=True,
        )
    print(f"Checking out pinned sharker source revision: {current} -> {SHARKER_REF}")
    subprocess.run(
        ["git", "-C", str(destination), "checkout", "--detach", SHARKER_REF],
        check=True,
    )
    verified = subprocess.run(
        ["git", "-C", str(destination), "rev-parse", "HEAD"],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if verified != SHARKER_REF:
        raise RuntimeError(
            f"sharker source checkout verification failed: expected {SHARKER_REF}, got {verified}"
        )


def install_sharker(source_checkout: Path, destination: Path) -> None:
    """Install the pinned source package into RFdiffusion's expected env path."""
    source = source_checkout / "sharker"
    if not (source / "__init__.py").is_file():
        raise RuntimeError(f"sharker package is missing from pinned source checkout: {source}")

    marker_name = ".sciencediscovery-source.json"
    marker = destination / marker_name
    expected_marker = {"repository": SHARKER_REPO_URL, "revision": SHARKER_REF}
    if (destination / "__init__.py").is_file() and marker.is_file():
        try:
            if read_json(marker) == expected_marker:
                print(f"Verified existing RFdiffusion sharker package: {destination}")
                return
        except (OSError, json.JSONDecodeError, SystemExit):
            pass

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    if temporary.exists():
        shutil.rmtree(temporary)
    try:
        shutil.copytree(source, temporary)
        write_json(temporary / marker_name, expected_marker)
        if destination.exists():
            shutil.rmtree(destination)
        temporary.replace(destination)
    except BaseException:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
    print(f"Installed pinned RFdiffusion sharker package: {destination}")


def prepare_sharker(cfg: dict[str, Any]) -> None:
    source_checkout = Path(cfg["models_dir"]) / "gnn-sharker"
    if source_checkout.exists():
        ensure_sharker_checkout(source_checkout)
    else:
        clone_sharker_source(source_checkout)
    destination = Path(cfg["rf_diffusion_dir"]) / "env" / "sharker"
    install_sharker(source_checkout, destination)


def prepare_cmd(args: argparse.Namespace) -> int:
    cfg_path = args.config
    raw = read_json(cfg_path)
    cfg = resolve_config(raw)
    errors = sandbox_config_errors(raw, cfg) + validate_format(cfg) + validate_paths(cfg)[0]
    app_missing = any("app_dir" in item or "rf_diffusion_dir" in item or "proteinmpnn_dir" in item or "protenix_dir" in item for item in errors)

    if app_missing and args.clone_missing:
        clone_dst = Path(join_path(cfg["models_dir"], "mindscience"))
        if clone_dst.exists():
            ensure_mindscience_checkout(clone_dst)
        else:
            clone_dst.parent.mkdir(parents=True, exist_ok=True)
            clone_mindscience(clone_dst)
        raw["mindscience_root"] = clone_dst.resolve().relative_to(workspace_root_path()).as_posix()
        write_json(cfg_path, raw)
        cfg = resolve_config(raw)
        errors = sandbox_config_errors(raw, cfg) + validate_format(cfg) + validate_paths(cfg)[0]
    elif app_missing:
        print_clone_hint(cfg)

    if Path(cfg["rf_diffusion_dir"]).is_dir() and args.clone_missing:
        apply_rfdiffusion_io_patch(Path(cfg["mindscience_root"]))
        prepare_sharker(cfg)
        errors = sandbox_config_errors(raw, cfg) + validate_format(cfg) + validate_paths(cfg)[0]
    elif Path(cfg["rf_diffusion_dir"]).is_dir() and not (
        Path(cfg["rf_diffusion_dir"]) / "env" / "sharker" / "__init__.py"
    ).is_file():
        print(
            "RFdiffusion requires sharker; rerun preparation with --clone-missing "
            f"to fetch pinned source from {SHARKER_REPO_URL}"
        )

    missing_checkpoints = {
        "ckpt": RF_DIFFUSION_CKPT,
        "proteinmpnn_ckpt": PROTEINMPNN_CKPT,
        "protenix_ckpt": PROTENIX_CKPT,
    }
    if args.download_missing:
        for key, metadata in missing_checkpoints.items():
            destination = Path(cfg[key])
            if not file_matches(
                destination,
                size=int(metadata["size"]),
                sha256=str(metadata["sha256"]),
            ):
                download_file(
                    str(metadata["url"]),
                    destination,
                    size=int(metadata["size"]),
                    sha256=str(metadata["sha256"]),
                )
        cfg = resolve_config(raw)
        errors = sandbox_config_errors(raw, cfg) + validate_format(cfg) + validate_paths(cfg)[0]

    if errors:
        print("Prepare did not complete; remaining errors:")
        for item in errors:
            print(f"  - {item}")
        return 2
    print("Prepare complete: model code paths resolved.")
    return 0


def command_for_full_run(cfg: dict[str, Any]) -> list[str]:
    scripts_dir = cfg.get("scripts_dir") or default_scripts_dir()
    helper = join_path(scripts_dir, "run_full_antibody_pipeline.sh")
    cmd = [
        "bash", helper,
        "--run-dir", cfg["run_dir"],
        "--num-designs", str(cfg["num_designs"]),
        "--app-dir", cfg["app_dir"],
        "--scripts-dir", scripts_dir,
        "--python", cfg["python"],
        "--npus", cfg["npus"],
        "--workers-per-npu", str(cfg["workers_per_npu"]),
        "--target-pdb", cfg["target_pdb"],
        "--framework-pdb", cfg["framework_pdb"],
        "--ckpt", cfg["ckpt"],
        "--hotspots", cfg["hotspots"],
        "--design-loops", cfg["design_loops"],
        "--final-step", str(cfg["final_step"]),
        "--diffuser-t", str(cfg["diffuser_t"]),
        "--protenix-dir", cfg["protenix_dir"],
        "--protenix-ckpt", cfg["protenix_ckpt"],
        "--protenix-use-msa", "true" if cfg.get("protenix_use_msa") else "false",
        "--protenix-n-sample", str(cfg["protenix_n_sample"]),
        "--protenix-seeds", cfg["protenix_seeds"],
    ]
    if cfg.get("hmmer_home"):
        cmd.extend(["--hmmer-home", cfg["hmmer_home"]])
    if cfg.get("cann_set_env"):
        cmd.extend(["--cann-set-env", cfg["cann_set_env"]])
    if cfg.get("pipeline_env"):
        cmd.extend(["--pipeline-env", cfg["pipeline_env"]])
    if cfg.get("force"):
        cmd.append("--force")
    return cmd


def quarantine_incompatible_numpy_caches(
    cfg: dict[str, Any], *, numpy_major: int | None = None,
) -> list[tuple[Path, Path]]:
    """Move NumPy-2 RFdiffusion pickles aside when the selected env uses NumPy 1.

    RFdiffusion stores IGSO3 schedules beside its model code. Those files are
    derived caches, but a NumPy-2 pickle imports ``numpy._core`` and fails under
    the NumPy-1 environment required by this pipeline. Preserve the original
    with a descriptive suffix and let RFdiffusion rebuild the active cache.
    """
    if numpy_major is None:
        try:
            import numpy as np
            numpy_major = int(np.__version__.split(".", 1)[0])
        except (ImportError, ValueError):
            return []
    if numpy_major >= 2:
        return []
    schedules = Path(cfg["rf_diffusion_dir"]) / "schedules"
    moved: list[tuple[Path, Path]] = []
    for cache in sorted(schedules.glob(f"T_{cfg['diffuser_t']}_*.pkl")):
        # Quarantines deliberately retain the incompatible pickle for audit and
        # rollback. Do not quarantine those files again on every run merely
        # because their names still match the broad RFdiffusion cache pattern.
        if ".numpy2-incompatible" in cache.stem:
            continue
        with cache.open("rb") as handle:
            incompatible = any(b"numpy._core" in chunk for chunk in iter(lambda: handle.read(1024 * 1024), b""))
        if not incompatible:
            continue
        quarantine = cache.with_name(f"{cache.stem}.numpy2-incompatible.pkl")
        if quarantine.exists():
            quarantine = cache.with_name(
                f"{cache.stem}.numpy2-incompatible-{time.strftime('%Y%m%d-%H%M%S')}.pkl"
            )
        cache.replace(quarantine)
        moved.append((cache, quarantine))
    return moved


def init_cmd(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace)
    (workspace / "helpers").mkdir(parents=True, exist_ok=True)
    (workspace / "inputs").mkdir(parents=True, exist_ok=True)
    (workspace / "models").mkdir(parents=True, exist_ok=True)
    (workspace / "runs").mkdir(parents=True, exist_ok=True)
    target_pdb = posix_path(args.target_pdb) if args.target_pdb else ""
    framework_pdb = posix_path(args.framework_pdb) if args.framework_pdb else ""
    cfg = {
        "workspace": posix_path(workspace),
        "num_designs": args.num_designs,
        "run_name": args.run_name or "",
        "target_pdb": target_pdb,
        "framework_pdb": framework_pdb,
        "force": False,
    }
    path = workspace / "config.json"
    write_json(path, cfg)
    print(f"Wrote config: {path}")
    return 0


def validate_cmd(args: argparse.Namespace) -> int:
    raw = read_json(args.config)
    cfg = resolve_config(raw)
    format_errors = validate_format(cfg)
    path_errors, warnings = validate_paths(cfg)
    errors = sandbox_config_errors(raw, cfg) + format_errors + path_errors
    if not path_errors:
        errors.extend(sharker_import_errors(cfg))
    print("Antibody pipeline validation")
    print(f"  valid: {not errors}")
    for key in ["workspace", "scripts_dir", "mindscience_root", "app_dir", "rf_diffusion_dir", "proteinmpnn_dir", "protenix_dir", "python", "pipeline_env", "ckpt", "proteinmpnn_ckpt", "protenix_ckpt", "target_pdb", "framework_pdb", "run_dir", "protenix_use_msa", "protenix_n_sample", "protenix_seeds"]:
        print(f"  {key}: {cfg.get(key, '')}")
    if warnings:
        print("Warnings:")
        for item in warnings:
            print(f"  - {item}")
    if errors:
        print("Errors:")
        for item in errors:
            print(f"  - {item}")
        if any("app_dir" in item or "rf_diffusion_dir" in item for item in errors):
            print_clone_hint(cfg)
    return 0 if not errors else 2


def run_cmd(args: argparse.Namespace) -> int:
    raw = read_json(args.config)
    cfg = resolve_config(raw)
    path_errors, warnings = validate_paths(cfg)
    errors = sandbox_config_errors(raw, cfg) + validate_format(cfg) + path_errors
    if not path_errors:
        errors.extend(sharker_import_errors(cfg))
    for item in warnings:
        print(f"WARNING: {item}", file=sys.stderr)
    if errors:
        for item in errors:
            print(f"ERROR: {item}", file=sys.stderr)
        return 2
    for cache, quarantine in quarantine_incompatible_numpy_caches(cfg):
        print(
            f"WARNING: moved NumPy-2 RFdiffusion cache {cache} to {quarantine}; "
            "the selected environment will rebuild it",
            file=sys.stderr,
        )
    cmd = command_for_full_run(cfg)
    print("Launching sandbox pipeline:", flush=True)
    print("  " + " ".join(shlex.quote(item) for item in cmd), flush=True)
    os.execvp(cmd[0], cmd)
    return 127


ERROR_PATTERNS = (
    "Traceback (most recent call last)",
    "ERROR:",
    "Error:",
    "error:",
    "FATAL",
    "No module named",
    "ModuleNotFoundError",
    "ImportError",
    "CUDA out of memory",
    "OOM",
    "NPU out of memory",
    "RuntimeError",
    "hmmscan: command not found",
    "Permission denied",
    "No such file or directory",
)

def report_paths(run: Path) -> list[Path]:
    return [
        run / "05_screening" / "protenix_screening_report.md",
    ]


def artifact_paths(run: Path) -> list[Path]:
    paths: list[Path] = []
    paths.extend(report_paths(run))
    paths.extend([
        run / "05_screening" / "protenix_screening_summary.csv",
    ])
    structure_root = run / "04_protenix_output"
    if structure_root.exists():
        paths.extend(sorted(structure_root.rglob("*.cif")))
    summary = run / "05_screening" / "protenix_screening_summary.csv"
    if summary.exists():
        with summary.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                cif = row.get("protenix_model_cif", "")
                if cif:
                    paths.append(Path(cif))
    seen: set[str] = set()
    existing: list[Path] = []
    for path in paths:
        key = str(path)
        if key in seen or not path.exists():
            continue
        seen.add(key)
        existing.append(path)
    return existing


def artifact_manifest_cmd(args: argparse.Namespace) -> int:
    cfg = resolve_config(read_json(args.config))
    workspace = Path(cfg["workspace"]).resolve()
    manifest = args.output or (workspace / "artifact_manifest.txt")
    paths = []
    for path in artifact_paths(Path(cfg["run_dir"])):
        try:
            paths.append(path.resolve().relative_to(workspace).as_posix())
        except ValueError:
            paths.append(str(path.resolve()))
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("\n".join(paths) + ("\n" if paths else ""), encoding="utf-8")
    print(f"Wrote artifact manifest: {manifest}")
    print(f"Artifacts: {len(paths)}")
    return 0


def collect_counts(run: Path) -> dict[str, int]:
    return {
        "rf_pdb": len(list((run / "01_rfdiffusion").glob("output_*.pdb"))),
        "proteinmpnn_pdb": len(list((run / "02_proteinmpnn").glob("*_dldesign_0.pdb"))),
        "protenix_json": len([path for path in (run / "03_protenix_input_json").glob("*.json") if not path.name.endswith(".chain_map.json")]),
        "protenix_confidence": len(list((run / "04_protenix_output").rglob("*summary_confidence_sample_*.json"))),
    }


def infer_stage(counts: dict[str, int], expected: int, reports_ok: bool) -> str:
    if counts["rf_pdb"] < expected:
        return "rfdiffusion"
    if counts["proteinmpnn_pdb"] < expected:
        return "proteinmpnn"
    if counts["protenix_json"] < expected:
        return "protenix_json"
    if counts["protenix_confidence"] < expected:
        return "protenix"
    if not reports_ok:
        return "screening"
    return "complete"


def read_tail(path: Path, max_bytes: int = 12000) -> str:
    if not path.is_file():
        return ""
    data = path.read_bytes()
    if len(data) > max_bytes:
        data = data[-max_bytes:]
    return data.decode("utf-8", errors="replace")


def scan_logs_for_errors(run: Path, limit: int = 12) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    log_roots = [run / "logs", run / "01_rfdiffusion" / "logs", run / "04_protenix_output" / "logs"]
    files: list[Path] = []
    for root in log_roots:
        if root.is_file():
            files.append(root)
        elif root.is_dir():
            files.extend(sorted(root.rglob("*.log")))
    for path in files[-40:]:
        text = read_tail(path)
        if not text:
            continue
        lines = text.splitlines()
        for idx, line in enumerate(lines):
            if any(pattern in line for pattern in ERROR_PATTERNS):
                start = max(0, idx - 1)
                end = min(len(lines), idx + 3)
                snippet = "\n".join(lines[start:end])
                hits.append({"log": posix_path(path), "snippet": snippet})
                break
        if len(hits) >= limit:
            break
    return hits


def recovery_hints(errors: list[dict[str, str]], stage: str) -> list[str]:
    hints: list[str] = []
    blob = "\n".join(item.get("snippet", "") for item in errors).lower()
    if stage != "complete":
        hints.append(
            f"Pipeline outputs stopped before stage={stage} completed. Inspect the original managed "
            "Shell Execution status and logs; do not replay a running or unknown execution."
        )
    if "no module named" in blob or "modulenotfounderror" in blob or "importerror" in blob:
        hints.append(
            "Missing Python import. Install the missing package into the ScienceDiscovery managed "
            "scientific environment, then rerun using that environment revision id."
        )
    if "hmmscan" in blob:
        hints.append(
            "HMMER issue. Ensure HMMER_HOME/bin is on PATH when Protenix MSA is enabled."
        )
    if "out of memory" in blob or "oom" in blob:
        hints.append("Resource exhaustion. Reduce --workers-per-npu / --npus concurrency and resume from the failed stage.")
    if "no such file" in blob or "permission denied" in blob:
        hints.append("Path/permission failure. Re-validate config paths and ensure run_dir is writable by the pipeline user.")
    if not hints and errors:
        hints.append("Inspect the newest error snippet logs above; fix the first failing stage before restarting later stages.")
    return hints


def collect_snapshot(cfg: dict[str, Any]) -> dict[str, Any]:
    run = Path(cfg["run_dir"])
    expected = int(cfg["num_designs"])
    counts = collect_counts(run)
    reports = report_paths(run)
    reports_ok = all(path.exists() for path in reports)
    stage = infer_stage(counts, expected, reports_ok)
    errors = scan_logs_for_errors(run)
    complete = stage == "complete"
    progress = {
        key: {"have": counts[key], "expected": expected, "pct": int(100 * counts[key] / expected) if expected else 0}
        for key in counts
    }
    return {
        "run_dir": posix_path(run),
        "expected": expected,
        "stage": stage,
        "complete": complete,
        "counts": counts,
        "progress": progress,
        "reports": [{"path": posix_path(path), "ok": path.exists()} for path in reports],
        "errors": errors,
        "recovery_hints": recovery_hints(errors, stage),
    }


def print_snapshot(snap: dict[str, Any], *, quiet: bool = False) -> None:
    print("Run status")
    print(f"  run_dir: {snap['run_dir']}")
    print(f"  stage: {snap['stage']}")
    print(f"  expected: {snap['expected']}")
    for key, meta in snap["progress"].items():
        print(f"  {key}: {meta['have']}/{meta['expected']} ({meta['pct']}%)")
    print(f"  complete: {snap['complete']}")
    if not quiet:
        print("  reports:")
        for item in snap["reports"]:
            print(f"    {'OK' if item['ok'] else 'MISSING'} {item['path']}")
    if snap["errors"]:
        print("  recent_errors:")
        for item in snap["errors"][:3]:
            print(f"    log: {item['log']}")
            for line in item["snippet"].splitlines()[:8]:
                print(f"      {line}")
    if snap["recovery_hints"]:
        print("  recovery_hints:")
        for hint in snap["recovery_hints"]:
            print(f"    - {hint}")


def status_cmd(args: argparse.Namespace) -> int:
    cfg = resolve_config(read_json(args.config))
    snap = collect_snapshot(cfg)
    print_snapshot(snap)
    if args.json:
        print(json.dumps(snap, indent=2))
    return 0 if snap["complete"] else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--workspace", default="antibody_pipeline")
    p.add_argument("--num-designs", type=int, required=True)
    p.add_argument("--run-name", default="")
    p.add_argument("--target-pdb", default="")
    p.add_argument("--framework-pdb", default="")
    p.set_defaults(func=init_cmd)

    p = sub.add_parser("validate")
    p.add_argument("--config", type=Path, required=True)
    p.set_defaults(func=validate_cmd)

    p = sub.add_parser("prepare")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--clone-missing", action="store_true")
    p.add_argument("--download-missing", action="store_true")
    p.set_defaults(func=prepare_cmd)

    p = sub.add_parser("run")
    p.add_argument("--config", type=Path, required=True)
    p.set_defaults(func=run_cmd)

    p = sub.add_parser("status")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=status_cmd)

    p = sub.add_parser("artifact-manifest")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--output", type=Path)
    p.set_defaults(func=artifact_manifest_cmd)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
