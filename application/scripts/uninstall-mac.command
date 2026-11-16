#!/bin/bash
# =====================================================================
#  ScienceDiscovery 一键卸载 / 数据重置（macOS，双击运行）
#
#  这是应用内「卸载与数据清理」对话框（main.ts 帮助菜单，W25）的
#  离线互补：应用起不来、已被拖废纸篓、或只想在下一次安装前清场
#  时，用这个脚本。两者删除范围一致（uninstall-data.ts 的
#  footprint 清单 + Library 散落项）。
#
#  无需手工提供任何路径，脚本自动发现全部落点：
#    - 应用本体   /Applications/ScienceDiscovery.app（含 ~/Applications 兜底）
#    - 数据目录   自动读 ~/Library/Application Support/sd-shell/wizard-state.json
#                 里记录的安装时选择（data-dir.txt 兜底，再兜底默认路径）
#    - 壳层状态   ~/Library/Application Support/sd-shell
#                 注意：Electron userData 按包名 sd-shell 命名，与
#                 productName（ScienceDiscovery）不同——别按产品名找
#    - 散落缓存   ~/Library/{Caches,HTTPStorages,WebKit,Logs} 下相关目录
#                 （存在才清；Logs 下 sd-shell / ScienceDiscovery 两种命名都探测）
#    - 窗口状态   ~/Library/Saved Application State/cn.sciencediscovery.desktop.savedState
#
#  安全设计：
#    - 确认删除后才退出应用（先优雅退出等后端停稳，超时才强杀）
#    - 删除前自动备份模型密钥 / 会话记录到 ~/ScienceDiscovery-backup-<时间>/
#    - 一律移入废纸篓（~/.Trash），不直接 rm，随时可恢复
#    - 「查看路径」零副作用，可随时查看
#
#  四种模式：
#    1) 完全卸载   应用 + 全部数据 + 全部状态（重装如新）
#    2) 只卸载软件 只删应用本体，保留全部数据（换版本测试常用）
#    3) 数据重置   保留应用，清数据 + 状态（下次启动重走安装向导）
#    4) 查看路径   零副作用
#
#  适用：打包安装版。开发者用环境变量指向的仓库内数据目录（如
#  .sciencediscovery-data）属开发态，如向导里选过它会被一并清掉，
#  清单确认时会明确显示路径，留意确认即可。
#  bash 3.2 兼容（macOS 自带 bash，无 mapfile/关联数组——L18）。
#
#  分发定位（F21，维护者决策）：仓库内支持侧脚本，不进 DMG/zip 产物
#  （electron-builder.yml files/extraResources 均不含 scripts/）。
#  用户获取渠道是 GitHub Release 页的独立资产（与 DMG 并列下载），
#  由 FAQ/客服引导——产物内任何位置都会随 .app 一起进废纸篓，
#  唯一有意义的落点是 Release 资产。下载后需 chmod +x 并右键打开
#  （Gatekeeper 隔离属性拦双击）。
# =====================================================================

set -u

# F18: ANSI escapes must be BAKED into the variables at definition time.
# '\033[...' in single quotes is a literal backslash that only printf's
# FORMAT string would interpret; consumers that put ${GREEN} in printf's
# ARGUMENT ("%s\n") or in echo never expand it (verified: cat -v shows the
# raw \033). Building each var with printf at definition makes every
# consumer correct — echo, %s args, and format strings alike — with zero
# re-interpretation risk for path contents.
RED="$(printf '\033[0;31m')"; GREEN="$(printf '\033[0;32m')"; YELLOW="$(printf '\033[1;33m')"
CYAN="$(printf '\033[0;36m')"; BOLD="$(printf '\033[1m')"; OFF="$(printf '\033[0m')"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/ScienceDiscovery-backup-$STAMP"

if [ "$(id -u)" = "0" ]; then
  echo "请勿用 sudo 运行——脚本只清理当前用户的数据。"
  exit 1
fi

