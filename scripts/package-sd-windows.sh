#!/usr/bin/env bash
# ScienceDiscovery Windows 桌面端一键出包
#
# 快速上手：
#   cd <repo>
#   # 日常出包（指定仓库目录，推荐）
#   SD_REPO=E:\\package\\sd-0.4.0-rc1 bash scripts/package-sd-windows.sh
#   # 全链路默认目录（脚本所在仓库本身）
#   bash scripts/package-sd-windows.sh
#   # 从某个阶段续跑：code | data | sea | dist
#   SD_REPO=E:\\package\\sd-0.4.0-rc1 bash scripts/package-sd-windows.sh dist
#   # 挂独立进程（关终端/退 WorkBuddy 都照跑，日志落盘带 PKG_EXIT 终态）
#   SD_REPO=E:\\package\\sd-0.4.0-rc1 bash scripts/package-sd-windows.sh dist --detach
#   # 强制全量重来（忽略 stage 缓存）
#   bash scripts/package-sd-windows.sh --force
#
# 换新代码后直接用：git pull 后重跑即可，stage 按指纹自动判断该跳跳、该建建：
#   code  HEAD 变了 -> 自动重跑 install + build
#   data  uv.lock 没动 -> 跳过；动了才重建 venv/jw
#   sea   HEAD 变了但 runner 代码没变 -> SEA 增量检测 unchanged 秒过；
#         runner 代码真变了才重建（约 5-10 分钟）
#   dist  重跑出包（assemble + NSIS，约 40-50 分钟）
# 前提：1) git 工作树必须干净（脚本强制检查，出包要求可复现）；
#       2) 新机器/新目录首次先跑 bash scripts/package-sd-windows.sh check 预检环境。
# 产物固定在 <仓库>\win_desktop\release\，版本号由 win_desktop/package.json 决定。
#
# 阶段说明：
#   code  git 同步 -> pnpm install --frozen-lockfile -> pnpm build（全 workspace）
#   data  .sciencediscovery-data 三件套：sd-services venv / JiuwenSwarm / micromamba.exe
#   sea   Runner SEA（linux-x64 + arm64；仅 Linux 可构建，脚本自动走 WSL）
#   dist  shell 打包 -> payload 组装（含自检门）-> electron-builder NSIS 安装包
#
# 缓存与续跑：
#   每阶段完成会在 <repo>/.package-stamps/ 写 stamp；产物在且 stamp 未过期则跳过。
#   想强制重跑某阶段：删除对应 stamp 文件，或对该阶段用 --force。
#   全程输出同步 tee 到日志文件（开头会打印路径），中断后凭日志定位续跑阶段。
#
# 已知坑（脚本已内置处理，新增坑请补在这里）：
#   1. WorkBuddy 会话内的 node 有 safe-delete shim，assemble/electron-builder 的
#      批量删除会被拦截 —— 脚本自动带 CODEBUDDY_SAFE_DELETE_ENABLED=0 前缀。
#      在普通终端跑也无副作用。
#   2. assemble 要求所有 venv 同 Python 版本；sd-services 与 jw venv 都由 uv
#      按 .python-version=3.12 解析，天然一致。若你机器默认装了解释器冲突版本，
#      用 uv python pin 固定，别手动改 pyvenv.cfg。
#   3. SEA 只能在 Linux 构建（scripts/binary-release 硬检查）。脚本默认用
#      WSL 发行版 Ubuntu-22.04，WSL 内无 Node 时自动装用户级 Node 到 ~/opt。
#   4. jiuwenswarm.sh setup 需要访问 gitcode.com；fetch 脚本需要访问 GitHub。
#   5. 工作目录必须钉在仓库：以计划任务/无头方式运行且 cwd=C:\Windows\System32
#      时，jw 日志的相对路径解析到 System32\Logs 被 openjiuwen 校验拒绝、
#      assemble 的 A1 自检必挂 —— 脚本启动即 cd 到 REPO。
#   6. 中断（Ctrl-C/杀进程）会留下占用 payload 的孤儿 python/node 进程，重跑时
#      unlink .dll 报 EPERM —— dist 阶段开始前自动清理 ExecutablePath 落在本仓库
#      build 目录下的 python/node 残留进程。
#   7. WSL 出网可能整体中断（nodejs.org/npmmirror 都不可达）。SEA 的 Node 运行时
#      下载会 fetch failed —— 预检会提前警告；救援法：把任一旧 checkout 的
#      .tmp/runner-sea-build/.downloads/*.tar.xz 复制到本仓库同路径（文件名与
#      manifest 一致，SHA256 自动校验，即跳过下载）。
#
# 版本号备忘：产物名 = artifactName 模板（electron-builder.yml）。rc 周期的点号
# 写法（如 0.4.0.rc1）不是合法 SemVer，package.json 须用 0.4.0-rc1 并把 artifactName
# 钉为字面量；发正式版时 version 改回 X.Y.Z 并把 artifactName 恢复 ${version} 宏。
#
# 产物：win_desktop/release/ScienceDiscovery-<version>-win-x64-setup.exe
set -euo pipefail

