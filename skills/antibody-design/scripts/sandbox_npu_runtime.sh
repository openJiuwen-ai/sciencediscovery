#!/usr/bin/env bash
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

set -euo pipefail

configure_sandbox_npu_runtime() {
  local scratch_root="${SCIENCEDISCOVERY_NPU_SCRATCH:-/tmp/sciencediscovery-antibody}"
  mkdir -p \
    "$scratch_root/tmp" \
    "$scratch_root/mindspore-cache" \
    "$scratch_root/ascend-work" \
    "$scratch_root/ascend-work/log" \
    "$scratch_root/xdg-cache" \
    "$scratch_root/huggingface" \
    "$scratch_root/matplotlib" \
    "$scratch_root/numba"

  export TMPDIR="$scratch_root/tmp"
  export TMP="$TMPDIR"
  export TEMP="$TMPDIR"
  export MS_COMPILER_CACHE_PATH="$scratch_root/mindspore-cache"
  export ASCEND_WORK_PATH="$scratch_root/ascend-work"
  export XDG_CACHE_HOME="$scratch_root/xdg-cache"
  export HF_HOME="$scratch_root/huggingface"
  export TRANSFORMERS_CACHE="$HF_HOME/transformers"
  export MPLCONFIGDIR="$scratch_root/matplotlib"
  export NUMBA_CACHE_DIR="$scratch_root/numba"
}
