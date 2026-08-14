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

"""Workspace-first manager for the real antibody design pipeline.

This helper is intended to be copied into a ScienceDiscovery session workspace.
It does not assume one fixed server layout. It discovers model code and
environment paths from config, environment variables, workspace-local clones,
and common shared locations.
"""

from __future__ import annotations

import argparse
import csv
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


COMMON_MINDSCIENCE_ROOTS = [
    "/data/mindscience",
    "/opt/mindscience",
    "/opt/antibody_pipeline/models/mindscience",
]


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
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    parts = [part.strip() for part in re.split(r"[,;\s]+", text) if part.strip()]
    if not parts:
        return ""
    return "[" + ",".join(parts) + "]"


def default_scripts_dir() -> str:
    return posix_path(Path(__file__).resolve().parent)


def executable_file(path: str) -> bool:
    return bool(path) and Path(path).is_file() and os.access(path, os.X_OK)


def first_existing_dir(candidates: list[str]) -> str:
    for item in candidates:
        if item and Path(item).is_dir():
            return posix_path(item)
    return ""


def first_existing_file(candidates: list[str]) -> str:
    for item in candidates:
        if item and Path(item).is_file():
            return posix_path(item)
    return ""


def discover_python() -> str:
    """Return the Python selected by ScienceDiscovery's managed scientific env.

    Runner shell sessions expose the selected environment as SCIENCE_ENV_PYTHON
    and put that environment first on PATH. Older prompts may still set
    SCIENCE_AGENT_MANAGED_PYTHON/PYTHON_BIN explicitly, so keep those aliases.
    Never fall back to host pipeline venvs.
    """
    for name in ("SCIENCE_AGENT_MANAGED_PYTHON", "SCIENCE_ENV_PYTHON", "PYTHON_BIN", "ANTIBODY_PIPELINE_PYTHON"):
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


def broker_host_python_allowed(cfg: dict[str, Any]) -> bool:
    return bool(cfg.get("broker_mode")) or env_truthy("ANTIBODY_ALLOW_HOST_NPU_PYTHON", False) or env_truthy("SCIENCE_AGENT_NPU_BROKER", False)