# --------------------------------------------------------------------------
# 配置
# 脚本位于 <repo>/scripts/，默认对所在仓库出包；SD_REPO 可指向任意 checkout。
REPO="${SD_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_WIN="$(cygpath -w "$REPO" 2>/dev/null || echo "$REPO")"
WIN_DESKTOP="$REPO/win_desktop"
DATA="$REPO/.sciencediscovery-data"
STAMPS="$REPO/.package-stamps"
WSL_DISTRO="${SD_WSL_DISTRO:-Ubuntu-22.04}"
WSL_NODE_VER="${SD_WSL_NODE_VER:-v22.22.2}"
FORCE=0

log()  { printf '\033[1;32m[pkg]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pkg]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[pkg]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"; }

# --------------------------------------------------------------------------
# 参数解析：./package.sh [code|data|sea|dist|check|all] [--force] [--detach]
STAGES=(code data sea dist)
START_AT="code"
DETACH=0
if [[ $# -ge 1 && ! "$1" =~ ^-- ]]; then
  case "$1" in
    check|all) START_AT="$1" ;;
    code|data|sea|dist) START_AT="$1" ;;
    *) die "未知阶段: $1（可用: code|data|sea|dist|check|all）" ;;
  esac
  shift || true
fi
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --detach) DETACH=1 ;;
  esac
done

# stamp 工具：stage_done <stage> <fingerprint>
stage_done() {
  local stage="$1" fp="$2" f="$STAMPS/$1"
  [[ $FORCE -eq 1 ]] && return 1
  [[ -f "$f" ]] && [[ "$(cat "$f" 2>/dev/null)" == "$fp" ]]
}
mark_done() { mkdir -p "$STAMPS"; echo "$2" > "$STAMPS/$1"; log "阶段 $1 完成（指纹 $2）"; }

head_fp() { git -C "$REPO" rev-parse HEAD; }
data_fp() { cat "$REPO/uv.lock" "$REPO/services/runner/src/micromamba-releases.json" 2>/dev/null | sha256sum | cut -c1-16; }

