# Windows 构建指南

> 适用：在 Windows 10/11 原生环境（非 WSL）从 clone 到构建 ScienceDiscovery 后端。
> 验证记录：2026-10-14，Windows 11 23H2（22631），Node v24.21.0 / pnpm 11.1.2，
> 干净 worktree 副本三命令全绿 + `pnpm architecture:check` 通过。
> 范围说明：本文只覆盖**构建层**（install / build / typecheck）。
> 启动脚本（`run-local.sh` / `start-stack.sh`）是 Linux/macOS 形态；Windows 原生
> 启动链（`scripts/start-stack.mjs` 等）由后续运行时 PR 交付，届时更新本文。

## 1. 前置条件

| 工具 | 要求 | 说明 |
| --- | --- | --- |
| Git | 任意现代版本 | **必须** `git config --global core.longpaths true`（仓库内最长路径约 210 字符，深目录 clone 会超 MAX_PATH） |
| Node.js | ≥ 22.19.0（`engines`），建议 24 LTS | 带 `node:sqlite`，无需任何编译工具链 |
| pnpm | 11.1.2（`packageManager` 锁定） | `corepack enable && corepack prepare pnpm@11.1.2 --activate` |
| Python + uv | 可选 | 仅跑 Python 服务测试（paper/gateway/memory-graph/evolve）时需要；构建本身不需要 |

**clone 目录要浅**：推荐 `C:\dev\sciencediscovery` 这类短路径。
Windows 默认 260 字符路径上限（`LongPathsEnabled` 注册表项通常为 0），
仓库内 JiuwenSwarm 文档树单条路径已达约 210 字符，深层父目录会溢出。
可选（管理员）：`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` 的
`LongPathsEnabled` 设为 1，一劳永逸。

## 2. 三命令

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

预期结果（干净副本实测）：

| 命令 | 退出码 | 耗时参考 | 备注 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | ~1 min | 389 包；cpu-features/ssh2 的原生构建被仓库 `allowBuilds` 刻意关闭（纯 JS 回退），无需 C/C++ 编译器 |
| `pnpm build` | 0 | ~2–4 min | 全 workspace tsc + web 打包（rolldown-vite，win32-x64 有官方预编译） |
| `pnpm typecheck` | 0 | ~2 min | 含 `tsconfig.tests.json` 的测试文件检查 |
| `pnpm architecture:check` | 0 | ~5 s | 组件边界守卫（CI 强制），Windows 下需 ≥ 本修复版本 |

## 3. 国内网络加速

仓库的 `SCIENCE_AGENT_NPM_REGISTRY` 只作用于 `start-stack.sh` 内部的
`pnpm install`，**对手动构建无效**。手动构建时用以下任一方式：

```bash
# 方式一：单次生效
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com

# 方式二：项目级 .npmrc（勿提交）
echo registry=https://registry.npmmirror.com >> .npmrc
```

## 4. 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm install` 卡在 esbuild | esbuild postinstall 要下载 win32-x64 二进制 | 换镜像（§3）或重试；仓库已将其列入 `allowBuilds: true` |
| `git checkout` 报路径过长 | 未开 `core.longpaths` | §1 表格第一行 |
| `uv venv` / 原生 exe 在深目录报 `File name too long` | MAX_PATH（260） | 浅目录 clone；或开 `LongPathsEnabled` |
| `node --version` 低于 22.19 | engines 不满足 | 升级 Node；`node:sqlite` 是硬性依赖 |
| 杀毒软件锁文件导致 install 失败 | Windows Defender 实时扫描 | 把仓库目录加入排除列表 |

## 5. 平台边界（当前 Windows 上**不可用**的命令）

启动链目前只有 Linux/macOS 的 bash 形态（`pnpm start` / `pnpm server` 实际执行
`bash scripts/run-local.sh`，见 `package.json` 的 `scripts`）。Windows 原生等价物
（`scripts/start-stack.mjs` / `scripts/jiuwenswarm.mjs`）由后续运行时 PR 交付，
**本 PR 树内尚不存在**；在此之前请用 Git Bash 或 WSL 运行原命令。

| 原命令（bash） | Windows 现状 |
| --- | --- |
| `pnpm start` / `pnpm server`（`run-local.sh`） | Git Bash / WSL 下可用；原生等价物（`start-stack.mjs`）后续 PR 交付 |
| `pnpm start:jiuwenswarm` / `pnpm jiuwenswarm:*`（`start-stack.sh` / `jiuwenswarm.sh`） | 同上（`jiuwenswarm.mjs` 后续 PR 交付） |

仍不可用（无 Windows 等价物）：

| 命令 | 原因 |
| --- | --- |
| `pnpm ci:e2e:legacy` | 调用 `.ci/run-e2e.sh` |
| `pnpm runner:binary` | SEA 单文件打包，Linux-only（`.mjs` 在非 Linux 平台自动跳过该步） |
| `start-stack.sh --mode docker` | 暂无 Windows 等价物；请用 WSL 运行原 bash 脚本 |

Windows 侧已知行为差异：runner 沙箱依赖（bubblewrap/seatbelt）不存在，runner 以
`ready:false` 优雅降级启动（direct-execution provider 语义）；科学环境
（micromamba）由后续运行时 PR 交付。

Linux/macOS 侧回归说明：本 PR 未改动任何 bash 启动脚本，双平台启动链不回归。
