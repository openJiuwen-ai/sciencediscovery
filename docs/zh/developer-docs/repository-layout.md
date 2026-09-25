# 仓库布局参考

本文是给深度开发者和 Code Agent 的代码导航。目录存在不等于拥有业务能力；**能力所有权以 package、公开接口和架构检查规则为准**。

## 1. 顶层结构

```text
sciencediscovery/
├── apps/
│   └── web/                  # React/Vite 浏览器工作台
├── services/
│   ├── api/                  # Node 控制面与 composition root
│   ├── adapter/              # JiuwenSwarm front door / 协议适配
│   ├── runner/               # 沙箱执行 daemon
│   ├── evolve/               # 演进搜索 sidecar
│   ├── memory-graph/         # ScienceMemory 图 sidecar
│   ├── paper/                # PDF 抽取 worker
│   ├── gateway/              # Python MCP server 代码与解释器环境
│   └── launcher/             # 单文件发行启动器
├── packages/                 # 共享能力与领域实现的主要所有者
├── skills/                   # 内置 Skill 包
├── scripts/                  # 启动、打包、架构检查、CI 辅助
├── test/                     # 集成、ST、E2E 与真实环境测试
├── docs/
└── package.json
```

`pnpm-workspace.yaml` 注册 `apps/*`、`services/*`、`packages/*`。Python sidecar 则各自以 uv/pyproject 管理。

## 2. Services：进程与协议装配

### `services/api`

Node 控制面。它负责把 capability package 组合成产品：

- HTTP / SSE / 静态 Web；
- Project / Session / Run 生命周期；
- executor 选择；
- 权限和运行上下文；
- Artifact / provenance / store 的产品级编排；
- sidecar 和 Runner 客户端；
- plugin runtime 装配。

最重要入口：

| 路径 | 作用 |
| --- | --- |
| `src/server.ts` | 进程入口 |
| `src/http/index.ts` | HTTP composition root / 路由主装配 |
| `src/agent-run/create-agent-run.ts` | native / JiuwenSwarm executor seam |
| `src/agent-run/orchestrators.ts` | 主/子 Agent run 编排 |
| `src/native-agent/` | native executor 实现 |
| `src/plugins/` | plugin 与宿主装配 |
| `src/store.ts`, `src/store/` | 产品目录与权威状态 |

不要因为 API 使用某 capability，就把对应 policy 重新写回 `services/api/src`；已有多类旧 service-domain 文件被架构检查禁止重新出现。

### `services/adapter`

JiuwenSwarm 模式的 Python front door：

- 占公共 `:4310`；
- 反代未迁移路由到 API `:4410`；
- 将 ScienceDiscovery run 映射到 JiuwenSwarm；
- 为每个 run 提供 MCP tool bridge 和 LLM proxy；
- 将 JiuwenSwarm frame 映射回 ScienceDiscovery run events。

入口和协议说明：

- `src/sciencediscovery_adapter/agent_runs.py`
- `gateway.py`
- `mcp_server.py`
- `llm_proxy.py`
- `events.py`
- `services/adapter/README.md`

### `services/runner`

隔离执行 daemon。主要负责：

- Linux Bubblewrap / macOS Seatbelt；
- Python/R/Shell 执行；
- managed scientific environments；
- shell/background execution 生命周期；
- sandbox network gateway；
- 可选 Ascend NPU broker；
- 本地 HTTP 或远端 Unix socket Runner。

入口是 `src/server.ts`。业务语义不应下沉到 Runner。

### Python sidecar / worker

| 服务 | 生命周期 | 说明 |
| --- | --- | --- |
| `services/evolve` | 栈启动时 sidecar | 搜索/候选执行服务 |
| `services/memory-graph` | 可配置 sidecar | 图存储 API |
| `services/paper` | 按需 worker | PDF 抽取 |
| `services/gateway` | 非 HTTP daemon | 随包 Python MCP server 与 Python 环境 |

## 3. Packages：能力所有权