# --- 落点自动发现 -----------------------------------------------------
SHELL_UD="$HOME/Library/Application Support/sd-shell"
WIZARD_JSON="$SHELL_UD/wizard-state.json"
DEFAULT_DATA="$HOME/Library/Application Support/ScienceDiscovery"
SAVED_STATE="$HOME/Library/Saved Application State/cn.sciencediscovery.desktop.savedState"
BUNDLE_ID="cn.sciencediscovery.desktop"

APP_CANDIDATES=(
  "/Applications/ScienceDiscovery.app"
  "$HOME/Applications/ScienceDiscovery.app"
)

# 数据目录：向导记录 > data-dir.txt > 默认路径
DATA_DIR=""
if [ -f "$WIZARD_JSON" ]; then
  DATA_DIR="$(sed -n 's/.*"dataDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WIZARD_JSON" | head -1)"
fi
if [ -z "$DATA_DIR" ] && [ -f "$SHELL_UD/data-dir.txt" ]; then
  DATA_DIR="$(cat "$SHELL_UD/data-dir.txt" 2>/dev/null)"
fi
[ -z "$DATA_DIR" ] && DATA_DIR="$DEFAULT_DATA"

SCATTER=(
  "$HOME/Library/Caches/sd-shell"
  "$HOME/Library/Preferences/$BUNDLE_ID.plist"
  "$HOME/Library/HTTPStorages/$BUNDLE_ID"
  "$HOME/Library/WebKit/$BUNDLE_ID"
  # F20: Electron 按包名给日志目录（与 userData 同理），两个候选名都探测——
  # logsDir 是运行时注入路径，离线脚本无法知道应用实际用了哪个，存在才清。
  "$HOME/Library/Logs/sd-shell"
  "$HOME/Library/Logs/ScienceDiscovery"
)

size_of() { [ -e "$1" ] && du -sh "$1" 2>/dev/null | awk '{print $1}' || echo "—"; }

# --- 打印当前落点清单 ---------------------------------------------------
show_list() {
  echo
  printf "${BOLD}发现的落点：${OFF}\n"
  for p in "${APP_CANDIDATES[@]}"; do
    [ -e "$p" ] && printf "  [应用]  %s  (%s)\n" "$p" "$(size_of "$p")"
  done
  if [ -e "$DATA_DIR" ]; then
    printf "  [数据]  %s  (%s)\n" "$DATA_DIR" "$(size_of "$DATA_DIR")"
  else
    printf "  [数据]  %s  (不存在)\n" "$DATA_DIR"
  fi
  if [ -e "$SHELL_UD" ]; then
    printf "  [状态]  %s  (%s)\n" "$SHELL_UD" "$(size_of "$SHELL_UD")"
  else
    printf "  [状态]  %s  (不存在)\n" "$SHELL_UD"
  fi
  [ -e "$SAVED_STATE" ] && printf "  [窗口]  %s  (%s)\n" "$SAVED_STATE" "$(size_of "$SAVED_STATE")"
  for p in "${SCATTER[@]}"; do
    [ -e "$p" ] && printf "  [缓存]  %s  (%s)\n" "$p" "$(size_of "$p")"
  done
  echo
}

# --- 应用退出（仅在确认删除后调用） --------------------------------------
# F22: 优雅等待窗口 20s——不短于应用自身的 stack.stop 宽限（15s）。窗口太短
# 会在后端还在正常停栈的过程中就强杀进程树，制造本要避免的孤儿。
quit_app() {
  if ! pgrep -f "/ScienceDiscovery.app" >/dev/null 2>&1; then
    echo "  应用未在运行"
    return 0
  fi
  echo "  正在退出应用（等后端停稳）..."
  osascript -e 'tell application "ScienceDiscovery" to quit' >/dev/null 2>&1
  local i=0
  while pgrep -f "/ScienceDiscovery.app" >/dev/null 2>&1 && [ "$i" -lt 40 ]; do
    sleep 0.5; i=$((i + 1))
  done
  if pgrep -f "/ScienceDiscovery.app" >/dev/null 2>&1; then
    printf '%s\n' "  ${YELLOW}20 秒未优雅退出，强制结束进程树${OFF}"
    pkill -f "/ScienceDiscovery.app" 2>/dev/null
    sleep 2
    pkill -9 -f "/ScienceDiscovery.app" 2>/dev/null
    sleep 1
  fi
  echo "  应用已退出"
}

