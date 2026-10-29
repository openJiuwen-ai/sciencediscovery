#!/usr/bin/env bash
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
if [[ -f .ci/issue-346-local-repeat-grade.flag ]]; then
  exec bash .ci/run-issue-346-local-repeat-grade.sh "$@"
fi
if [[ -f .ci/issue-346-manual-repeat-grade.flag ]]; then
  exec bash .ci/run-issue-346-manual-repeat-grade.sh "$@"
fi
exec node test/support/tagged/shared.mjs run --profile daily --slice e2e-real "$@"