当前架构刻意把可复用能力从 `services/api` 下沉到 package。主要分组如下。

### 最底层合同

| Package | 作用 |
| --- | --- |
| `runtime-core` | 与产品领域无关的 runtime message/tool/context 基础合同；仅允许相对 import |
| `schema` | 跨进程/跨模块数据结构与产品 schema |
| `model` | 模型 endpoint、transport、provider 行为 |
| `tools` | Tool 类型、注册和执行合同 |
| `context` | context contributor 机制；只允许依赖 model/runtime-core |
| `plugin-sdk` | plugin manifest/runtime/web 契约 |

### Agent 与执行

| Package | 作用 |
| --- | --- |
| `orchestration` | AgentProfile、主/子 Agent 运行合同 |
| `workspace` | workspace prompt、workspace tools 与运行绑定 |
| `executor` | 本地/远端 Runner 客户端、SSH provision |
| `governance` | 权限与执行治理 |
| `plan` | 计划状态 |
| `trajectory` | trajectory / run context 记录 |

### 科研与产品能力

仓库中还包括 `skill`、`specialist`、`mcp`、`mcp-sources`、`data-source`、`artifact-manager`、`artifact-json`、`provenance`、`memory`、`idea-tree`、`evolve`、`cas`、`scheduler` 等 owning packages。

新增行为前，应先寻找是否已经存在对应 owning package，而不是默认放进 API。

## 4. 强制依赖规则

`scripts/check-architecture.mjs` 是仓库边界的机器可执行定义：

1. `packages/` 不得 import `services/` 或 `apps/`。
2. package/service/test 不应依赖旧 `@sciencediscovery/agent-runtime` compatibility facade。
3. `runtime-core` 只允许相对 import。
4. `context` 只能依赖 `model` 与 `runtime-core`。
5. 已迁移到 packages 的 service-domain 源文件不能重新创建。
6. executor → runner 是冻结的遗留耦合，不是通用豁免。
7. API HTTP entry 必须使用 platform composition root。

执行：

```bash
pnpm architecture:check
```

## 5. 运行入口

| 场景 | 入口 |
| --- | --- |
| 本地 native | `scripts/start-stack.sh --mode local` |
| 本地 JiuwenSwarm | `scripts/start-stack.sh --mode local --jiuwenswarm` |
| Docker | `scripts/start-stack.sh --mode docker` |
| API dev | `pnpm dev` |
| 全仓 build | `pnpm build` |
| 架构检查 | `pnpm architecture:check` |
| 默认检查 | `pnpm check` |
| E2E | `pnpm ci:e2e` / tagged test runners |

## 6. 数据与运行状态

默认运行时根目录为 `.sciencediscovery-data/`。主要类别：

- `catalog.sqlite`：Project、Session、Run、settings、model、permission 等目录实体；
- `projects/.../workspace/`：Session workspace；
- `versioning/` / CAS / artifact records：版本与内容地址对象；
- `execution-runs/`、`run-events/`、`prompt-manifests/`：运行审计与事件；
- `scientific-envs/`：托管科学环境；
- `envs/`：服务 Python 环境；
- `skill-libraries/`：技能库 catalog、版本与内容地址包；
- `logs/`：分服务日志。

精确布局以[配置参考](../reference/configuration.md#存储布局)为准。

## 7. 找代码的推荐顺序

当你要修改某个行为：

1. 从用户可观察入口找到 HTTP / tool / plugin manifest。
2. 确认 owning package。
3. 找 API composition/binding，而不是先改 API policy。
4. 若涉及 executor，分别检查 native 和 JiuwenSwarm adapter。
5. 找同目录或 package 下测试。
6. 运行 architecture check，再运行目标 package test。
7. 用户行为变化补 E2E。

## 相关文档

- [整体运行时架构](architecture.md)
- [深度开发指南](developer-guide.md)
- [控制面](control-plane.md)
- [组件与插件机制](plugins.md)
- [Agent 后端](agent-backend.md)
