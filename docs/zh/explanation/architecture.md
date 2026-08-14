# 整体运行时架构

## 1. 产品定位

ScienceDiscovery 是面向 **Linux 本地、单用户** 的科学分析 Agent：浏览器 UI 连接 Node 控制 API，由 Python agent-loop 网关驱动模型对话；工作区工具、沙箱执行、数据连接器、PDF 抽取、权限、溯源与评审均回到 Node 控制面完成。

它不是多租户云服务。API 默认只监听回环地址；认证仅为静态 bearer token 且无 TLS。只有在更换 token、并确保网络可信且受保护后，才应显式监听其他网卡。

## 2. 运行时架构（逻辑视图）

### 2.1 有几个常驻进程？

用 `./ScienceDiscovery serve` 启动时，**产品本身常驻 3 个进程**（启动器后台拉起前两个，前台跑第三个；Ctrl-C 会一并清理后台）：

| # | 进程 | 启动方式 | 默认监听 | 协议角色 |
|---|------|----------|----------|----------|
| 1 | **Gateway** | `data/envs/gateway/bin/python -m science_agent_gateway.server` | `127.0.0.1:4312` | 接收 API 的 `POST /run`，跑 agent 环，流式 NDJSON |
| 2 | **Runner** | `node services/runner/dist/server.js` | `127.0.0.1:4311` | 接收 API 的执行请求，在 bubblewrap 里跑 Python/R/shell；启用时管理白名单 Host NPU job |
| 3 | **API** | `node services/api/dist/server.js` | `127.0.0.1:4310` | 浏览器入口：REST + SSE + 静态 UI；并回调收工具执行 |

```
                    浏览器（不是本仓库起的服务进程）
                              │  HTTP :4310
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  进程 ③  services/api          127.0.0.1:4310                │
│  控制面 · 会话存储 · 权限/溯源 · 连接器 · 静态 Web             │
└───────────────┬─────────────────────────────┬───────────────┘
                │ POST /run :4312             │ 执行请求 :4311
                │ NDJSON 流式响应             │
                │ ◀── tool-exec 回调 ──┐      │
                ▼                      │      ▼
┌───────────────────────────┐          │  ┌──────────────────────────┐
│  进程 ①  services/gateway │          │  │  进程 ②  services/runner │
│  127.0.0.1:4312           │──────────┘  │  127.0.0.1:4311          │
│  LangChain agent 环       │  同源机回环   │  bubblewrap 沙箱执行     │
│  （库依赖 deer-flow）     │              │                         │
└─────────────┬─────────────┘              └────────────┬───────────┘
              │ 出站 HTTPS                              │ 子进程 bwrap/python/R
              ▼                                         ▼
     用户配置的 OpenAI 兼容模型 API              会话工作区里的用户代码
```

**要点：**

- **3 个常驻 HTTP 服务进程** = gateway + runner + api。浏览器只是客户端。
- Gateway / Runner **始终只绑回环**，API 也默认只绑回环；对外暴露 API 必须显式配置。
- 一轮聊天时：浏览器只跟 **API:4310** 说话；API 再去调 gateway / runner；gateway 需要跑工具时再 HTTP 回调 API 的 `/internal/tool-exec`（仍是本机）。

### 2.2 哪些「模块」不是常驻进程？

架构图里的 **paper**、**deer-flow** 容易被理解成独立服务，实际不是：

| 名称 | 是否常驻进程 | 实际形态 |
|------|--------------|----------|
| **services/paper** | 否 | PDF 需要时，API 用 `execFile` **按次拉起** `paper_worker.py` 子进程，跑完退出 |
| **deer-flow** | 否 | **Python 库**（submodule + `deerflow-harness`），装进 gateway 的 venv，**不单独起端口、不单独收 HTTP** |
| **apps/web** | 否（生产路径） | 构建为静态资源，由 **API 进程** 从 `apps/web/dist` 托管；开发时可用 Vite 另起 `:5173`（可选） |
| **services/memory-graph** | 否（默认） | 实验性可选侧车（Python，仅回环 `:17674`）；在 System Settings 中启用并配置后由启动脚本拉起，禁用时 API 写入为静默 no-op |
| **持久内核 / bwrap 任务** | 否（按需） | Runner 在执行代码时派生子进程；空闲超时后回收 |
| **Host NPU Broker job** | 否（按需） | 仅当 `SCIENCE_AGENT_NPU_BROKER=1` 时由 Runner 启动白名单宿主 workload；不是独立 daemon，不开放任意命令 |
| **外部模型 / PubMed 等** | 远端 | 出站 HTTPS，不是本机进程 |

因此：逻辑上可以画多个「模块」，**运行时默认同机常驻只有 3 个进程**（启用 Science Memory 时 +1；Host NPU Broker job 只是 Runner 按需派生的子进程）。

### 2.3 deer-flow 会单独起一个进程收 HTTP 吗？

**不会。**

- 仓库里的 `third_party/deer-flow` 是上游项目源码（git submodule），**本产品没有启动 deer-flow 官方 server / 前端 / 其 runtime**。
- `services/gateway` 通过 uv 把 `deerflow-harness` 装成依赖；所有 `deerflow.*` 接缝集中在 Gateway 私有 `_engine/` adapter，主流程只使用通用接口。
- 对外收 HTTP 的是本仓库自己的 **`science_agent_gateway.server`（FastAPI）**，端口默认 **4312**，接口是本产品的 `GET /health` 与 `POST /run`，**不是** deer-flow 原版 HTTP API。
- Agent 循环用的是 LangChain 的 `create_agent`（与 deer-flow 客户端内部同类接缝），参数（system_prompt、tools、model、历史）全部由 Node API 在每次 `/run` 里传入。

一句话：**deer-flow = gateway 进程里的库；收 HTTP 的是 gateway 自己，不是第二个 deer-flow 守护进程。**

### 2.4 一轮用户消息的时序（跨进程）

1. 浏览器 → **API:4310**（SSE/REST）提交用户消息。
2. API 组装 `GatewayAgent`：系统提示 + 本会话工具表 + 模型密钥。
3. API → **Gateway:4312** `POST /run`（body 含 messages、tools、model、callback_url）。
4. Gateway 在进程内 `create_agent` + 调外部模型 API；模型要调工具时：
   Gateway → **API** `POST /internal/tool-exec`。
5. API 执行真实工具（可能再 → **Runner:4311** 跑 Python，或连接器出站，或读工作区文件）。
6. 工具结果返回 gateway，继续 loop，直到 gateway 推送 `end`（含 `final_messages`）。
7. API 把事件转成前端 `AgentEvent`，经 SSE 推给浏览器；历史由 API 落盘。

Gateway **无会话状态**：下一轮必须由 API 再次带上完整 `messages`。

### 2.5 职责切分（核心原则）

| 层 | 是否常驻 | 职责 | 不负责 |
|----|----------|------|--------|
| **Web** | 静态资源 / 可选 dev server | UI、流式展示、权限卡片、配置 | 业务权威状态 |
| **API (Node)** | 是（:4310） | 会话状态、工具真实执行、MCP 治理、权限/溯源/评审、存储 | 模型 agent 循环本身 |
| **Gateway (Python)** | 是（:4312） | 跑模型循环、MCP 查询与 provider 重试 | 沙箱、权限、治理持久化 |
| **Runner** | 是（:4311） | bubblewrap 代码执行；启用时管理白名单 Host NPU Broker job | 业务语义、任意宿主 shell |
| **Paper** | 否（按次子进程） | 有界 PDF 抽取 | 联网检索 |
| **deer-flow** | 否（库） | 模型适配补丁等 | 独立 HTTP 服务 |
