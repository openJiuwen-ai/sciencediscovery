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

"""Workspace-normalizing adapter for allowlisted antibody manager entrypoints."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys


manager_path = sys.argv[1]
config_path = sys.argv[2]
workspace_root = Path(sys.argv[3]).resolve()


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_existing_or_parent(path: Path) -> Path:
    if path.exists():
        return path.resolve()
    return path.parent.resolve() / path.name


def _resolve_workspace_path(value, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return value
    text = value.strip()
    if text == "/workspace":
        candidate = workspace_root
    elif text.startswith("/workspace/"):
        candidate = workspace_root / text[len("/workspace/"):]
    elif text.startswith("/"):
        candidate = Path(text)
    else:
        candidate = workspace_root / text
    resolved = _resolve_existing_or_parent(candidate)
    if not _is_relative_to(resolved, workspace_root):
        raise ValueError(f"{field} must resolve inside the Session workspace")
    return str(resolved)


def _resolve_read_asset_path(value, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return value
    text = value.strip()
    if text == "/workspace" or text.startswith("/workspace/") or not text.startswith("/"):
        return _resolve_workspace_path(text, field)
    resolved = _resolve_existing_or_parent(Path(text))
    allowed_roots = [workspace_root, _host_skill_root()]
    if not any(_is_relative_to(resolved, root.resolve()) for root in allowed_roots):
        allowed = ", ".join(str(root.resolve()) for root in allowed_roots)
        raise ValueError(f"{field} absolute path must be inside an allowlisted read root: {allowed}")
    return str(resolved)


def _read_asset_roots() -> list[Path]:
    return [workspace_root.resolve(), _host_skill_root().resolve()]


def _is_allowed_read_asset_value(value) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    text = value.strip()
    if text == "/workspace" or text.startswith("/workspace/") or not text.startswith("/"):
        try:
            resolved = Path(_resolve_workspace_path(text, "preset")).resolve()
        except ValueError:
            return False
    else:
        resolved = _resolve_existing_or_parent(Path(text))
    return any(_is_relative_to(resolved, root) for root in _read_asset_roots())


def _should_replace_preset_path(value) -> bool:
    if not isinstance(value, str) or not value.strip():
        return True
    try:
        resolved = Path(value).resolve() if Path(value).is_absolute() else Path(_resolve_workspace_path(value, "preset")).resolve()
    except ValueError:
        return True
    if not resolved.is_file():
        return True
    return not _is_allowed_read_asset_value(str(resolved))


def _workspace_input_candidate(workspace: Path, basename: str) -> str:
    candidates = [
        workspace / "inputs" / basename,
        workspace_root / "antibody_pipeline" / "inputs" / basename,
        workspace_root / basename,
    ]
    for candidate in candidates:
        resolved = candidate.resolve()
        if _is_relative_to(resolved, workspace_root) and resolved.is_file():
            return str(resolved)
    return ""


def _first_existing_path(candidates, want_dir=False, want_file=False) -> str:
    for candidate in candidates:
        path = Path(candidate)
        if want_dir and path.is_dir():
            return str(path.resolve())
        if want_file and path.is_file():
            return str(path.resolve())
        if not want_dir and not want_file and path.exists():
            return str(path.resolve())
    return ""


def _host_skill_root() -> Path:
    manager = Path(manager_path).resolve()
    if manager.parent.name in {"helpers", "scripts"}:
        return manager.parent.parent
    return manager.parent


def _host_scripts_dir() -> Path:
    root = _host_skill_root()
    scripts = root / "scripts"
    if scripts.is_dir():
        return scripts.resolve()
    if Path(manager_path).resolve().parent.is_dir():
        return Path(manager_path).resolve().parent
    return root.resolve()


def _operator_directory(env_name: str, fallbacks=()) -> str:
    configured = os.environ.get(env_name, "").strip()
    if configured:
        candidate = Path(configured)
        if not candidate.is_absolute():
            raise ValueError(f"{env_name} must be an absolute host path")
        if not candidate.is_dir():
            raise ValueError(f"{env_name} does not exist or is not a directory: {candidate}")
        return str(candidate.resolve())
    return _first_existing_path(fallbacks, want_dir=True)


def _operator_file(env_name: str, fallbacks=()) -> str:
    configured = os.environ.get(env_name, "").strip()
    if configured:
        candidate = Path(configured)
        if not candidate.is_absolute():
            raise ValueError(f"{env_name} must be an absolute host path")
        if not candidate.is_file():
            raise ValueError(f"{env_name} does not exist or is not a file: {candidate}")
        return str(candidate.resolve())
    return _first_existing_path(fallbacks, want_file=True)


def _apply_host_bundle_defaults(cfg):
    host_root = _host_skill_root()
    pipeline_home = _operator_directory("ANTIBODY_PIPELINE_HOME", [host_root])
    pipeline_root = Path(pipeline_home) if pipeline_home else None
    models_dir = _operator_directory("ANTIBODY_MODELS_DIR", [
        pipeline_root / "models" if pipeline_root else "",
    ])
    mindscience_root = _operator_directory("MINDSCIENCE_ROOT", [
        Path(models_dir) / "mindscience" if models_dir else "",
        pipeline_root / "models" / "mindscience" if pipeline_root else "",
    ])
    app_dir = _operator_directory("MINDSCIENCE_APP_DIR", [
        Path(mindscience_root) / "MindSPONGE" / "applications" if mindscience_root else "",
    ])
    rf_diffusion_dir = _operator_directory("ANTIBODY_RF_DIFFUSION_DIR", [
        Path(app_dir) / "rf_diffusion" if app_dir else "",
    ])
    proteinmpnn_dir = _operator_directory("ANTIBODY_PROTEINMPNN_DIR", [
        Path(app_dir) / "proteinmpnn" if app_dir else "",
    ])
    protenix_dir = _operator_directory("PROTENIX_APP_DIR", [
        Path(app_dir) / "protenix" if app_dir else "",
    ])
    defaults = {
        "models_dir": models_dir,
        "mindscience_root": mindscience_root,
        "app_dir": str(Path(app_dir).resolve()) if app_dir else "",
        "rf_diffusion_dir": rf_diffusion_dir,
        "proteinmpnn_dir": proteinmpnn_dir,
        "protenix_dir": protenix_dir,
        "ckpt": _operator_file("RF_DIFFUSION_CKPT", [
            Path(rf_diffusion_dir) / "models" / "RFdiffusion_Ab.ckpt" if rf_diffusion_dir else "",
        ]),
        "protenix_ckpt": _operator_file("PROTENIX_CKPT", [
            Path(protenix_dir) / "release_data" / "checkpoint" / "ms_model_v0.5.0.ckpt" if protenix_dir else "",
        ]),
        "protenix_ckpt_url": os.environ.get("PROTENIX_CKPT_URL", "").strip(),
        "hmmer_home": _operator_directory("HMMER_HOME", [
            pipeline_root / "tools" / "hmmer" if pipeline_root else "",
        ]),
        "cann_set_env": _operator_file("CANN_SET_ENV", [
            "/usr/local/Ascend/cann/set_env.sh",
            "/usr/local/Ascend/ascend-toolkit/set_env.sh",
        ]),
        "python": sys.executable,
        "scripts_dir": str(_host_scripts_dir()),
    }
    # Host model/runtime paths are deployment policy, not Agent-controlled input.
    # Remove any guessed config values and inject only operator environment values
    # (or deterministic paths derived from ANTIBODY_PIPELINE_HOME).
    for key in defaults:
        cfg.pop(key, None)
    for key, value in defaults.items():
        if value:
            cfg[key] = value
    return cfg


def _host_resource_candidate(preset_name: str, basename: str) -> str:
    if not preset_name or not basename:
        return ""
    bundle = _host_skill_root()
    candidates = [
        bundle / "resources" / "presets" / preset_name / basename,
        bundle / "helpers" / "resources" / "presets" / preset_name / basename,
        Path(manager_path).resolve().parent / "resources" / "presets" / preset_name / basename,
    ]
    return _first_existing_path(candidates, want_file=True)


def _copytree_contents(src, dst) -> None:
    src = Path(src)
    dst = Path(dst)
    if not src.is_dir():
        return
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        elif item.is_file():
            shutil.copy2(item, target)


def _ensure_workspace_bundle_files(workspace: Path) -> None:
    resolved_workspace = Path(workspace).resolve()
    if not _is_relative_to(resolved_workspace, workspace_root):
        return
    (resolved_workspace / "helpers").mkdir(parents=True, exist_ok=True)
    bundle = _host_skill_root()
    _copytree_contents(bundle / "resources", resolved_workspace / "helpers" / "resources")


def _normalize_workspace_config(raw):
    cfg = dict(raw)
    if not cfg.get("workspace"):
        cfg["workspace"] = str((workspace_root / "antibody_pipeline").resolve())
    else:
        cfg["workspace"] = _resolve_workspace_path(cfg["workspace"], "workspace")
    if cfg.get("run_dir"):
        cfg["run_dir"] = _resolve_workspace_path(cfg["run_dir"], "run_dir")
    for key in ("target_pdb", "framework_pdb"):
        if cfg.get(key):
            cfg[key] = _resolve_read_asset_path(cfg[key], key)
    return _apply_host_bundle_defaults(cfg)


def _sanitize_resolved_config(cfg):
    cfg = dict(cfg)
    cfg = _apply_host_bundle_defaults(cfg)
    if cfg.get("workspace"):
        cfg["workspace"] = _resolve_workspace_path(cfg["workspace"], "workspace")
    if cfg.get("run_dir"):
        cfg["run_dir"] = _resolve_workspace_path(cfg["run_dir"], "run_dir")
    for key in ("target_pdb", "framework_pdb"):
        if cfg.get(key):
            cfg[key] = _resolve_read_asset_path(cfg[key], key)
    return cfg


def _sanitize_command(cmd):
    if not isinstance(cmd, (list, tuple)) or not cmd:
        raise ValueError("manager.command_for_full_run must return a non-empty argv list")
    sanitized = [str(part) for part in cmd]
    workspace_helpers = (Path(str(cfg.get("workspace") or workspace_root)) / "helpers").resolve()
    host_scripts = _host_scripts_dir()
    for index, part in enumerate(sanitized):
        try:
            resolved = _resolve_existing_or_parent(Path(part))
        except Exception:
            continue
        if _is_relative_to(resolved, workspace_helpers):
            replacement = host_scripts / resolved.relative_to(workspace_helpers)
            if replacement.is_dir():
                sanitized[index] = str(replacement.resolve())
                continue
            if not replacement.is_file():
                raise ValueError(f"NPU workload host helper does not exist: {replacement}")
            sanitized[index] = str(replacement.resolve())
    for part in sanitized:
        try:
            resolved = _resolve_existing_or_parent(Path(part))
        except Exception:
            continue
        if _is_relative_to(resolved, workspace_helpers):
            raise ValueError(f"NPU workload command must not execute workspace helper files: {resolved}")
    return sanitized


STANDARD_ARTIFACT_PATTERNS = {
    "01_rfdiffusion": ("output_*.pdb", "output_*.trb"),
    "02_proteinmpnn": ("*.pdb", "*.fa", "*.fasta", "*.json", "*.csv", "*.txt", "*.npz"),
    "03_protenix_input_json": ("*.json", "*.a3m"),
    "04_protenix_output": ("*.cif", "*.json", "*.csv", "*.txt"),
    "05_screening": ("*.md", "*.csv", "*.fa", "*.fasta", "*.json", "*.txt"),
}


def _read_manifest_paths(manifest: Path, manifest_root: Path) -> set[Path]:
    paths: set[Path] = set()
    if not manifest.is_file():
        return paths
    for raw_line in manifest.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        candidate = Path(line) if Path(line).is_absolute() else manifest_root / line
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            continue
        if _is_relative_to(resolved, workspace_root):
            paths.add(resolved)
    return paths


def _collect_standard_artifacts(run_dir: Path) -> set[Path]:
    artifacts: set[Path] = set()
    if not run_dir.is_dir() or not _is_relative_to(run_dir.resolve(), workspace_root):
        return artifacts
    for relative_dir, patterns in STANDARD_ARTIFACT_PATTERNS.items():
        directory = run_dir / relative_dir
        if not directory.is_dir():
            continue
        for pattern in patterns:
            for path in directory.rglob(pattern):
                if path.is_file():
                    artifacts.add(path.resolve())
    return artifacts


def _write_artifact_manifest(cfg) -> None:
    workspace = Path(str(cfg.get("workspace") or workspace_root / "antibody_pipeline")).resolve()
    if not _is_relative_to(workspace, workspace_root):
        return
    run_dir_value = str(cfg.get("run_dir") or "").strip()
    if not run_dir_value:
        return
    run_dir = Path(run_dir_value).resolve()
    manifest = workspace / "artifact_manifest.txt"
    artifacts = _read_manifest_paths(manifest, workspace)
    artifacts.update(_collect_standard_artifacts(run_dir))
    manifest.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for path in sorted(artifacts, key=lambda item: str(item)):
        if not path.is_file() or not _is_relative_to(path, workspace_root):
            continue
        try:
            lines.append(path.relative_to(workspace).as_posix())
        except ValueError:
            lines.append(str(path))
    manifest.write_text("\n".join(dict.fromkeys(lines)) + ("\n" if lines else ""), encoding="utf-8")
    print(f"Artifact manifest: {manifest}", flush=True)
    print(f"Artifact count: {len(lines)}", flush=True)


spec = importlib.util.spec_from_file_location("_science_agent_antibody_manager", manager_path)
if spec is None or spec.loader is None:
    print(f"ERROR: cannot load antibody manager: {manager_path}", file=sys.stderr)
    raise SystemExit(2)
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
raw_config = _normalize_workspace_config(manager.read_json(Path(config_path)))
cfg = manager.resolve_config(raw_config)
preset_name = str(raw_config.get("preset", "")).strip().upper()
preset = getattr(manager, "PRESETS", {}).get(preset_name, {})
workspace = Path(str(cfg.get("workspace") or workspace_root / "antibody_pipeline")).resolve()
_ensure_workspace_bundle_files(workspace)
if preset:
    target_name = Path(str(preset.get("target_pdb_name", ""))).name
    framework_name = Path(str(preset.get("framework_pdb_name", ""))).name
    if target_name and _should_replace_preset_path(cfg.get("target_pdb", "")):
        candidate = _workspace_input_candidate(workspace, target_name) or _host_resource_candidate(preset_name, target_name)
        if candidate:
            cfg["target_pdb"] = candidate
    if framework_name and _should_replace_preset_path(cfg.get("framework_pdb", "")):
        candidate = _workspace_input_candidate(workspace, framework_name) or _host_resource_candidate(preset_name, framework_name)
        if candidate:
            cfg["framework_pdb"] = candidate
cfg = _sanitize_resolved_config(cfg)
errors = manager.validate_format(cfg) + manager.validate_paths(cfg)[0]
if errors:
    for item in errors:
        print(f"ERROR: {item}", file=sys.stderr)
    raise SystemExit(2)
cmd = _sanitize_command(manager.command_for_full_run(cfg))
print("RUN_DIR=" + str(cfg.get("run_dir", "")), flush=True)
print("Antibody broker command: " + " ".join(shlex.quote(str(part)) for part in cmd), flush=True)
child_env = os.environ.copy()
child_env["SCIENCE_AGENT_NPU_BROKER_MODE"] = "1"
completed = subprocess.run(cmd, env=child_env)
if completed.returncode == 0:
    _write_artifact_manifest(cfg)
raise SystemExit(completed.returncode)
