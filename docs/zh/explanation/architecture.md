# 整体运行时架构

## 1. 产品定位

ScienceDiscovery 是面向 **Linux 本地、单用户** 的科学分析 Agent：浏览器 UI 连接 Node 控制 API，**agent 循环就跑在这个 Node 控制面进程内**；工作区工具、沙箱执行、数据连接器、PDF 抽取、权限、溯源与评审同样在 Node 控制面完成。

它不是多租户云服务。API 默认只监听回环地址；认证仅为静态 bearer token 且无 TLS。只有在更换 token、并确保网络可信且受保护后，才应显式监听其他网卡。

## 2. 运行时架构（逻辑视图）

### 2.1 有几个常驻进程？

本地用 `./scripts/start-stack.sh --mode local` 启动时，**产品本身常驻 2 个进程**（脚本后台拉起 Runner，前台跑 API；Ctrl-C 会一并清理后台）。原有 `./scripts/run-local.sh` 仍是转调该模式的兼容入口：

| # | 进程 | 启动方式 | 默认监听 | 协议角色 |
|---|------|----------|----------|----------|
| — | ~~Gateway~~ | 已删除 | — | web provider 原生化后该服务不再存在；`services/gateway` 仅作为随包 Python MCP server 的解释器环境保留 |
| 2 | **Runner** | `node services/runner/dist/server.js` | `127.0.0.1:4311` | 接收 API 的执行请求，在 bubblewrap 里跑 Python/R/shell；启用时管理白名单 Host NPU job |
| 3 | **API** | `pnpm api` → `node services/api/dist/server.js` | `127.0.0.1:4310` | 浏览器入口：REST + SSE + 静态 UI；**agent 循环、模型调用、工具执行、MCP 客户端都在这个进程内** |

```
                    浏览器（不是本仓库起的服务进程）
                              │  HTTP :4310
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  进程 ②  services/api                     127.0.0.1:4310        │
│  控制面 · 会话存储 · 权限/溯源 · 连接器 · 静态 Web                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Node 原生 agent loop（native-agent/）                     │  │
│  │  模型流式传输 · 工具调度 · 延迟工具 · 历史压缩              │  │
│  │  进程内 MCP 客户端（mcp/node-client.ts）                    │  │
│  │  原生 web provider（web-providers/native/）                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────┬───────────────────────┬──────────────────────┬───────────┘
       │ 出站 HTTPS            │ 出站 HTTPS           │ 执行请求 :4311
       │ 模型 API              │ 搜索/抓取厂商 API    │
       ▼                       ▼                      ▼
用户配置的模型 API      tavily / exa / brave   ┌──────────────────────────┐
(OpenAI 兼容 /          bing / duckduckgo      │  进程 ①  services/runner │
 Anthropic)             jina                   │  127.0.0.1:4311          │
                                               │  bubblewrap 沙箱执行     │
                                               └────────────┬─────────────┘
                                                            │ 子进程 bwrap/python/R
                                                            ▼
                                                 会话工作区里的用户代码

  services/gateway 不再是进程：它的 venv 只为随包的 Python MCP server
  （biomed、UniProt）提供解释器，由 API 以 stdio 子进程按需拉起。
```

**要点：**

- **3 个常驻 HTTP 服务进程** = api + runner + gateway。浏览器只是客户端。
- **模型对话由 API 进程直接发起**，不再有「API 把一轮对话转交给 gateway」这一跳，也不再有 gateway 回调 API 的 `/internal/tool-exec`。
- Runner **始终只绑回环**，API 也默认只绑回环；对外暴露 API 必须显式配置。
- 一轮聊天时：浏览器只跟 **API:4310** 说话；API 直接调模型 API、web provider 和 runner，没有 gateway 这一跳。

### 2.2 哪些「模块」不是常驻进程？

架构图里的 **paper**、**deer-flow** 容易被理解成独立服务，实际不是（deer-flow 已整体移除）：