# --------------------------------------------------------------------------
# check —— 环境预检（只读）
do_check() {
  log "== 环境预检 =="
  local ok=1
  chk() { # name, expect, actual
    if [[ -n "$3" ]]; then printf '  [OK]   %-12s %s\n' "$1" "$3"; else printf '  [FAIL] %-12s %s\n' "$1" "$2"; ok=0; fi
  }
  need_cmd git;  chk "git"   "任意版本"  "$(git --version 2>/dev/null)"
  need_cmd node; chk "node"  ">=22.19"   "$(node --version 2>/dev/null)"
  need_cmd pnpm; chk "pnpm"  "11.1.2"    "$(pnpm --version 2>/dev/null)"
  need_cmd uv;   chk "uv"    "0.9+"      "$(uv --version 2>/dev/null)"
  chk "core.longpaths" "true" "$(git config --global core.longpaths)"
  # WSL（SEA 必需）
  if command -v wsl.exe >/dev/null 2>&1 && wsl.exe -l -q 2>/dev/null | tr -d '\0' | grep -qix "$WSL_DISTRO"; then
    chk "WSL" "$WSL_DISTRO" "已安装"
    if wsl.exe -d "$WSL_DISTRO" -- bash -lc 'export PATH="$HOME/opt/node-'"$WSL_NODE_VER"'-linux-x64/bin:$PATH"; command -v node >/dev/null' 2>/dev/null; then
      chk "WSL node" "$WSL_NODE_VER" "就绪"
    else
      warn "  [WARN] WSL 内无 Node $WSL_NODE_VER —— sea 阶段会自动安装（用户级 ~/opt），或先自行安装"
    fi
  else
    warn "  [WARN] 未找到 WSL 发行版 $WSL_DISTRO —— sea 阶段将失败（SEA 只能在 Linux 构建）"
    ok=0
  fi
  # 网络
  for host in github.com gitcode.com; do
    code=$(curl -sI --max-time 8 "https://$host" -o /dev/null -w "%{http_code}" 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && chk "网络:$host" "200" "200" || { warn "  [WARN] $host 不可达（HTTP $code）"; }
  done
  # 关键路径
  [[ -f "$REPO/package.json" ]] || die "仓库路径无效: $REPO"
  chk "仓库" "" "$REPO"
  [[ $ok -eq 1 ]] && log "预检通过" || die "预检存在硬失败项，见上方 [FAIL]"
}

# --------------------------------------------------------------------------
# code —— 同步代码并全量构建
do_code() {
  local fp; fp="$(head_fp)"
  if stage_done code "$fp"; then log "== code: 跳过（HEAD $fp 已构建） =="; return 0; fi
  log "== code: git 同步 =="
  git -C "$REPO" fetch origin
  local st; st="$(git -C "$REPO" status -sb | head -1)"
  if [[ "$st" == *"ahead"* ]]; then die "本地领先 origin，请先推送或确认: $st"; fi
  if [[ "$st" == *"behind"* ]]; then
    if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then die "工作树有未提交改动且落后 origin，请先处理"; fi
    git -C "$REPO" pull --ff-only origin main
    fp="$(head_fp)"; log "已快进至 $fp"
  fi
  [[ -n "$(git -C "$REPO" status --porcelain)" ]] && die "工作树有未提交改动，出包要求干净工作树"

  log "== code: pnpm install（根仓库） =="
  pnpm -C "$REPO" install --frozen-lockfile
  log "== code: pnpm build（全 workspace，约 2-4 分钟） =="
  pnpm -C "$REPO" build

  # 硬产物必须存在（assemble 的 stale-dist gate 同样检查，这里提前失败更友好）
  for f in services/api/dist/server.js services/runner/dist/server.js \
           apps/web/dist/index.html apps/desktop/dist/index.html \
           packages/executor/dist/runner-bundle.js; do
    [[ -e "$REPO/$f" ]] || die "构建产物缺失: $f"
  done
  mark_done code "$fp"
}

# --------------------------------------------------------------------------
# data —— 全新数据目录三件套
do_data() {
  local fp; fp="$(data_fp)"
  if stage_done data "$fp"; then log "== data: 跳过（uv.lock/manifest 未变） =="; return 0; fi
  log "== data: sd-services venv（uv sync，Python 按 .python-version=3.12） =="
  mkdir -p "$DATA/envs"
  UV_PROJECT_ENVIRONMENT="$(cygpath -w "$DATA/envs/sd-services")" \
    uv sync --project "$REPO" --locked

  log "== data: JiuwenSwarm（clone pinned tag + venv + patches，约 5 分钟） =="
  bash "$REPO/scripts/jiuwenswarm.sh" setup

  log "== data: micromamba.exe（固定版本 + SHA256 校验） =="
  node "$REPO/scripts/fetch-managed-micromamba.mjs" \
    --arch x86_64 --platform win32 \
    --output "$(cygpath -w "$DATA/scientific-envs/bin/micromamba.exe")"

  # 一致性自检（assemble 的硬要求：venv 同版本）
  local v1 v2
  v1=$(grep version_info "$DATA/envs/sd-services/pyvenv.cfg" | awk '{print $3}')
  v2=$(grep version_info "$DATA/jiuwenswarm/src/.venv/pyvenv.cfg" | awk '{print $3}')
  [[ "$v1" == "$v2" ]] || die "venv Python 版本不一致: sd-services=$v1 jw=$v2"
  [[ -f "$DATA/jiuwenswarm/src/.sciencediscovery-patches.json" ]] || die "jw patches 回执缺失"
  mark_done data "$fp"
}

# --------------------------------------------------------------------------
# sea —— Runner SEA（WSL / Linux 内构建，产物写回 Windows 树）
do_sea() {
  local fp; fp="$(head_fp)"
  local x64="$REPO/services/runner/dist/sea/linux-x64/sciencediscovery-runner"
  local a64="$REPO/services/runner/dist/sea/linux-arm64/sciencediscovery-runner"
  if stage_done sea "$fp" && [[ -f "$x64" && -f "$a64" ]]; then
    log "== sea: 跳过（HEAD $fp 已有 SEA） =="; return 0
  fi
  command -v wsl.exe >/dev/null 2>&1 || die "无 WSL，SEA 只能在 Linux 构建"
  # Windows/GitBash 路径 -> WSL 路径（/e/... -> /mnt/e/...）。
  # 不能经 wsl.exe 传 Windows 路径：反斜杠会被参数解析层当转义符吃掉。
  local wsl_repo; wsl_repo=$(cygpath -u "$REPO" | sed 's|^/\([a-zA-Z]\)/|/mnt/\L\1/|')
  [[ -n "$wsl_repo" ]] || die "WSL 路径转换失败: $REPO"

  # WSL 出网预检：断了会挂在 Node 运行时下载（fetch failed）
  if ! wsl.exe -d "$WSL_DISTRO" -- bash -lc \
      'curl -sI --max-time 8 https://nodejs.org/dist/ -o /dev/null -w "%{http_code}"' 2>/dev/null \
      | tr -d '\0' | grep -q "200"; then
    warn "WSL 出网检测失败（nodejs.org 不可达）。SEA 下载 Node 运行时会 fetch failed；"
    warn "可先把任一旧构建的 .tmp/runner-sea-build/.downloads/*.tar.xz 复制到本仓库同路径（缓存命中即跳过下载）"
  fi

  # WSL 内 Node：优先已有，缺失则自动装用户级
  local nrc='export PATH="$HOME/opt/node-'"$WSL_NODE_VER"'-linux-x64/bin:$PATH"'
  if ! wsl.exe -d "$WSL_DISTRO" -- bash -lc "$nrc; command -v node >/dev/null"; then
    log "== sea: WSL 内安装用户级 Node $WSL_NODE_VER =="
    wsl.exe -d "$WSL_DISTRO" -- bash -lc \
      'mkdir -p ~/opt && curl -fsSL "https://nodejs.org/dist/'"$WSL_NODE_VER"'/node-'"$WSL_NODE_VER"'-linux-x64.tar.xz" -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C ~/opt && rm /tmp/node.tar.xz' \
      || die "WSL Node 安装失败（检查网络），可手动装到 ~/opt 后重试"
  fi

  log "== sea: 构建 Runner SEA（linux-x64 + linux-arm64，约 5-10 分钟） =="
  wsl.exe -d "$WSL_DISTRO" -- bash -lc \
    "$nrc; cd '$wsl_repo' && node scripts/binary-release/build-runner.mjs" \
    || die "SEA 构建失败"

  [[ -f "$x64" && -f "$a64" ]] || die "SEA 产物缺失（应写回 $REPO/services/runner/dist/sea/）"
  mark_done sea "$fp"
}

# --------------------------------------------------------------------------
# dist 前置：清理占用 payload 的孤儿进程（中断/手停会留下 python/node 残留，
# 重跑 assemble 时 unlink .dll 报 EPERM）。只杀 ExecutablePath 落在本仓库
# build 目录下的进程，不碰用户其他工作。
clean_orphans() {
  command -v powershell.exe >/dev/null 2>&1 || return 0
  local repo_win pids
  repo_win="$(cygpath -w "$REPO" | sed 's/\\/\\\\/g')"
  pids=$(powershell.exe -NoProfile -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='node.exe'\" |
     Where-Object { \$_.ExecutablePath -and \$_.ExecutablePath -like '${repo_win}\\win_desktop\\build*' } |
     ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -PassThru | Select-Object -ExpandProperty Id }" \
    2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true)
  if [[ -n "$pids" ]]; then
    warn "已终止 ${#pids[@]} 个构建残留进程（占用 payload）: $(echo $pids | tr '\n' ' ')"
  fi
}

# --------------------------------------------------------------------------
# detach —— 生成本地 wrapper（钉 cwd + 系统 Git bash + 日志落盘），注册并启动
# Windows 计划任务。进程完全脱离当前终端/会话，终端关了照跑；日志可回读。
detach_build() {
  need_cmd schtasks
  local repo_win script_win bash_win log wrapper tn
  repo_win="$(cygpath -w "$REPO")"
  script_win="$(cygpath -w "$0")"
  bash_win=""
  for c in "/c/Program Files/Git/bin/bash.exe" "/d/Program Files/Git/bin/bash.exe"; do
    [[ -f "$c" ]] && { bash_win="$(cygpath -w "$c")"; break; }
  done
  [[ -n "$bash_win" ]] || bash_win="$(cygpath -w "$(which bash)")"
  # 日志与 wrapper 落 .package-stamps/（运行时产物，已 gitignore），不弄脏仓库
  log="$STAMPS/package-$(basename "$REPO")-$START_AT.log"
  local log_win; log_win="$(cygpath -w "$log")"
  wrapper="$STAMPS/package-dist-$(basename "$REPO").cmd"
  tn="SD-pkg-$(basename "$REPO")-$START_AT"
  cat > "$wrapper" <<EOF
@echo off
cd /d $repo_win
set SD_REPO=$repo_win
"$bash_win" "$script_win" $START_AT > "$log_win" 2>&1
echo PKG_EXIT=%ERRORLEVEL% >> "$log_win"
EOF
  schtasks //create //tn "$tn" //tr "$(cygpath -w "$wrapper")" //sc once //st 23:59 //f >/dev/null 2>&1
  schtasks //run //tn "$tn" >/dev/null 2>&1
  log "已挂独立计划任务: $tn（进程脱离本终端，关掉也照跑）"
  log "  日志: $log_win（出现 PKG_EXIT 即终态）"
  log "  收尾: schtasks //delete //tn \"$tn\" //f"
}

# --------------------------------------------------------------------------
# dist —— shell 打包 + payload 组装 + NSIS 安装包
do_dist() {
  local fp; fp="$(head_fp)"
  local exe; exe=$(ls -1 "$WIN_DESKTOP"/release/ScienceDiscovery-*-win-x64-setup.exe 2>/dev/null | head -1)
  if stage_done dist "$fp" && [[ -n "$exe" ]]; then
    log "== dist: 跳过（HEAD $fp 已出包: $(basename "$exe")） =="; return 0
  fi
  clean_orphans
  log "== dist: win_desktop 依赖 =="
  pnpm -C "$WIN_DESKTOP" install --frozen-lockfile

  log "== dist: shell 打包（esbuild） =="
  node "$WIN_DESKTOP/scripts/build.mjs"

  log "== dist: payload 组装（约 15-20 分钟，含全部自检门） =="
  CODEBUDDY_SAFE_DELETE_ENABLED=0 node "$WIN_DESKTOP/scripts/assemble-backend.mjs"

  log "== dist: NSIS 安装包（1.5GB payload 压缩，约 15-30 分钟） =="
  CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm -C "$WIN_DESKTOP" exec electron-builder --win

  local exe; exe=$(ls -1 "$WIN_DESKTOP"/release/ScienceDiscovery-*-win-x64-setup.exe 2>/dev/null | head -1)
  [[ -n "$exe" ]] || die "未找到安装包产物"
  log "出包完成: $exe ($(du -h "$exe" | cut -f1))"
  mark_done dist "$fp"
}

# --------------------------------------------------------------------------
main() {
  [[ -f "$REPO/package.json" ]] || die "仓库路径无效: $REPO（可用 SD_REPO 环境变量覆盖）"
  # 钉死工作目录：无头运行（计划任务）的默认 cwd 是 C:\Windows\System32，
  # 会让 jw 日志相对路径解析炸掉（见头部坑 5）
  cd "$REPO"
  # 全程输出镜像到日志文件，中断后可凭日志定位续跑阶段
  local log_file; log_file="${SD_LOG:-/tmp/package-sd-$(date +%Y%m%d-%H%M%S).log}"
  exec > >(tee "$log_file") 2>&1
  log "日志镜像: $log_file"
  if [[ "$START_AT" == "check" ]]; then do_check; exit 0; fi
  do_check
  if [[ $DETACH -eq 1 ]]; then
    log "detach 模式：移交独立计划任务，本终端退出不影响出包"
    detach_build
    exit 0
  fi
  local started=0
  for s in "${STAGES[@]}"; do
    [[ $started -eq 0 && "$s" != "$START_AT" && "$START_AT" != "all" ]] && continue
    started=1
    local t0=$SECONDS
    case "$s" in
      code) do_code ;;
      data) do_data ;;
      sea)  do_sea ;;
      dist) do_dist ;;
    esac
    log "阶段 $s 用时 $((SECONDS - t0))s"
  done
  log "全部完成。stamp 目录: $STAMPS"
}
main
