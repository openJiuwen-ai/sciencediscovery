#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Configure only a stopped, disposable CI Swarm instance, never a user's instance."""
import os
from pathlib import Path
import re
import yaml

instance = os.environ["JIUWENSWARM_INSTANCE"]
if not re.fullmatch(r"sd-e2e-mocked-(research|literature)", instance):
    raise ValueError("Research fixture requires its own CI Swarm instance")
path = Path.home() / ".jiuwenswarm-instances" / instance / "config/config.yaml"
config = yaml.safe_load(path.read_text())
context = config["react"]["context_engine_config"]
context.update(enabled=True, context_window_tokens=32768, enable_context_debug=True)
context["current_round_compressor_config"].update(trigger_context_ratio=0.5, keep_recent_messages=4)
path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
