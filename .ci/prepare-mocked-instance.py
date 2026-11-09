#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Register the harness's reserved ports in a stopped, disposable Swarm instance."""
import os
from pathlib import Path
import re

instance = os.environ["JIUWENSWARM_INSTANCE"]
home = Path(os.environ["JIUWENSWARM_HOME"])
if (not re.fullmatch(r"sd-e2e-mocked-[a-z0-9-]+", instance)
        or not home.is_absolute()
        or (home / ".sciencediscovery-owned").read_text().strip() != "sciencediscovery"):
    raise ValueError("Mocked ports require an owned disposable CI Swarm instance")

# Product launchers deliberately filter SDK environment controls. Register
# ports through the pinned SDK's instance API instead of widening that boundary.
os.environ.pop("JIUWENSWARM_DATA_DIR", None)
from jiuwenswarm.instance_manager import (  # noqa: E402
    create_bootstrap_env, get_instance_config, update_instances_yaml,
)

config = get_instance_config(instance)
if config is None or config.workspace != home / ".jiuwenswarm-instances" / instance:
    raise ValueError("Mocked Swarm workspace does not belong to this run")
ports = {
    name: int(os.environ[env]) + 1000
    for name, env in {
        "agent_server": "JIUWENSWARM_AGENT_SERVER_PORT",
        "web": "JIUWENSWARM_WEB_PORT",
        "gateway": "JIUWENSWARM_GATEWAY_PORT",
        "frontend": "JIUWENSWARM_FRONTEND_PORT",
    }.items()
}
if len(set(ports.values())) != 4 or any(not 1 <= port <= 65535 for port in ports.values()):
    raise ValueError("Invalid reserved Swarm port group")
config.ports = ports
update_instances_yaml(instance, config.workspace, ports)
create_bootstrap_env(config)
print(f"Reserved mocked Swarm ports: {ports}")
