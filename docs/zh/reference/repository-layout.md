# 仓库布局参考

本文列出目录、模块、默认端口及数据落点。组件为何这样分工见[整体运行时架构](../explanation/architecture.md)。

## 1. 代码仓目录排布

Monorepo（pnpm workspace + 若干 Python 子项目）：

```
sciencediscovery/
├── apps/web/                 # React 浏览器 UI（Vite）
├── services/
│   ├── api/                  # Node 控制 API（主业务）
│   ├── gateway/              # 随包 Python MCP server 及其 venv
│   ├── runner/               # bubblewrap 执行器
│   ├── paper/                # PDF worker（uv 项目）
│   └── memory-graph/         # 实验性 ScienceMemory 侧车（默认禁用；需 Neo4j）
├── packages/
│   ├── agent-runtime/        # 系统提示、工作区工具定义、Agent 事件类型
│   ├── schema/               # 共享 TypeScript 类型与 schema
│   └── mcp-sources/          # 科研 MCP Source/Tool manifest 与信任边界
├── skills/                   # 内置 Agent Skills 包
├── scripts/
│   ├── start-stack.sh        # 本地与 Docker 共用的三进程启动入口
│   ├── run-local.sh          # 本地模式兼容包装
│   └── docker-entrypoint.sh  # Docker 模式兼容包装
├── test/                     # 集成检查与用户视角 E2E（不在 pnpm check 内）
│   ├── *.spec.ts             # Playwright 用例
│   ├── api/                  # 现有适配器 smoke；新增 API/CLI 用户旅程驱动的放置目录
│   ├── gateway/              # gateway mock / real smoke
│   └── e2e.package*.json     # Playwright 本地环境引导文件
├── docs/                     # 本目录：中文技术文档
├── data/                     # 运行时状态（gitignored）
├── .e2e/                     # 本地 Playwright 环境（gitignored，由 test/ 引导文件重建）
├── README.md / README_zh.md
└── LICENSE                   # Apache-2.0
```


### 1.1 进程与默认端口

由 `./scripts/start-stack.sh --mode local` 启动（也可继续使用 `./scripts/run-local.sh`）：

| 进程 | 默认地址 | 说明 |
|------|----------|------|
| `services/gateway` | 无端口 | 不再是服务：仅为随包 Python MCP server 提供解释器环境 |
| `services/runner` | `127.0.0.1:4311` | 沙箱执行；仅回环 |
| `services/api` | `127.0.0.1:4310` | 控制 API + 静态 UI；默认仅本机 |

首次启动会在 `.sciencediscovery-data/envs/gateway`、`.sciencediscovery-data/envs/paper` 下用 uv 准备 Python 环境。本仓已无 submodule。

## 2. 模块划分与主要功能

### 2.1 `apps/web` — 前端工作台

- 项目 / 会话导航，归档与删除
- 聊天与工具轨迹、工作区文件、Domain loop（连接器开关）
- **System configuration**（侧栏唯一全局设置入口）：全局默认、模型注册表、科学环境、技能、specialists、权限和连接 token
- 分层运行时设置：Project / Session 菜单中的 Settings（可 Inherit 全局）；与系统配置不是同一对话框
- 权限卡片、审批策略、语义评审结果展示

### 2.2 `services/api` — 控制面（核心）

| 源码区域 | 功能 |
|----------|------|
| `server.ts` | 兼容入口 barrel（re-export `http/`），进程启动点 |
| `http/` | HTTP 壳：路由装配、鉴权、请求体、响应、静态资源 |
| `runs/` | 运行生命周期、SSE 运行流、会话运行编排与并发串行化、workspace 事件过滤 |
| `store.ts` / `store/` | `SessionStore` 门面 + SQLite 目录库；catalog/permissions/secrets/settings/subagents/run-streams 域模块 |
| `subagents/` | subagent handoff、inputs 与私有 workspace |
| `artifacts/` | 产物版本 diff 等 artifact 域 |
| `web-providers/` | Web provider broker、通用 Gateway client 与 workspace 工具 |
| `native-agent/` | **Node 原生 agent loop**：`index.ts`（循环状态机）、`model-client.ts`（流式模型传输）、`deferred-tools.ts`、`compaction.ts` |
| `mcp/` | MCP 治理与进程内客户端：`broker.ts`、`node-client.ts`、`extensions-config.ts`、`source-catalog.ts` |
| `connectors/` | 科学连接器 broker 与 manifest |
| `papers.ts` | 论文搜索下载与 PDF 抽取编排 |
| `runner-client.ts` | 调用 runner 执行 Python / R / shell |
| `provenance.ts` / `reviewer-specialist/` | 执行溯源与 Artifact Reviewer |
| `skills.ts` | 技能库导入、修订、资源读取 |
| `remote-compute.ts` | 实验性远程作业卡（非当前支持主线） |
| `prompt-manifest.ts` | 运行时快照（模型、技能 revision 等） |

主要对外能力：项目管理、Agent 运行、连接器与论文、托管科学环境、技能与 specialist、权限与评审。

### 2.3 `services/gateway` — 随包 Python MCP server

- **不再跑 agent 循环**：agent loop 已原生化到 `services/api` 的 `native-agent/`（见 [Agent 后端](../explanation/agent-backend.md)）
- 无 HTTP 服务：web provider 已原生化到 `services/api/src/web-providers/native/`
- 该 venv 同时为随包的 Python MCP server（biomed、UniProt）提供解释器，由 Node 以 stdio 子进程拉起
- `_engine/`、FastAPI 应用、`deerflow-harness` 依赖及其 submodule 已整体删除；包内依赖收敛为 `mcp` + `httpx`

