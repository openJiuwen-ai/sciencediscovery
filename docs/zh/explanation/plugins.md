# 插件化机制

ScienceDiscovery 按能力归属组织 `packages/`，组件通过插件入口接入 API 和 Web 宿主。插件是**可信、构建期安装的扩展**，不是与领域包并列的另一份功能实现。`services/` 负责进程启动和装配；当前整改保留 AgentLoop、工具名、权限、项目配置及存储语义。

本文描述当前实现。需求见 [Issue #80](https://gitcode.com/openJiuwen/sciencediscovery/issues/80)，相关运行原理见 [Agent 后端](agent-backend.md)、[子 Agent 编排](subagent-orchestration.md) 和 [CAS](cas.md)。

## 1. 基座与插件如何协作

```text
安装清单 + global/project/session 配置
                  │ 校验、能力协商、冻结 Run 组合
                  ▼
             NativeAgent / 插件宿主
                  │ 注入领域 Ports，create → start → dispose
         ┌────────┼───────────┬───────────────┐
         ▼        ▼           ▼               ▼
       tools   context     stateProviders  batchPolicies
         │     factories      │               │
         ▼        └───── StateView ────┐       │
    ToolRegistry                 ContextAssembler
         │                            │
         └──────── AgentLoop ─────────┘
                 模型 ↔ 工具
                      │
          Recorder / 权限审批 / Runner / CAS

Web 插件入口 → 设置、项目面板、Artifact 视图
                      │
               认证的 scoped Bridge → SessionStore / 领域命令
```

| 所属 | 维护职责 | 代码入口 |
| --- | --- | --- |
| 基座 | AgentLoop 的停止/工具循环；ToolRegistry 的执行、权限和结果提交；ContextAssembler 的预算、投影与校验 | `packages/runtime-core`、`packages/tools`、`packages/context` |
| API 宿主 | NativeAgent 装配、领域 Ports、配置冻结、状态检查点和 Recorder 接线 | `services/api/src/native-agent/`、`services/api/src/plugins/` |
| SDK | manifest、生命周期、服务合同、配置验证、Bridge 和运行贡献类型 | `packages/plugin-sdk/src/` |
| 安装清单 | 明确哪些可信包已随产品安装，不执行用户提供的入口字符串 | `services/api/src/plugins/catalog.ts` |
| Web 宿主 | 设置、项目视图、预览入口登记；提供 UI 能力与认证 Bridge | `apps/web/src/plugins/` |
| 能力组件 | 领域实现、贡献、manifest、配置与视图归同一包；通过 Ports 使用外部能力 | `packages/*` 的 `./plugin`、`./manifest`、`./web` 公开入口 |

运行贡献的类型是 `RuntimeContribution`：`tools`、`contextFactories`、`stateProviders`、`batchPolicies`，以及可选 `commitResult`。它不是任意回调注册表：写状态要经领域命令，通知不能旁路修改权威数据；工具仍受 ToolRegistry、原权限和审批约束。

### 目录归属与单向依赖

`packages/` 回答“谁拥有这项能力”，不要求必须是公共库。`services/` 回答“启动和部署哪个进程”。`apps/web` 是浏览器外壳。顶层不再维护第二套 `plugins/` 功能树；`services/api/src/plugins` 和 `apps/web/src/plugins` 是宿主装配目录，不是领域实现副本。

代码依赖应为 `services/apps → 能力组件 → 公共合同/基础能力`，package 图必须无环。运行时回调可以指向宿主实现，但组件不能反向 import 宿主。例如 Plan 声明 `PlanStore`，API 注入其实现；组件拥有状态命令和投影，宿主提供权威存储与事务，不能因此建立两份数据库双写。

- 跨包只使用 `package.json.exports`，禁止相对路径绕进另一个包的 `src`；类型依赖也计入包图。
- `./plugin` 是运行贡献入口，`./manifest` 是轻量描述，`./web` 是浏览器入口。领域根入口不反向导出 Node 插件工厂；Web 不通过根 barrel 引入服务端代码。
- 接口默认由消费能力或领域所属包定义；仅当需要独立复用/发布或消除实际循环时抽合同包。共享接口不得再依赖具体 Provider。
- 功能专属 worker 可以与组件同目录；独立进程不意味着另建一份功能归属。服务间走协议，组件工厂不负责读取全局环境或自行启动产品服务。
- 必需、可替换和允许用户关闭互相独立；未来平台实现也可组件化，但本次不替换 Loop、权限与执行协议。

`pnpm architecture:check` 包含正反例测试和源码/清单图检查：发现反向宿主依赖、循环、非公开跨包导入，以及 `./web`、`./manifest`、`./views` 经仓内运行时依赖链进入 Node builtin 的问题。检查解析静态导入、再导出、类型导入和字面量 dynamic import/require；非字面量动态加载与第三方包内部仍需构建/评审约束，不是安全沙箱。

**既有债务明确保留：** `packages/executor → @sciencediscovery/runner` 仍存在。它涉及签名、部署版本、科学环境 provisioner 与 Runner 分发，早于本次插件整改。检查仅允许清单中已有的精确文件/依赖边，不放行新增文件，也不豁免循环检查；迁移需单独梳理 Runner 合同与分发产物。本次六个组件没有反向宿主依赖，不宣称全仓已完成服务瘦身。

## 2. 插件包、生命周期与启停

插件包以 `PluginManifest` 声明身份与合同：`id/version/apiVersion`、`entries`、依赖 `requires`、服务 `services`、`permissions`、配置 `configuration`、贡献 `contributes`。`settingsFields` 列明允许该插件设置入口修改的既有业务字段。包路径示例：

```text
packages/plan/
  package.json          exports 指向构建产物
  src/index.ts          领域工具、PlanStore 与上下文实现
  src/manifest.ts       不依赖 Node 运行资源的描述
  src/plugin.ts         API 运行贡献工厂，使用本包领域实现
  src/web.tsx           独立 Web 入口
```

宿主区分四件事：**installed** 是包在清单中；**available** 是依赖与服务合同满足；**authorized** 是宿主授予所需能力；**active** 是当前作用域已成功启动。缺少必需服务、版本不匹配、依赖被关闭都有诊断；可选服务允许未提供。API 清单的可用性不代表某次 Run 已激活。

`createPluginScope` 按依赖顺序构造和启动，失败时清理已创建实例，销毁按逆序执行；`start` 接收 `AbortSignal`，取消必须传递到异步工作。资源释放应幂等。当前是可信进程内扩展，manifest 权限检查不是恶意代码的隔离沙箱。

配置按 **global → project → session** 逐层覆盖，插件配置按 ID/字段合并。省略表示继承；`enabled:false` 是显式关闭。`configuration.applies` 支持 `nextRun` 或 `restart` 声明，当前安装插件均声明 nextRun，不能据此宣称已支持通用热重载。数据源适配器在启动时装配，项目设置在下次运行筛选可用源，不是动态卸载进程级适配器。

**界面与装配能力分开：** “可选扩展”仅提供 JSON 预览开关，不再单独提供 UniProt 或其他内置 MCP 类型的插件总开关。Skill、MCP、Plan、默认多 Agent 调度也不提供整体开关；用户仍在相应入口选择具体 Skill、MCP 服务和连接器。后端配置 API 继续支持所有插件的项目/会话级启停、继承和 nextRun 冻结。已有配置原样保留，不自动启用、不迁移数据。

运行开始固定配置、Skill 资产等组合，主 Agent、子 Agent、reviewer 使用同一组合选择，在各自作用域装配贡献。运行中编辑不会改写已冻结的工具集合。前端设置/查看器会刷新当前显示选择；历史 Plan 和 Artifact 仍可读取，关闭执行贡献不等于删除历史，也不妨碍以后重新配置。

## 3. StateView、模型上下文与版本

完整 Agent State 不是插件共享一个可随意写的大对象，而是检查点上各个命名状态片段的组合：

```text
领域命令 → StateProvider.capture
                 │ { id, schemaVersion, revision, value, fidelity }
                 ▼
           固定 StateView
                 │ contributor 声明 stateReads，只读所需片段
                 ▼
     上下文投影 → 预算/裁剪/校验 → 实际模型输入
                 └──────────────→ Recorder 同检查点溯源
```

`StateCoordinator` 协调领域命令、迁移与采集；Plan 插件通过它包装更新和快照读取。`captureStateView` 对 `captured` 状态连续采集比对，有限重试后仍有变化就失败。外部不可冻结观测标为 `reference-only`，每个检查点只采集并固定一次，不参与本地一致性屏障；兄弟 Agent 的持续进展不会使当前 Agent 无法启动。新检查点重新观测，模型投影和 Recorder 使用同一份固定值。这不是跨服务事务保证，不能把参考观测描述成与本地状态同一时刻的原子快照。

`schemaVersion` 表示数据格式，`revision` 表示该组件状态版本，检查点将各片段关联起来；它们不同于插件包版本或配置组合 revision。`StateView` 校验唯一 ID 和版本、隔离可变引用，contributor 通过 `stateReads` 限定读取范围。缺少必要状态应失败，不应现场再读一份更新数据凑出上下文。

NativeAgent 在调用 assembler 前采集检查点，再把固定视图交给 `DynamicContextAssembler`，让 contributor 基于同一视图生成内容；Recorder 使用该视图对应的状态及上下文记录，不在模型调用后重新抓 live 状态替代。实现入口：`packages/context/src/{state-view,state-coordinator,dynamic-assembler}.ts`、`services/api/src/native-agent/`。

**兼容边界：** Plan 的 `createPlanContextFactory(scopes)` 不再接收 store，没有 StateView 就失败。`durable-state.ts` 的部分通用 contributor 和 NativeAgent 的 `tools.capabilities` 仍保留无 StateView 的旧调用兼容分支；生产动态装配提供 StateView，因此不走该分支。新增插件禁止复制 live fallback，直接调用旧 contributor 的独立消费者也不能把结果宣称为固定检查点投影。

## 4. Bridge 与统一设置写入

Web 通过独立 `./web` 入口交付受宿主登记的组件/视图工厂；设置宿主提供表单、翻译与图标等能力，项目视图和 Artifact 预览通过各自注册入口装配。不是“上传任意 React 文件立即执行”，也不把数据库、凭据或 NativeAgent 实例交给浏览器。

Bridge 复用现有 API bearer 认证和单用户控制面。路径为 `/api/projects/:projectId/plugins`，Session 通过 `?sessionId=...` 限定；路径和 envelope 的 scope 必须一致，Session 必须属于该 Project。

| 接口 | 作用 |
| --- | --- |
| `GET /` | 配置、revision、安装清单及能力诊断 |
| `POST /bridge` | `{apiVersion:1, pluginId, scope, kind, method, input}`，区分 query 与 command |
| 插件 `query/settings`、Plan `query/state({runId})` | 只读设置或历史事件投影 |
| 插件 `command/configure` | `{expectedRevision, settings, fields?, inherit?}`；只能改 manifest 声明的领域字段 |
| `host.settings/command/replace` | `{expectedRevision, overrides}`；一次保存完整作用域表单 |
| `GET /events` | 认证 fetch SSE；`changed` 只通知失效，客户端重新查询；断开释放订阅 |

CAS 比较失败返回 409；越域和非法输入按 Bridge 错误合同拒绝。配置不存明文凭据，敏感访问继续通过现有 secret/权限端口。

设置权威是 `SessionStore`。经典 `replaceGlobalSettings/replaceProjectSettings/replaceSessionSettings`、Composer `updateSession`、Bridge 和 `commitPluginSettings` 共用**catalog 级设置互斥**：全局继承也能改变项目/会话的有效 revision，所以不只锁单个插件或单个 HTTP handler。先取得锁，再读/比较/改写/持久化；过期 CAS 或参数错误不会阻塞后续写入。此锁是单 API 实例内的边界，不是多实例分布式锁。

Bridge 在锁内重新校验 `expectedRevision` 与取消状态；ApplyPort 在同一边界内检查基线并用 SQLite 事务保存设置和回执。经典 PUT 没有新增必填 revision，仍是后提交者覆盖；因此成功应用记录证明“当时成功提交”，不保证用户以后不能再次改设置。新增设置入口必须复用该边界，不能自行持有一把私有锁。

## 5. 已迁移的能力与当前边界

| 包 / 插件 ID | 贡献及复用路径 |
| --- | --- |
| `packages/skill` / `skill` | Skill 工具、渐进披露/目录上下文、状态及选择设置；继续用既有 Skill 目录/库资产 Ports |
| `packages/mcp` / `mcp` | MCP 工具贡献、结果提交与设置；继续用既有 MCP 客户端、来源和权限治理 |
| `packages/mcp-sources` / `connector.<source-id>` | 同包管理 UniProt、LLM Wiki 及 11 个公共生物医学源；每个源独立 manifest 和工厂，共用 MCP 执行与治理能力 |
| `packages/scheduler` / `scheduler` | 默认 `task` 等子 Agent 调度工具；复用既有 orchestration，不另造调度算法 |
| `packages/plan` / `plan` | `update_plan`、批处理策略、协调状态和上下文、项目 Plan 显示 |
| `packages/artifact-json` / `artifact-json` | JSON Artifact Web 预览；关闭后仍可查看原始内容 |

内置源清单为 `uniprot`、`llm-wiki`、`arxiv`、`pubmed`、`europe-pmc`、`biorxiv`、`medrxiv`、`pdb`、`ensembl`、`reactome`、`clinvar`、`chembl`、`geo`。API 从空注册表开始，仅通过 `builtinMcpSourcePlugins` 注册内置源，不再同时执行旧 builtin 装配。LLM Wiki 配置无效时只跳过该源并记录不含 URL 的诊断，其余源继续启动。

实际工具集合是具体源选择与插件配置的交集：MCP 总能力开启、`connector.<source-id>` 未关闭、且源被当前运行选中，才进入后续权限与治理检查。主 Agent、子 Agent、reviewer 和候选比较共用 `filterEnabledMcpSources`；未选中的源不会因插件默认启用而自动授权。自定义 MCP 服务继续由通用 MCP 插件及已有自定义服务注册流程管理，不为用户输入动态导入插件代码。

这些包封装的是能力贡献与入口，不意味着全仓领域逻辑已经完成迁移。Skill/MCP/调度仍复用 `packages/workspace` 提供的工具工厂；API 中的领域控制面也未全部提取。原权限、审批、存储语义及默认工具名保留；相同能力不能同时从旧 Workspace 专属装配和新插件装配注入。既有 evolve 工具目前仍是宿主内部贡献，不是可配置安装插件。

此次移除私有 `@sciencediscovery/plugin-*` 功能包，调用方改用对应能力包的公开子入口；`plugin-sdk` 保留。插件 ID、配置键和资产数据没有改名，不需要用户迁移设置。构建、CI 打包与 Recorder 源码指纹均使用新能力包；既有历史摘要不重写，新 Run 按新构建生成指纹。

最小候选组合由 `services/api/src/plugins/control.ts` 管理：

1. `POST /candidates` 接收 `{expectedRevision,patch}`，仅替换允许的插件配置和 Skill 选择/库资产，基线/候选固定到 CAS，不修改活动组合。
2. `prepare` 创建普通基线与候选实验 Session；使用原 Runner、模型和权限，分别执行相同任务。
3. `compare` 接收两侧 Run ID，检查完成状态、任务及冻结配置，保存实际结果比较；`approve` 是独立管理动作，不是模型自动判优。
4. `apply` 检查资产/配置漂移，原子保存设置与应用回执；拒绝、冲突、事务失败不应用，已应用请求可幂等重试。

**实验保留与清理：** apply/reject 不自动删除 prepare 创建的两个普通 Session，以便用户继续审阅任务、产物与比较依据。确认不再需要时，用户可通过既有 Session 删除界面/API 显式清理，按现有运行中删除检查执行；候选记录保留 Session/Run 引用，删除后不能假定这些引用仍可完整回看。当前没有候选专属自动归档或垃圾回收策略。

比较的保真度是 `observed-runs`，不是确定性任务重放；ApplyPort 不撤销外部工具副作用。插件市场、不可信热加载、AgentLoop/harness 改写、模型训练与完整自动演进均不在本实现范围。

## 6. 如何新增与维护插件

1. **确定能力归属与贡献面。** 优先在已有 `packages/<capability>` 内增加插件入口、配置与 UI，不另建同功能 `plugins/<capability>`。工具、上下文、状态、批策略从 `RuntimeContribution` 开始；连接器和 Web 视图使用对应安装入口。
2. **定义 manifest 和 Ports。** 用独立 `manifest` export 声明稳定 ID、依赖/服务版本、权限、配置字段、生效时机；工厂仅接收实际所需的领域 Ports。不要暴露整个 SessionStore 或 NativeAgent。
3. **实现生命周期与状态。** `create()` 返回贡献及可选 start/dispose；所有异步工作接受取消。状态必须可序列化、可版本化，命令/采集使用一致边界；context factory 声明 `stateReads`，只从 StateView 投影。
4. **接入安装点。** API 在 `catalog.ts` 登记 manifest，`runtime.ts` 注入 Ports；平台类能力参考 UniProt 安装方式。Web 分别在 `settings.tsx`、`project-views.tsx`、`artifact-viewers.tsx` 的对应入口登记。新贡献类型需同时扩展宿主合同，不能仅在 manifest 写一个字符串。
5. **接入构建与发布。** workspace 统一包含 `packages/*`；补齐 `./plugin`、`./manifest`、按需 `./web` exports、宿主依赖、TypeScript 配置和 lockfile，保证 API 发布产物与 Web bundle 都实际包含入口。插件入口导入本包领域实现，不通过自引用形成根入口循环。
6. **验证维护合同。** 测试依赖缺失、启停、取消/失败清理、固定状态投影、配置继承/CAS、主子 reviewer 组合；用户旅程验证关闭后没有新执行通路、历史仍可读。运行 `pnpm typecheck`、`pnpm architecture:check` 和受影响构建/测试。

可从 [Plan 插件入口](../../../packages/plan/src/plugin.ts)、[领域实现](../../../packages/plan/src/index.ts) 与 [manifest](../../../packages/plan/src/manifest.ts) 开始阅读；协议类型见 [SDK](../../../packages/plugin-sdk/src/index.ts)，设置事务见 [SessionStore](../../../services/api/src/store.ts)，完整 HTTP 设置回归旅程见 [plugin-settings-journey](../../../test/api/plugin-settings-journey.mjs)。
