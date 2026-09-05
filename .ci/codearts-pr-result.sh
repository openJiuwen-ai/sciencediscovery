#!/usr/bin/env bash
#
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

# Renders the merge request result table for a CodeArts run.
#
# This used to be a shell step inside the workflow, which spends the pipeline
# quota; it now runs in the generic build task like every other CI step. The
# status column comes from each layer's recorded exit code in OBS rather than
# from CodeArts job statuses, which are green by construction: the build
# task's shell returns success so its OBS action can still upload the log.
#
# Inputs supplied through the build task's ENVS records:
#   MERGE_ID                 merge request number
#   CI_COMMIT, CI_RUN_ID     the run this result belongs to
#   CI_PUBLISH_DIR           staging directory, default .ci-results/publish

set -euo pipefail

kind="${1:-}"
case "$kind" in
  success|failure) ;;
  *) echo "Usage: .ci/codearts-pr-result.sh success|failure" >&2; exit 2 ;;
esac

: "${MERGE_ID:?MERGE_ID is required}"
: "${CI_COMMIT:?CI_COMMIT is required}"
: "${CI_RUN_ID:?CI_RUN_ID is required}"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
publish_dir="${CI_PUBLISH_DIR:-$repo_root/.ci-results/publish}"
case "$publish_dir" in
  /*) ;;
  *) publish_dir="$repo_root/$publish_dir" ;;
esac
mkdir -p -- "$publish_dir"
# shellcheck source=.ci/codearts-ci-layers.sh
. "$repo_root/.ci/codearts-ci-layers.sh"
RESULT_DIR="$publish_dir"
RESULT_FILE="$RESULT_DIR/result.html"
PR_CHECK_URL="https://gitcode.com/openJiuwen/sciencediscovery/pull/${MERGE_ID}/check"
CODECHECK_RESULT_BASE="https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery"
OBS_RUN_BASE="https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/ci/$CI_COMMIT/$CI_RUN_ID"
UT_HOST_LOG_URL="$OBS_RUN_BASE/ut-host/run.log"
UT_GUEST_LOG_URL="$OBS_RUN_BASE/ut-guest/run.log"
ST_LOG_URL="$OBS_RUN_BASE/st/run.log"
E2E_LOG_URL="$OBS_RUN_BASE/e2e/run.log"
BINARY_X86_64_LOG_URL="$OBS_RUN_BASE/binary/x86_64/run.log"
BINARY_AARCH64_LOG_URL="$OBS_RUN_BASE/binary/aarch64/run.log"
BINARY_X86_64_URL="$OBS_RUN_BASE/binary/x86_64/ScienceDiscovery-${CI_COMMIT:0:8}-linux-x86_64"
BINARY_X86_64_SUMS_URL="$OBS_RUN_BASE/binary/x86_64/SHA256SUMS"
BINARY_AARCH64_URL="$OBS_RUN_BASE/binary/aarch64/ScienceDiscovery-${CI_COMMIT:0:8}-linux-aarch64"
BINARY_AARCH64_SUMS_URL="$OBS_RUN_BASE/binary/aarch64/SHA256SUMS"

codecheck_result_fields() {
  python3 - "$1" <<'PY'
import html
import json
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

result_url = sys.argv[1]
try:
    request = Request(result_url, headers={"User-Agent": "ScienceDiscovery-CodeArts"})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise ValueError("result must be a JSON object")
except Exception as error:
    print("could not load code-check result from {}: {}".format(result_url, error), file=sys.stderr)
    result = {}
raw_status = result.get("status")
normalized_status = str(raw_status).strip().lower()
status = "PASSED" if normalized_status in {
    "completed", "pass", "passed", "success", "successful", "succeeded"
} else "FAILED"
try:
    link = result.get("link")
    parsed = urlsplit(link) if isinstance(link, str) else None
    if not parsed or parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("result link must be an absolute HTTPS URL")
    link_cell = '<a href="{}">点此跳转</a>'.format(html.escape(link, quote=True))
except Exception as error:
    print("could not load code-check link from {}: {}".format(result_url, error), file=sys.stderr)
    link_cell = "N/A"
print(status)
print(link_cell)
PY
}
public_log_cell() {
  python3 - "$1" "$PR_CHECK_URL" <<'PY'
import html
import sys
from urllib.request import Request, urlopen

log_url, checks_url = sys.argv[1:3]
try:
    request = Request(
        log_url,
        headers={"Range": "bytes=0-0", "User-Agent": "ScienceDiscovery-CodeArts"},
    )
    with urlopen(request, timeout=10) as response:
        if response.status not in (200, 206):
            raise ValueError("unexpected HTTP status {}".format(response.status))
    print('<a href="{}">公开日志</a>'.format(html.escape(log_url, quote=True)))
except Exception as error:
    print("public test log is unavailable at {}: {}".format(log_url, error), file=sys.stderr)
    print(
        '<a href="{}">查看构建日志</a>（公开测试日志未生成）'.format(
            html.escape(checks_url, quote=True)
        )
    )
PY
}
CODECHECK_FIELDS=$(codecheck_result_fields "$CODECHECK_RESULT_BASE/codecheck/${MERGE_ID}/codecheck.json")
BLACKLIST_FIELDS=$(codecheck_result_fields "$CODECHECK_RESULT_BASE/blacklist/${MERGE_ID}/blacklist.json")
ANTI_POISON_FIELDS=$(codecheck_result_fields "$CODECHECK_RESULT_BASE/anti_poison/${MERGE_ID}/anti_poison.json")
SCA_FIELDS=$(codecheck_result_fields "$CODECHECK_RESULT_BASE/sca/${MERGE_ID}/sca.json")
CODECHECK_RESULT=$(printf '%s\n' "$CODECHECK_FIELDS" | sed -n '1p')
CODECHECK_LINK_CELL=$(printf '%s\n' "$CODECHECK_FIELDS" | sed -n '2p')
BLACKLIST_RESULT=$(printf '%s\n' "$BLACKLIST_FIELDS" | sed -n '1p')
BLACKLIST_LINK_CELL=$(printf '%s\n' "$BLACKLIST_FIELDS" | sed -n '2p')
ANTI_POISON_RESULT=$(printf '%s\n' "$ANTI_POISON_FIELDS" | sed -n '1p')
ANTI_POISON_LINK_CELL=$(printf '%s\n' "$ANTI_POISON_FIELDS" | sed -n '2p')
SCA_RESULT=$(printf '%s\n' "$SCA_FIELDS" | sed -n '1p')
SCA_LINK_CELL=$(printf '%s\n' "$SCA_FIELDS" | sed -n '2p')

# Every CodeArts job is green by construction, because the build task's shell
# returns success so its OBS action can upload the log. Read each layer's
# recorded exit code instead, exactly as the verification job does.
UT_HOST_RESULT=$(codearts_layer_status ut-host)
UT_GUEST_RESULT=$(codearts_layer_status ut-guest)
ST_RESULT=$(codearts_layer_status st)
E2E_RESULT=$(codearts_layer_status e2e)
BINARY_X86_64_RESULT=$(codearts_layer_status binary/x86_64)
BINARY_AARCH64_RESULT=$(codearts_layer_status binary/aarch64)
UT_HOST_LOG_CELL=$(public_log_cell "$UT_HOST_LOG_URL")
UT_GUEST_LOG_CELL=$(public_log_cell "$UT_GUEST_LOG_URL")
ST_LOG_CELL=$(public_log_cell "$ST_LOG_URL")
E2E_LOG_CELL=$(public_log_cell "$E2E_LOG_URL")
if [ "$kind" = success ]; then
  # A successful run has the artifacts to point at; a failed one may not, so it
  # links the packaging logs instead.
  BINARY_X86_64_CELL="<a href=\"$BINARY_X86_64_URL\">binary</a> · <a href=\"$BINARY_X86_64_SUMS_URL\">SHA256SUMS</a>"
  BINARY_AARCH64_CELL="<a href=\"$BINARY_AARCH64_URL\">binary</a> · <a href=\"$BINARY_AARCH64_SUMS_URL\">SHA256SUMS</a>"
  HEADLINE="<p>&#9989; 流水线 <a href=\"$PR_CHECK_URL\">$CI_RUN_ID</a> 执行成功。</p>"
else
  BINARY_X86_64_CELL=$(public_log_cell "$BINARY_X86_64_LOG_URL")
  BINARY_AARCH64_CELL=$(public_log_cell "$BINARY_AARCH64_LOG_URL")
  HEADLINE="<p>&#10060; 流水线 <a href=\"$PR_CHECK_URL\">$CI_RUN_ID</a> 执行失败。</p>"
fi
cat > "$RESULT_FILE" <<RESULT_HTML
$HEADLINE
<p>可在 <a href="$PR_CHECK_URL">$PR_CHECK_URL</a> 查看完整构建日志。</p>
<p>如需重新验证，请更新并推送 PR 源分支；不要用 <code>rerun</code> 评论触发 CI 分支流水线。</p>
<table style="border-collapse: collapse">
  <tr><th>任务名称</th><th>子任务</th><th>状态</th><th>详情</th></tr>
  <tr><td rowspan="4">代码检查</td><td>SCA（开源合规）</td><td>$SCA_RESULT</td><td>$SCA_LINK_CELL</td></tr>
  <tr><td>Anti-poison（防投毒）</td><td>$ANTI_POISON_RESULT</td><td>$ANTI_POISON_LINK_CELL</td></tr>
  <tr><td>CodeCheck（静态检查）</td><td>$CODECHECK_RESULT</td><td>$CODECHECK_LINK_CELL</td></tr>
  <tr><td>Blacklist（禁用词）</td><td>$BLACKLIST_RESULT</td><td>$BLACKLIST_LINK_CELL</td></tr>
  <tr><td rowspan="2">UT</td><td>host tier</td><td>$UT_HOST_RESULT</td><td>$UT_HOST_LOG_CELL</td></tr>
  <tr><td>guest tier (QEMU TCG sandbox)</td><td>$UT_GUEST_RESULT</td><td>$UT_GUEST_LOG_CELL</td></tr>
  <tr><td>ST</td><td>-</td><td>$ST_RESULT</td><td>$ST_LOG_CELL</td></tr>
  <tr><td>E2E</td><td>mocked journeys (QEMU guest)</td><td>$E2E_RESULT</td><td>$E2E_LOG_CELL</td></tr>
  <tr><td rowspan="2">Binary</td><td>x86_64 debug package</td><td>$BINARY_X86_64_RESULT</td><td>$BINARY_X86_64_CELL</td></tr>
  <tr><td>aarch64 debug package</td><td>$BINARY_AARCH64_RESULT</td><td>$BINARY_AARCH64_CELL</td></tr>
</table>
RESULT_HTML
test -s "$RESULT_FILE"
echo "rendered $kind PR result: $RESULT_FILE"