### 2.4 `services/runner` — 隔离执行

- bubblewrap 命名空间 + seccomp，默认无网络
- Python / R / shell；可选托管科学环境与持久内核
- 墙钟超时、工作区总量与执行输出配额；**无**独立单文件执行配额，也**无** CPU/内存 cgroup 配额
- 全局单 worker：同一时刻只跑一个沙箱任务

### 2.5 `services/paper` — PDF 抽取

- 独立 Python worker，有界抽取：Markdown、表格、插图、页面预览
- 限制：50 MiB、200 页、文本/表/图/预览上限；无 OCR

### 2.6 `packages/*` — 共享库

- **`schema`**：跨包类型（会话、MCP、Artifact、执行结果、权限等）
- **`agent-runtime`**：工作区系统提示、工具列表（包括按需 MCP、显式下载与抽取）、事件类型
- **`mcp-sources`**：科研 MCP manifest、输入校验和 Node 信任边界复核

### 2.7 `skills/` — 内置技能

| 技能 | 用途 |
|------|------|
| `life-science-evidence-brief` | 基于连接器做生命科学证据简报（claim ↔ 引用） |
| `structure-pocket-inspection` | 本地 PDB 结构 / 口袋初检（工作区内 Python） |

技能默认全部可用，可在 Project / Session 中收窄为白名单；运行时冻结 revision 并记入 Prompt Manifest。

### 2.8 `test/` — 集成检查与用户视角 E2E

- E2E 是从用户目标到可观察结果的真实使用旅程，不限于 Web。浏览器旅程使用固定 Playwright，环境在 `.e2e/`，`pnpm ci:e2e` 仅运行 mocked 浏览器子集。
- API/CLI/本机栈旅程通过 `start-stack.sh` 或文档中的等价产品入口启动，从公开接口验证 Run、产物、权限等用户结果；可复用驱动放 `test/api/` 并写明运行命令。这些旅程不自动归入浏览器 CI 层。
- `test/api/run_m1_smoke.sh` 与 `run_real_smoke.sh` 是现有适配器 smoke，直接在进程内构造 Agent，不因目录位置而成为 E2E。当前没有统一的非浏览器 E2E 运行器，需按具体旅程检查或新增驱动。
- 改动用户可观察行为时，实施者随功能新增或完善旅程，已有覆盖需指出并重跑；只有不影响任何用户产品路径的改动才可写“不适用”，不能以“纯后端无 UI”为由跳过。

这些测试不并入默认 `pnpm check`；定义、启动隔离、浏览器装配及 API/栈旅程要求见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#user-perspective-e2e)。

## 3. 数据与配置落点

| 位置 | 内容 |
|------|------|
| `.sciencediscovery-data/catalog.sqlite` | 项目、会话、设置、模型元数据、权限、specialists |
| `.sciencediscovery-data/model-secrets.key` | 提供方 token 加密密钥（AES-256-GCM） |
| `.sciencediscovery-data/projects/.../workspace/` | 每会话工作区与 `papers/` 抽取结果 |
| `.sciencediscovery-data/cas/` 等 | 内容寻址 blob、执行记录、评审、消息 |
| `.sciencediscovery-data/claims/`、`evidence-links/`、`mcp-invocations/` | 证据与 MCP 审计 |
| `.sciencediscovery-data/artifact-jobs/`、`artifact-extraction-jobs/` | 文件下载与 PDF 抽取任务 |
| `.sciencediscovery-data/scientific-envs/` | 托管 Python/R 前缀 |
| `.sciencediscovery-data/envs/gateway`、`paper` | 服务用 Python 环境（可重建） |

环境变量与完整存储布局见[配置参考](configuration.md)。

## 4. 模块数量小结

按 **可独立部署/构建的服务与库** 计数：

| 类别 | 数量 | 成员 |
|------|------|------|
| 前端应用 | 1 | `apps/web` |
| 后端服务 | 5 | `api`、`gateway`、`runner`、`paper`、`memory-graph`（ScienceMemory；实验性，默认禁用） |
| 共享 TS 包 | 3 | `agent-runtime`、`schema`、`mcp-sources`（科研 MCP manifest 与治理校验） |
| 内置技能包 | 2 | life-science / structure-pocket |

**合计约 11 个一等模块**（不含 `test/`、`scripts/`、`docs/`）。

业务能力上还可概括为：**工作台 · Agent 循环 · 沙箱执行 · 科学连接器 · 论文阅读 · 技能/评审/权限 · 托管科学环境** 等功能面；详细科学数据源见[科研连接器](../explanation/science-connectors.md)。

## 5. 相关文档

- [控制面](../explanation/control-plane.md) — `services/api` 内部结构
- [Agent 后端](../explanation/agent-backend.md) — Node 原生 Agent 循环的实现细节
- [内置工具](builtin-tools.md) — 模型可见的内置工具清单
- [沙箱执行](../explanation/sandbox-execution.md) — Runner 沙箱与科学环境
- [评审与溯源](../explanation/review-provenance.md) — 评审与溯源机制
- [科研连接器](../explanation/science-connectors.md) — 连接器与外部库
- [paper-worker.md](paper-worker.md) — PDF 抽取 worker
- [web-frontend.md](web-frontend.md) — 前端结构
- [README_zh.md](../../../README_zh.md) — 安装、运行与快速开始