def managed_python_errors(cfg: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    python_bin = str(cfg.get("python", "")).strip()
    if not python_bin:
        return [
            "python is unresolved; select/create a ScienceDiscovery scientific environment "
            "and use the runner-injected SCIENCE_ENV_PYTHON or PATH python"
        ]
    if broker_host_python_allowed(cfg):
        return []
    py_text = posix_path(python_bin)
    pipeline_home = env_or_empty("ANTIBODY_PIPELINE_HOME")
    blocked_fragments = ["/antibody_pipeline/venv/", "/antibody_pipeline/python_user/"]
    if pipeline_home:
        ph = posix_path(pipeline_home).rstrip("/")
        blocked_fragments.extend([f"{ph}/venv/", f"{ph}/python_user/", f"{ph}/bin/"])
    if any(fragment and fragment in py_text for fragment in blocked_fragments):
        errors.append(f"python points at a host pipeline environment, not ScienceDiscovery managed env: {py_text}")
    scienceagent_python = "/scientific-envs/revisions/" in py_text or py_text.startswith("/opt/science-env/")
    if env_truthy("ANTIBODY_REQUIRE_SCIENCEAGENT_ENV", True) and not scienceagent_python:
        errors.append(
            "python must come from the ScienceDiscovery selected scientific environment "
            f"(SCIENCE_ENV_PYTHON or /opt/science-env/bin/python), got: {py_text}"
        )
    return errors


def managed_pipeline_env_errors(cfg: dict[str, Any]) -> list[str]:
    pipeline_env = str(cfg.get("pipeline_env", "")).strip()
    if env_truthy("ANTIBODY_REQUIRE_SCIENCEAGENT_ENV", True) and pipeline_env:
        return [
            "pipeline_env is not allowed in ScienceDiscovery managed-env mode; "
            f"do not source host env.sh, got: {pipeline_env}"
        ]
    return []


OPERATOR_ONLY_CONFIG_KEYS = {
    "ckpt",
    "models_dir",
    "protenix_ckpt",
    "protenix_ckpt_url",
    "protenix_dir",
}


def operator_only_config_errors(cfg: dict[str, Any]) -> list[str]:
    if not env_truthy("ANTIBODY_REQUIRE_SCIENCEAGENT_ENV", True):
        return []
    return [
        f"{key} is operator-only in Broker mode; configure it through deployment environment, not config.json"
        for key in sorted(OPERATOR_ONLY_CONFIG_KEYS)
        if key in cfg and str(cfg.get(key, "")).strip()
    ]


def resolve_config(cfg: dict[str, Any]) -> dict[str, Any]:
    workspace = posix_path(cfg.get("workspace", "antibody_pipeline"))
    models_dir = posix_path(env_or_empty("ANTIBODY_MODELS_DIR") or join_path(workspace, "models"))

    mindscience_root = cfg.get("mindscience_root") or env_or_empty("MINDSCIENCE_ROOT")
    if not mindscience_root:
        mindscience_root = first_existing_dir([join_path(models_dir, "mindscience"), *COMMON_MINDSCIENCE_ROOTS])
    app_dir = cfg.get("app_dir") or env_or_empty("MINDSCIENCE_APP_DIR")
    if not app_dir and mindscience_root:
        app_dir = join_path(mindscience_root, "MindSPONGE", "applications")
    app_dir = posix_path(app_dir) if app_dir else ""

    rf_dir = cfg.get("rf_diffusion_dir") or (join_path(app_dir, "rf_diffusion") if app_dir else "")
    proteinmpnn_dir = cfg.get("proteinmpnn_dir") or (join_path(app_dir, "proteinmpnn") if app_dir else "")
    protenix_dir = env_or_empty("PROTENIX_APP_DIR") or (join_path(app_dir, "protenix") if app_dir else "")

    python_bin = discover_python() or cfg.get("python")
    pipeline_env = cfg.get("pipeline_env")
    if pipeline_env is None:
        pipeline_env = env_or_empty("ANTIBODY_PIPELINE_ENV")
    rf_ckpt = env_or_empty("RF_DIFFUSION_CKPT") or (join_path(rf_dir, "models", "RFdiffusion_Ab.ckpt") if rf_dir else "")
    protenix_ckpt = env_or_empty("PROTENIX_CKPT") or (
        join_path(protenix_dir, "release_data", "checkpoint", "ms_model_v0.5.0.ckpt") if protenix_dir else ""
    )
    protenix_ckpt_url = env_or_empty("PROTENIX_CKPT_URL")
    hmmer_home = cfg.get("hmmer_home") or env_or_empty("HMMER_HOME")
    cann_set_env = cfg.get("cann_set_env") or env_or_empty("CANN_SET_ENV")

    target_pdb = cfg.get("target_pdb", "")
    framework_pdb = cfg.get("framework_pdb", "")

    run_name = cfg.get("run_name") or f"antibody_custom_{cfg.get('num_designs', 0)}_{time.strftime('%Y%m%d_%H%M%S')}"
    run_dir = cfg.get("run_dir") or join_path(workspace, "runs", run_name)

    resolved = dict(cfg)
    resolved.update({
        "workspace": workspace,
        "scripts_dir": posix_path(cfg.get("scripts_dir") or default_scripts_dir()),
        "models_dir": models_dir,
        "mindscience_root": posix_path(mindscience_root) if mindscience_root else "",
        "app_dir": app_dir,
        "rf_diffusion_dir": posix_path(rf_dir) if rf_dir else "",
        "proteinmpnn_dir": posix_path(proteinmpnn_dir) if proteinmpnn_dir else "",
        "protenix_dir": posix_path(protenix_dir) if protenix_dir else "",
        "python": posix_path(python_bin),
        "pipeline_env": posix_path(pipeline_env) if pipeline_env else "",
        "ckpt": posix_path(rf_ckpt) if rf_ckpt else "",
        "protenix_ckpt": posix_path(protenix_ckpt) if protenix_ckpt else "",
        "protenix_ckpt_url": protenix_ckpt_url,
        "hmmer_home": posix_path(hmmer_home) if hmmer_home else "",
        "cann_set_env": posix_path(cann_set_env) if cann_set_env else "",
        "target_pdb": posix_path(target_pdb) if target_pdb else "",
        "framework_pdb": posix_path(framework_pdb) if framework_pdb else "",
        "run_name": run_name,
        "run_dir": posix_path(run_dir),
        "hotspots": normalize_hotspots(cfg.get("hotspots")),
        "design_loops": cfg.get("design_loops") or "[H1:8,H2:6,H3:16]",
        "num_designs": int(cfg.get("num_designs", 0)),
        "npus": str(cfg.get("npus", env_or_empty("ASCEND_RT_VISIBLE_DEVICES") or "0,1,2,3,4,5,6,7")),
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
    required_files = ["target_pdb", "framework_pdb", "ckpt", "protenix_ckpt"]
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


def print_clone_hint(cfg: dict[str, Any]) -> None:
    dst = join_path(cfg["models_dir"], "mindscience")
    print("Clone missing model code, after user approval:")
    print("  mkdir -p " + shlex.quote(cfg["models_dir"]))
    print("  git clone https://gitcode.com/mindspore/mindscience.git " + shlex.quote(dst))


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    print(f"Downloading {url} -> {destination}")
    with urllib.request.urlopen(url) as response, tmp.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    tmp.replace(destination)


def prepare_cmd(args: argparse.Namespace) -> int:
    cfg_path = args.config
    raw = read_json(cfg_path)
    cfg = resolve_config(raw)
    errors = operator_only_config_errors(raw) + validate_format(cfg) + validate_paths(cfg)[0]
    app_missing = any("app_dir" in item or "rf_diffusion_dir" in item or "proteinmpnn_dir" in item or "protenix_dir" in item for item in errors)

    if app_missing and args.clone_missing:
        clone_dst = Path(join_path(cfg["models_dir"], "mindscience"))
        if clone_dst.exists():
            print(f"MindScience clone already exists: {clone_dst}")
        else:
            clone_dst.parent.mkdir(parents=True, exist_ok=True)
            print(f"Cloning MindScience into workspace: {clone_dst}")
            subprocess.run(
                ["git", "clone", "https://gitcode.com/mindspore/mindscience.git", str(clone_dst)],
                check=True,
            )
        raw["mindscience_root"] = posix_path(clone_dst)
        write_json(cfg_path, raw)
        cfg = resolve_config(raw)
        errors = operator_only_config_errors(raw) + validate_format(cfg) + validate_paths(cfg)[0]
    elif app_missing:
        print_clone_hint(cfg)

    ckpt_missing = any(item.startswith("protenix_ckpt ") for item in errors)
    if ckpt_missing and args.download_missing:
        if not cfg.get("protenix_ckpt_url"):
            print("Protenix checkpoint is missing and no protenix_ckpt_url/PROTENIX_CKPT_URL was provided.")
        else:
            download_file(cfg["protenix_ckpt_url"], Path(cfg["protenix_ckpt"]))
            cfg = resolve_config(raw)
            errors = operator_only_config_errors(raw) + validate_format(cfg) + validate_paths(cfg)[0]

    if args.write_resolved:
        write_json(args.write_resolved, cfg)
        print(f"Wrote resolved config: {args.write_resolved}")

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
    errors = operator_only_config_errors(raw) + format_errors + path_errors
    print("Antibody pipeline validation")
    print(f"  valid: {not errors}")
    for key in ["workspace", "scripts_dir", "mindscience_root", "app_dir", "rf_diffusion_dir", "proteinmpnn_dir", "protenix_dir", "python", "pipeline_env", "ckpt", "protenix_ckpt", "target_pdb", "framework_pdb", "run_dir", "protenix_use_msa", "protenix_n_sample", "protenix_seeds"]:
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
    if args.write_resolved:
        write_json(args.write_resolved, cfg)
        print(f"Wrote resolved config: {args.write_resolved}")
    return 0 if not errors else 2


def write_runner_cmd(args: argparse.Namespace) -> int:
    raw = read_json(args.config)
    cfg = resolve_config(raw)
    errors = operator_only_config_errors(raw) + validate_format(cfg) + validate_paths(cfg)[0]
    if errors:
        for item in errors:
            print(f"ERROR: {item}", file=sys.stderr)
        return 2
    runner = Path(cfg["workspace"]) / "run_real_pipeline.sh"
    log = join_path(cfg["run_dir"], "pipeline.nohup.log")
    cmd = command_for_full_run(cfg)
    script = "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p " + shlex.quote(cfg["run_dir"]) + "\n"
    script += "nohup " + " ".join(shlex.quote(x) for x in cmd) + " > " + shlex.quote(log) + " 2>&1 &\n"
    script += "echo \"RUN_DIR=" + cfg["run_dir"] + "\"\n"
    script += "echo \"LOG=" + log + "\"\n"
    runner.write_text(script, encoding="utf-8")
    print(f"Wrote runner: {runner}")
    print("Run with:")
    print("  bash " + shlex.quote(str(runner)))
    return 0


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


def pipeline_processes_running(run_dir: str) -> list[str]:
    try:
        result = subprocess.run(
            ["bash", "-lc", f"ps -ef | grep -E 'run_full_antibody_pipeline|run_after_rfdiffusion|inference.py|proteinmpnn|protenix' | grep -F {shlex.quote(run_dir)} | grep -v grep || true"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return lines[:20]


def read_tail(path: Path, max_bytes: int = 12000) -> str:
    if not path.is_file():
        return ""
    data = path.read_bytes()
    if len(data) > max_bytes:
        data = data[-max_bytes:]
    return data.decode("utf-8", errors="replace")


def scan_logs_for_errors(run: Path, limit: int = 12) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    log_roots = [run / "pipeline.nohup.log", run / "logs", run / "01_rfdiffusion" / "logs", run / "04_protenix_output" / "logs"]
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


def recovery_hints(errors: list[dict[str, str]], cfg: dict[str, Any], stage: str, procs: list[str]) -> list[str]:
    hints: list[str] = []
    blob = "\n".join(item.get("snippet", "") for item in errors).lower()
    managed_python = cfg.get("python", "SCIENCE_AGENT_MANAGED_PYTHON")
    if not procs and stage != "complete":
        hints.append(
            f"Pipeline process not found while stage={stage}. Relaunch with the ScienceDiscovery managed "
            f"environment Python ({managed_python}) and do not source host env.sh: "
            f"bash {join_path(cfg['workspace'], 'run_real_pipeline.sh')}"
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
    procs = pipeline_processes_running(cfg["run_dir"])
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
        "processes": procs,
        "process_count": len(procs),
        "errors": errors,
        "recovery_hints": recovery_hints(errors, cfg, stage, procs),
        "nohup_log": posix_path(run / "pipeline.nohup.log"),
        "nohup_tail": read_tail(run / "pipeline.nohup.log", 4000),
    }


def print_snapshot(snap: dict[str, Any], *, quiet: bool = False) -> None:
    print("Run status")
    print(f"  run_dir: {snap['run_dir']}")
    print(f"  stage: {snap['stage']}")
    print(f"  expected: {snap['expected']}")
    print(f"  process_count: {snap['process_count']}")
    for key, meta in snap["progress"].items():
        print(f"  {key}: {meta['have']}/{meta['expected']} ({meta['pct']}%)")
    print(f"  complete: {snap['complete']}")
    if not quiet:
        print("  reports:")
        for item in snap["reports"]:
            print(f"    {'OK' if item['ok'] else 'MISSING'} {item['path']}")
        if snap["processes"]:
            print("  processes:")
            for line in snap["processes"][:5]:
                print(f"    {line}")
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
    if (not quiet) and snap.get("nohup_tail"):
        print("  nohup_tail:")
        for line in snap["nohup_tail"].strip().splitlines()[-8:]:
            print(f"    {line}")


def status_cmd(args: argparse.Namespace) -> int:
    cfg = resolve_config(read_json(args.config))
    snap = collect_snapshot(cfg)
    print_snapshot(snap)
    if args.json:
        print(json.dumps(snap, indent=2))
    return 0 if snap["complete"] else 1


def apply_safe_heals(cfg: dict[str, Any], snap: dict[str, Any]) -> list[str]:
    """Best-effort safe fixes that do not modify shared CANN/conda."""
    actions: list[str] = []
    blob = "\n".join(item.get("snippet", "") for item in snap.get("errors", [])).lower()
    workspace = cfg["workspace"]
    env_sh = join_path(workspace, "env.sh")
    if not Path(env_sh).is_file():
        pipeline_home = os.environ.get("ANTIBODY_PIPELINE_HOME", "").rstrip("/")
        env_sh = f"{pipeline_home}/env.sh" if pipeline_home else ""
    py = cfg.get("python") or discover_python()

    if "hmmscan" in blob and "not found" in blob:
        actions.append(
            "hmmscan_missing: install HMMER into tools/hmmer after user approval if not already installed"
        )
    marker = Path(workspace) / "logs" / "watch_heal_attempts.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    history = []
    if marker.is_file():
        try:
            history = json.loads(marker.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = []
    history.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "stage": snap["stage"], "actions": actions})
    marker.write_text(json.dumps(history[-20:], indent=2), encoding="utf-8")
    return actions


def watch_cmd(args: argparse.Namespace) -> int:
    cfg = resolve_config(read_json(args.config))
    deadline = time.time() + max(0, args.timeout)
    last_signature = ""
    last_heartbeat = 0.0
    heartbeat_every = max(args.interval * 6, 1800)  # quiet heartbeat at most ~every 6 polls / 30m
    while True:
        snap = collect_snapshot(cfg)
        # Ignore process_count churn; only stage/counts/errors matter for printing.
        signature = json.dumps(
            {
                "stage": snap["stage"],
                "counts": snap["counts"],
                "errors": [item["log"] for item in snap["errors"][:3]],
            },
            sort_keys=True,
        )
        now = time.time()
        changed = signature != last_signature
        if changed or args.verbose:
            print(f"\n=== watch {time.strftime('%F %T')} ===")
            print_snapshot(snap, quiet=not args.verbose)
            last_signature = signature
            last_heartbeat = now
        elif now - last_heartbeat >= heartbeat_every:
            # One short line so long quiet runs are not silent forever.
            counts = snap.get("counts") or {}
            print(
                f"[watch {time.strftime('%F %T')}] stage={snap['stage']} "
                f"counts={counts} procs={snap['process_count']} (no change)"
            )
            last_heartbeat = now
        if snap["complete"]:
            print("Watch finished: run complete.")
            return 0
        if snap["errors"] and args.auto_heal:
            actions = apply_safe_heals(cfg, snap)
            if actions:
                print("Auto-heal attempts:")
                for action in actions:
                    print(f"  - {action}")
        if args.once:
            print("Watch snapshot complete flag is false; exiting 0 so the Agent can continue polling later.")
            return 0
        if now >= deadline:
            print("Watch finished: timeout reached before completion.", file=sys.stderr)
            return 2
        time.sleep(max(30, args.interval))


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
    p.add_argument("--write-resolved", type=Path)
    p.set_defaults(func=validate_cmd)

    p = sub.add_parser("prepare")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--clone-missing", action="store_true")
    p.add_argument("--download-missing", action="store_true")
    p.add_argument("--write-resolved", type=Path)
    p.set_defaults(func=prepare_cmd)

    p = sub.add_parser("write-runner")
    p.add_argument("--config", type=Path, required=True)
    p.set_defaults(func=write_runner_cmd)

    p = sub.add_parser("status")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=status_cmd)

    p = sub.add_parser("artifact-manifest")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--output", type=Path)
    p.set_defaults(func=artifact_manifest_cmd)

    p = sub.add_parser("watch")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--interval", type=int, default=300, help="Seconds between polls (default 300)")
    p.add_argument("--timeout", type=int, default=86400, help="Max seconds to watch")
    p.add_argument("--once", action="store_true", help="Single poll then exit")
    p.add_argument("--auto-heal", action="store_true", help="Attempt safe dependency fixes")
    p.add_argument("--verbose", action="store_true", help="Print full snapshot every change")
    p.set_defaults(func=watch_cmd)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