| 名称 | 是否常驻进程 | 实际形态 |
|------|--------------|----------|
| **services/paper** | 否 | PDF 需要时，API 用 `execFile` **按次拉起** `paper_worker.py` 子进程，跑完退出 |
| **deer-flow** | 已移除 | agent 循环与 web provider 都在 Node 进程内实现，gateway 的 venv 不再安装 `deerflow-harness`，对应 submodule 也已删除 |
| **apps/web** | 否（生产路径） | 构建为静态资源，由 **API 进程** 从 `apps/web/dist` 托管；开发时可用 Vite 另起 `:5173`（可选） |
| **services/memory-graph** | 否（默认） | 实验性可选侧车（Python，仅回环 `:17674`）；在 System Settings 中启用并配置后由启动脚本拉起，禁用时 API 写入为静默 no-op |
| **持久内核 / bwrap 任务** | 否（按需） | Runner 在执行代码时派生子进程；空闲超时后回收 |
| **Host NPU Broker job** | 否（按需） | 仅当 `SCIENCE_AGENT_NPU_BROKER=1` 时由 Runner 启动白名单宿主 workload；不是独立 daemon，不开放任意命令 |
| **外部模型 / PubMed 等** | 远端 | 出站 HTTPS，不是本机进程 |

因此：逻辑上可以画多个「模块」，**运行时默认同机常驻只有 2 个进程**（启用 Science Memory 时 +1；Host NPU Broker job 只是 Runner 按需派生的子进程）。

### 2.3 agent 循环跑在哪个进程？

**跑在 API 进程（`services/api`）内。**

- 循环实现是本仓库自己的 TypeScript：`services/api/src/native-agent/`，入口 `createNativeAgent`。**不使用 LangChain / LangGraph**。
- 模型调用由 API 进程用 `undici` 直接发出，支持 OpenAI 兼容与 Anthropic Messages 两种方言。
- 模型要调工具时，循环**直接在进程内 `await` 工具处理器**；`packages/workspace` 构建工作区工具，`packages/tools` 负责注册与调度，API 注入具体基础设施适配器，不存在跨进程回调。
- MCP 由 API 进程用官方 TypeScript SDK 直连（stdio 子进程 / SSE / streamable-HTTP）。随包的 Python MCP server（biomed、UniProt）以 stdio 子进程启动，**解释器来自 gateway venv**——这是 gateway 环境仍需存在的第二个原因。

模块级说明见 [agent-backend.md](agent-backend.md)。

### 2.4 一轮用户消息的时序（跨进程）

1. 浏览器 → **API:4310**（SSE/REST）提交用户消息。
2. API 组装 `AgentProfile` + 工作区选项，`createAgentRun` 建出 `NativeAgent`：系统提示 + 本会话工具表 + 模型 endpoint。
3. API 进程内循环：流式调用**外部模型 API**（出站 HTTPS），文本/推理增量实时经 SSE 推给浏览器。
4. 模型返回 tool call 时，API **在本进程内**执行真实工具（可能再 → **Runner:4311** 跑 Python，或连接器出站，或读工作区文件，或经进程内 MCP 客户端调 MCP server）。
5. 工具结果追加回历史，继续下一轮，直到某轮不再产生 tool call。
6. 循环返回 `finalMessages`；API 落盘历史。

`web_search` / `web_fetch` 的 provider 调用同样从 API 进程直接出站，不再有额外的进程跳转。

### 2.5 职责切分（核心原则）

| 层 | 是否常驻 | 职责 | 不负责 |
|----|----------|------|--------|
| **Web** | 静态资源 / 可选 dev server | UI、流式展示、权限卡片、配置 | 业务权威状态 |
| **API (Node)** | 是（:4310） | **agent 循环与模型调用**、会话状态、工具真实执行、进程内 MCP 客户端与治理、权限/溯源/评审、存储 | 沙箱进程隔离本身 |
| **Gateway (Python)** | 否（仅环境） | 为随包 Python MCP server 提供解释器环境 | 不再是服务：agent 循环、web provider、沙箱、治理都不在这里 |
| **Runner** | 是（:4311） | bubblewrap 代码执行；启用时管理白名单 Host NPU Broker job | 业务语义、任意宿主 shell |
| **Paper** | 否（按次子进程） | 有界 PDF 抽取 | 联网检索 |
| **deer-flow** | 已移除 | — | 全部：agent 循环与 web provider 都是本仓自有代码 |