# --- F22: 后端残留检查（壳死后 detached 后端可能还活着） -------------------
# 后端由壳以独立进程组 spawn（stack.ts detached），壳崩溃/被强杀后可能残留。
# 判别特征（只针对本应用的栈，绝不误伤开发机上无关的开发态后端）：
#   ① 从应用包内运行的任何进程：argv 引用 ScienceDiscovery.app/Contents
#      （壳、start-stack、打包 runtime 的 python worker 都满足；此刻应用
#      理应已退出，凡是还引用包路径的都是残留）；
#   ② python worker：argv 指向数据目录（envs 装在数据目录下）——仅当
#      DATA_DIR 通过合法性门（F24）：非空、绝对路径、已存在的目录、
#      且不是 /、$HOME 这类宽目录。向导记录未经校验，指向宽目录时字面
#      匹配会命中该目录下所有 python 进程，把无关任务 SIGKILL 掉——
#      宁可漏杀本产品残留（① 已兜住打包态），绝不误杀用户进程。
# 数据目录用 grep -F 字面匹配，防用户自选路径里的正则元字符。
data_dir_safe_for_match() {
  [ -n "$DATA_DIR" ] || return 1
  case "$DATA_DIR" in /*) ;; *) return 1 ;; esac
  [ -d "$DATA_DIR" ] || return 1
  [ "$DATA_DIR" = "/" ] && return 1
  [ "$DATA_DIR" = "$HOME" ] && return 1
  return 0
}
leftover_backend_pids() {
  pgrep -f "ScienceDiscovery[.]app/Contents" 2>/dev/null || true
  if data_dir_safe_for_match; then
    ps axo pid=,command= | grep -F -- "$DATA_DIR" \
      | grep -E "python|jiuwenswarm|start-stack" | grep -v grep | awk '{print $1}' || true
  fi
}

kill_leftover_backend() {
  local pids round=0
  pids="$(leftover_backend_pids | sort -u | tr '\n' ' ')"
  [ -z "$pids" ] && return 0
  printf '%s\n' "  ${YELLOW}检测到后端残留进程（pid：$pids）${OFF}"
  echo "  壳已退出但后端仍在运行（detached 独立进程组）——结束它们再动数据目录，"
  echo "  避免移走正被写入的文件。kill -9 不级联子进程，故循环重扫直至干净。"
  while [ -n "$pids" ] && [ "$round" -lt 3 ]; do
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
    pids="$(leftover_backend_pids | sort -u | tr '\n' ' ')"
    round=$((round + 1))
  done
  if [ -n "$pids" ]; then
    printf '%s\n' "  ${RED}⚠ 后端进程未能结束（pid：$pids）${OFF}"
    printf '%s\n' "  ${RED}  数据目录可能正被写入；请手动结束上述进程后再清空废纸篓。${OFF}"
  else
    printf '%s\n' "  ${GREEN}后端残留进程已结束${OFF}"
  fi
}

# --- 关键数据备份 -------------------------------------------------------
backup_critical() {
  local d="$1" n=0 item
  mkdir -p "$BACKUP_DIR"
  for item in "model-secrets.key" "messages" "catalog.sqlite"; do
    if [ -e "$d/$item" ]; then
      if cp -R "$d/$item" "$BACKUP_DIR/$item" 2>/dev/null; then
        echo "  已备份：$item"
        n=$((n + 1))
      fi
    fi
  done
  if [ -f "$WIZARD_JSON" ]; then
    cp "$WIZARD_JSON" "$BACKUP_DIR/wizard-state.json" 2>/dev/null
  fi
  if [ "$n" -gt 0 ]; then
    echo "  备份位置：${BACKUP_DIR}（重装后可从中恢复密钥与会话）"
  else
    echo "  数据目录里没有可备份项"
    rmdir "$BACKUP_DIR" 2>/dev/null || true
  fi
}

# --- 移废纸篓（不直接删除） ----------------------------------------------
# F19: 目标名带来源父目录前缀——两组落点 basename 相同（Caches 与 Logs 下的
# sd-shell、HTTPStorages 与 WebKit 下的 cn.sciencediscovery.desktop），
# 同批共用一个 STAMP 时 BSD mv 会把第二个塞进第一个 Trash 目录内部。
# 前缀仍会撞（/Applications 与 ~/Applications 的父目录名都是 Applications），
# 故再加存在性探测 + 计数器兜底：目标已存在就取下一个空位，绝不嵌套。
to_trash() {
  local p="$1" base prefix target n=0
  [ -e "$p" ] || return 0
  base="$(basename "$p")"
  prefix="$(basename "$(dirname "$p")")"
  target="$HOME/.Trash/${prefix}-${base}-${STAMP}"
  while [ -e "$target" ]; do
    n=$((n + 1))
    target="$HOME/.Trash/${prefix}-${base}-${STAMP}-${n}"
  done
  if mv "$p" "$target" 2>/dev/null; then
    printf '%s\n' "  ${GREEN}→${OFF} 已移废纸篓：$base"
  else
    printf '%s\n' "  ${RED}⚠ 移入废纸篓失败，请手动处理：$p${OFF}"
  fi
}

# --- 主流程 -------------------------------------------------------------
printf "${CYAN}${BOLD}ScienceDiscovery 卸载 / 数据清理工具${OFF}\n"
echo "（所有删除均为移入废纸篓，可恢复；关键数据先自动备份）"

# 数据目录来源说明
if [ -f "$WIZARD_JSON" ]; then
  echo "数据目录（自动读自向导记录）：$DATA_DIR"
elif [ "$DATA_DIR" = "$DEFAULT_DATA" ]; then
  echo "数据目录（无向导记录，用默认路径）：$DATA_DIR"
fi

show_list

echo "请选择操作："
printf "  1) ${RED}${BOLD}完全卸载${OFF}      应用 + 全部数据 + 全部状态（重装如新）\n"
printf "  2) ${CYAN}${BOLD}只卸载软件${OFF}    只删应用本体，保留全部数据（重装后直接用原有数据）\n"
printf "  3) ${YELLOW}${BOLD}数据重置${OFF}      保留应用，清数据 + 状态（下次启动重走安装向导）\n"
echo "  4) 查看路径（零副作用）"
echo "  0) 取消"
printf "输入编号后回车 [0-4]："
read -r choice || choice=""

case "$choice" in
  1|2|3) ;;
  4)
    show_list
    echo "未删除任何东西。"
    printf "按回车关闭窗口..."
    read -r _
    exit 0
    ;;
  *)
    echo "已取消，未做任何改动。"
    printf "按回车关闭窗口..."
    read -r _
    exit 0
    ;;
esac

# 确认清单
if [ "$choice" = "1" ]; then
  echo
  printf "${RED}${BOLD}即将完全卸载，以下内容将移入废纸篓：${OFF}\n"
  for p in "${APP_CANDIDATES[@]}"; do [ -e "$p" ] && echo "  - $p"; done
  echo "  - $DATA_DIR"
  echo "  - $SHELL_UD"
  [ -e "$SAVED_STATE" ] && echo "  - $SAVED_STATE"
  for p in "${SCATTER[@]}"; do [ -e "$p" ] && echo "  - $p"; done
elif [ "$choice" = "2" ]; then
  echo
  printf "${CYAN}${BOLD}即将只卸载应用本体（数据全部保留），以下内容将移入废纸篓：${OFF}\n"
  for p in "${APP_CANDIDATES[@]}"; do [ -e "$p" ] && echo "  - $p"; done
  echo
  echo "  保留不动：$DATA_DIR"
  echo "  保留不动：$SHELL_UD"
else
  echo
  printf "${YELLOW}${BOLD}即将清空数据（保留应用本体），以下内容将移入废纸篓：${OFF}\n"
  echo "  - $DATA_DIR"
  echo "  - $SHELL_UD"
  [ -e "$SAVED_STATE" ] && echo "  - $SAVED_STATE"
  for p in "${SCATTER[@]}"; do [ -e "$p" ] && echo "  - $p"; done
fi
echo
printf "确认执行？输入 y 确认，其他任意键取消："
read -r confirm || confirm=""
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "已取消，未做任何改动。"
  printf "按回车关闭窗口..."
  read -r _
  exit 0
fi

echo
echo "== 1/4 退出应用 =="
quit_app

# F22: 任何模式都不该把本产品的残留后端留在系统里（模式 2 移走包后，
# 从包内运行的后端就成了孤儿；模式 1/3 更要动数据目录）。
kill_leftover_backend

if [ "$choice" = "2" ]; then
  # 只卸载软件：数据/状态全保留，无需备份（没删数据），直接删应用本体
  echo
  echo "== 2/4 跳过备份（数据不动，无需备份） =="
  echo
  echo "== 3/4 移入废纸篓 =="
  for p in "${APP_CANDIDATES[@]}"; do to_trash "$p"; done
  echo
  echo "== 4/4 复核 =="
  fail=0
  for p in "${APP_CANDIDATES[@]}"; do
    if [ -e "$p" ]; then
      printf '%s\n' "  ${RED}⚠ 仍存在：$p${OFF}"
      fail=1
    fi
  done
  if [ "$fail" = "0" ]; then
    printf '%s\n' "  ${GREEN}应用本体已移废纸篓${OFF}"
    echo
    echo "完成。数据与状态全部保留："
    echo "  数据目录：$DATA_DIR"
    echo "  状态目录：$SHELL_UD"
    echo "重装新包后启动，直接沿用原有数据（不会重走安装向导）。"
  else
    echo
    printf '%s\n' "${RED}部分项目未能清理，见上方 ⚠ 标记。${OFF}"
  fi
  printf "按回车关闭窗口..."
  read -r _
  exit 0
fi

echo
echo "== 2/4 备份关键数据 =="
backup_critical "$DATA_DIR"

echo
echo "== 3/4 移入废纸篓 =="
if [ "$choice" = "1" ]; then
  for p in "${APP_CANDIDATES[@]}"; do to_trash "$p"; done
fi
to_trash "$DATA_DIR"
to_trash "$SHELL_UD"
to_trash "$SAVED_STATE"
for p in "${SCATTER[@]}"; do to_trash "$p"; done

echo
echo "== 4/4 复核 =="
fail=0
check_gone() {
  if [ -e "$1" ]; then
    printf '%s\n' "  ${RED}⚠ 仍存在：$1${OFF}"
    fail=1
  fi
}
if [ "$choice" = "1" ]; then
  for p in "${APP_CANDIDATES[@]}"; do check_gone "$p"; done
fi
check_gone "$DATA_DIR"
check_gone "$SHELL_UD"
check_gone "$SAVED_STATE"
# F23: SCATTER participates in the final audit too — a failed mv (perms,
# file in use, SIP) otherwise still ends in "全部清理完成", leaving stale
# caches/logs behind while claiming a clean slate. to_trash prints its own
# ⚠ per item; check_gone turns that into the honest end-of-run verdict.
for p in "${SCATTER[@]}"; do check_gone "$p"; done
if [ "$fail" = "0" ]; then
  printf '%s\n' "  ${GREEN}全部清理完成${OFF}"
  echo
  echo "完成。所有内容均在废纸篓（可恢复）；如需彻底释放空间，清空废纸篓即可。"
  [ -d "$BACKUP_DIR" ] && echo "关键数据备份在：$BACKUP_DIR"
else
  echo
  printf '%s\n' "${RED}部分项目未能清理，见上方 ⚠ 标记。${OFF}"
fi

printf "按回车关闭窗口..."
read -r _
