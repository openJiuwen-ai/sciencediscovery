# apps/desktop 测试补充计划

本文件记录本次补充用例的范围、优先级和进度。用例先写在一个副本里，随后
整体移植回仓库的 `test/desktop-coverage` 分支；#584 合入后，该分支已重放到
`main`（`0bb6d493`，其中包含 #584 的全部 desktop UI 改动）。下面的文件路径
都是仓库内路径，数量是在这条基线上实测的结果。

## 分层约定

| 层 | 含义 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 纯函数单测 | 直接调用 reducer、格式化、路径、排序等函数 | 输入到输出的边界 | 页面是否接上这些函数 |
| 静态渲染 | `renderToStaticMarkup`，Node 里渲染首屏 | 结构、文案、属性、加载/空态 | effect、点击、请求、持久化 |
| 交互/E2E | 真实浏览器或 DOM 事件 | 用户操作到服务端再回到界面的整条链 | 大量边界组合 |

当前 `apps/desktop` 没有 DOM 测试环境（没有 jsdom/happy-dom），所以
“点了以后发生什么”只能由 E2E 覆盖，或者后续单独引入组件测试环境。

## 图例

- ✅ 已完成：用例已写入并通过
- 🟡 部分：已有静态/纯逻辑断言，但关键行为未覆盖
- ⬜ 待办：没有用例
- 🚫 不适用：纯逻辑场景，不需要 E2E

## CI 层级（与仓库现有分级一致）

仓库的层级定义在 [`.ci/README.md`](../../../.ci/README.md) 与
[`test/support/tagged/profiles.mjs`](../../../test/support/tagged/profiles.mjs)：
`tier:l1`–`tier:l5` 表示“这条用例第一次被需要的最早层级”，默认 `tier:l2`，
高层级累积包含低层级。

| Tier | 触发 | 内容 | 本表 |
|---|---|---|---|
| L1 | PR（含草稿） | 架构、文档、测试目录、E2E 元数据检查；不启动服务 | 无——L1 是仓库检查，不是业务用例 |
| L2（`pr`） | 非草稿 PR、合并到默认分支 | 无外部凭据的 UT/ST/mock E2E | 69 条 mock E2E + 561 条单测/静态 |
| L3（`merge`） | merge queue | L2 + 真实 API 短旅程 + 二进制/Docker | 7 条场景另有 8 个真实变体（`e2e-real/`） |
| L4（`daily`） | 每日 | L3 + 夜间研究用例 | 暂无 |
| L5（`release`） | 发版 | L4 + BiomniBench 全量 | 暂无 |

不带真实后端的 desktop 用例是 hermetic 的：单测与静态渲染不打网络，E2E 在
浏览器里用 `page.route` mock 掉 `/api/**`，因此都属于 **L2**。P0–P4 分组表示补
用例的先后（重要程度），CI tier 表示这条用例在哪个门禁被执行，两者不是一回事。

标成 **`L2 / L3`** 的行有两个变体：L2 是无凭据的 default 用例，L3 是同一场景
的真实变体，写在 `apps/desktop/e2e-real/`，带
`@model:real` + `@tier:l3`。真实变体在缺少凭据或服务栈时以具名原因跳过，
不会静默通过。

## L3 用例（已实现，需真实栈）

| 场景 | 为什么 mock 不够 | 用例 |
|---|---|---|
| P1-06 空工作区首跑 | “测试连接”要真的打到一个模型供应商 | `setup.real.spec.ts`（要求模型目录为空） |
| P3-02 停止运行 | 取消要真的中断服务端的 run，而不只是发出 POST | `conversation.real.spec.ts` 的 Stop 用例 |
| P3-05 模型测试连接 | 延迟与供应商错误只有真实端点能给 | `models.real.spec.ts` |
| P3-10 Runner 资源与 NPU | 资源条与设备选择来自真实主机 | `runner.real.spec.ts`（远端资源需已连接 Runner） |
| P4-04 发送到流式回答 | 真实模型的流式事件顺序与断线续传 | `conversation.real.spec.ts` |
| P4-05 工具授权 | 授权后真实工具调用要继续执行 | `permission.real.spec.ts` |
| P4-06 上传到产物预览 | 真实上传落盘与读取 | `workspace.real.spec.ts`（产物生成仍由既有 real API 套件覆盖） |

实跑记录（2026-10-27，本机 `http://127.0.0.1:4310`，用 `E2E_MODEL_ID` 复用栈上已有模型档案）：**7 passed / 1 skipped**。为远端 Runner 资源用例另起了一个独立 store 的 Runner（loopback，非 SSH），用 `POST /api/runners` 注册并 `connect` 到 `ready`，跑完已删除注册、停进程、清数据。唯一跳过的是 `setup.real.spec.ts`（模型目录非空），按名跳过而非静默通过。

实跑修正了 4 处测试侧问题：

1. `approvalMode` 不能与 `modelId`/`title` 同在一个 PATCH 里（服务端要求独立请求），夹具改为两次 PATCH。
2. 上传成功后产品会自动展开工作区面板，因此不能再点「工作区面板」按钮（此时按钮已消失），改为直接断言「工作区」标签出现。
3. 服务端 keep-alive 空闲 5 秒即关连接，长 UI 步骤后的 REST 断言会撞上 `ECONNRESET`；`api()` 与清理请求改为 `connection: close`。
4. 连通性探测只给 8 个合成 token；推理模型可能把预算花在 reasoning 上并返回 `finish_reason: length`，产品判为 inconclusive。`models.real.spec.ts` 现在在这种供应商响应下具名跳过，而不是把端点判坏；换一个能在 8 token 内收尾的模型即通过。

## 优先级总表

### P0 — 数据契约（所有用户写操作都会经过）

| 编号 | CI tier | 场景 | 层 | 现状 | 计划用例 | 状态 |
|---|---|---|---|---|---|---|
| P0-01 | L2 | Project/Session 读取：列表、按状态过滤、详情、创建、更新、runs、subagents | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-02 | L2 | 停止：指定 run 取消、当前 run 取消 | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-03 | L2 | 工作区文件/产物：列表、产物版本列表、读取文件内容、读取产物版本内容 | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-04 | L2 | 删除会话必须回传 `confirmationId` | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-05 | L2 | 项目 Runner 允许列表：完整发送、`local` 不被省略 | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-06 | L2 | 上传：一次 multipart 装整批、冲突策略、返回真实路径 | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-07 | L2 | 上传上限：从 `/api/health` 读取，缺失时为 `undefined` | 单测 | ⬜ | `api-sessions.test.ts` | ✅ 已完成 |
| P0-08 | L2 | 全局/项目设置读写；环境源设置是部分更新 | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-09 | L2 | 技能开关：同一写入里固定 `selected` 模式并保留其他 override | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-10 | L2 | 网络：代理默认策略/服务器 CRUD、MCP 代理策略、沙箱网络、运行时 kernel | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-11 | L2 | 超时/配额/Runner 列表/probe/connect/NPU 选择 | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-12 | L2 | MCP 自定义服务器 CRUD/测试、Web 设置、记忆与 Idea Tree | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-13 | L2 | 专家 CRUD | 单测 | ⬜ | `api-settings.test.ts` | ✅ 已完成 |
| P0-14 | L2 | 远程机器：注册、凭据、信任 host key、删除 | 单测 | ⬜ | `api-remote.test.ts` | ✅ 已完成 |
| P0-15 | L2 | 远程机器：生成密钥、连接日志轮询 | 单测 | ⬜ | `api-remote.test.ts` | ✅ 已完成 |
| P0-16 | L2 | 远程机器：ssh_config 列表/解析、密钥文件浏览与分页 | 单测 | ⬜ | `api-remote.test.ts` | ✅ 已完成 |
| P0-17 | L2 | 权限决定：路径、`decision` body、返回的整批结果 | 单测 | ⬜ | `api-permissions.test.ts` | ✅ 已完成 |
| P0-18 | L2 | 模型：health、providers、models、provider CRUD、预览模型、加模型 | 单测 | ⬜ | `api-models.test.ts` | ✅ 已完成 |
| P0-19 | L2 | 默认模型：先读后写、保留其他 override | 单测 | ⬜ | `api-models.test.ts` | ✅ 已完成 |
| P0-20 | L2 | 失败原样抛给调用方（401/409/网络错误不被吞） | 单测 | ⬜ | 各 API 用例 | ✅ 已完成 |

### P1 — 启动、认证、首次运行（用户能不能进入产品）

| 编号 | CI tier | 场景 | 层 | 现状 | 计划用例 | 状态 |
|---|---|---|---|---|---|---|
| P1-01 | L2 | 认证页：标题/说明、空 token 禁用、提交中禁用、被拒绝文案 | 静态 + 交互 | ✅ | `boot-screens.test.tsx`、`boot.spec.ts` | 已完成；认证页没有独立的“提交中”态——提交即离开门禁进入加载页，按钮随整页消失，重复提交无法发生 |
| P1-02 | L2 | 离线页：unreachable/auth 两种文案、重试按钮忙闲态 | 静态 | ✅ | `boot-screens.test.tsx`、`boot.spec.ts` | 已完成 |
| P1-03 | L2 | 首跑向导：工作区 → 环境自检 → 模型三步，测试并继续后才出现开始使用 | 静态 + 交互 | ✅ | `boot-screens.test.tsx`、`setup.spec.ts` | 已完成；静态用例用 `initialStep` 渲染后两步（Node 里没有 DOM 可点），E2E 走完整三步 |
| P1-04 | L2 | 启动门：loading / offline / setup / ready 互斥 | E2E | ✅ | `boot.spec.ts` | 已完成 |
| P1-05 | L2 | 401 后清 token 并回到认证页 | E2E | ✅ | `boot.spec.ts` | 已完成 |
| P1-06 | L2 / L3 | 空目录首跑：填模型、测试连接、进入主界面 | E2E | 🟡 | `setup.spec.ts`、`e2e-real/setup.real.spec.ts` | L2 已完成；L3 需空栈，默认跳过 |

### P2 — 会话、导航与全局反馈

| 编号 | CI tier | 场景 | 层 | 现状 | 计划用例 | 状态 |
|---|---|---|---|---|---|---|
| P2-01 | L2 | SessionBar：标题、项目、时间、双击重命名、菜单、面板开关 | 静态 + 交互 | ✅ | `session-bar.test.tsx`、`e2e/shell-interactions.spec.ts` | 已完成 |
| P2-02 | L2 | Toast：语气样式、关闭、自动消失、错误停留更久 | 静态 + 交互 | ✅ | `dialogs.test.tsx`、`e2e/shell-interactions.spec.ts` | 已完成（时钟快进验证 4s/8s） |
| P2-03 | L2 | 确认框：取消/确认/遮罩/Escape/焦点 | 静态 + 交互 | ✅ | `dialogs.test.tsx`、`e2e/shell-interactions.spec.ts`、`e2e/settings-interactions.spec.ts` | 已完成；Escape 只关一层（缺陷 8 已由 #565 修复），从设置页打开的确认框仍只能用键盘触发（缺陷 3） |
| P2-04 | L2 | 单字段输入框：回车提交、Escape 取消、空值禁用 | 静态 + 交互 | ✅ | `dialogs.test.tsx`、`e2e/shell-interactions.spec.ts` | 已完成 |
| P2-05 | L2 | 侧栏：相对时间、6 条分页、项目折叠、新建按钮 | 静态 | ✅ | `sidebar-extra.test.tsx` | 已完成 |
| P2-06 | L2 | 侧栏：双击/菜单重命名、删除确认、当前会话删除后回草稿 | E2E | ✅ | `sessions.spec.ts` | 已完成（见已知缺陷 2） |
| P2-07 | L2 | 运行中任务行与“暂无任务”切换 | 静态 | ✅ | `sidebar-extra.test.tsx` | 已完成 |
| P2-08 | L2 | GitHub star：格式化、缓存、离线静默 | 单测 + 交互 | ✅ | `github-stars-extra.test.ts`、`e2e/shell-interactions.spec.ts` | 已完成（缓存跨刷新、离线无数字） |

### P3 — 输入区、面板与设置页首屏

| 编号 | CI tier | 场景 | 层 | 现状 | 计划用例 | 状态 |
|---|---|---|---|---|---|---|
| P3-01 | L2 | 发送：Enter 发送、Shift+Enter 换行、空值禁用、发送后清空 | E2E | ✅ | `conversation.spec.ts` | 已完成 |
| P3-02 | L2 / L3 | 停止按钮：运行中可见、点击调用当前 run 取消 | E2E | ✅ | `conversation.spec.ts`、`e2e-real/conversation.real.spec.ts` | L2 已完成；L3 已在真实栈实跑通过 |
| P3-03 | L2 | 模型菜单与权限浮层：选项、说明、运行中禁用 | 静态 | ✅ | 已有 `composer.test.tsx` | 已完成 |
| P3-04 | L2 | 欢迎页：分类 → 主题 → seed prompt → 清除 | 交互 | ✅ | `landing-extra.test.tsx`、`e2e/shell-interactions.spec.ts` | 已完成 |
| P3-05 | L2 / L3 | 模型设置页：列表、默认标签、测试连接成功/失败 | 静态 + 交互 | ✅ | `settings-screens.test.tsx`、`settings.spec.ts`、`e2e-real/models.real.spec.ts` | L2 已完成（含失败原因与“失败的档案不设为默认”）；L3 真实测试连接已写 |
| P3-06 | L2 | 设置页：导航、折叠、Escape/侧栏退出、每个 pane 立即写入、失败提示 | 静态 + 交互 | ✅ | `settings-screens.test.tsx`、`settings-interactions.spec.ts` | 已完成；#565 之后没有页脚、没有“保存”或“关闭设置”，只有 Escape 与侧栏的「会话」两个出口（见已知缺陷 3、4） |
| P3-07 | L2 | MCP：自定义/内置、编辑、删除、启停、测试、密钥校验 | 静态 + 交互 | ✅ | `settings-screens.test.tsx`、`settings-interactions.spec.ts` | 已完成（见已知缺陷 5）；基线已从页面移除「新增服务器」，用例改为编辑既有服务器（PUT） |
| P3-08 | L2 | 专家：列表、编辑、删除、启停、connector/skill 计数、一键启用/关闭 | 静态 + 交互 | ✅ | `settings-screens.test.tsx`、`settings-interactions.spec.ts` | 已完成；基线已移除「新增专家」，用例改为编辑既有专家（PUT），并覆盖 `BulkToggles` |
| P3-09 | L2 | 超时：读取、保存、校验、0 表示不限 | 静态 + 交互 | ✅ | `settings-screens.test.tsx`、`settings-interactions.spec.ts` | 已完成 |
| P3-10 | L2 / L3 | Runner 资源与 NPU：资源条、设备选择、ssh_config 导入、密钥浏览 | 静态 + 交互 | ✅ | `runner-resources.test.tsx`、`remote-hosts.spec.ts`、`e2e-real/runner.real.spec.ts` | L2 已完成；L3 本地 Runner/远端资源已写，NPU 视主机 |
| P3-11 | L2 | 结构查看器：非结构文件提示、加载失败、原子数、全屏/Escape | 交互 | ✅ | `e2e/structure-viewer.spec.ts`（2 条） | 组件引入 Mol* 样式表与第二个 React root，Node 里无法静态渲染，改为 E2E；首屏 lazy chunk 约 7s，用例给了 30s 上限 |
| P3-12 | L2 | 面板：产物分组折叠、搜索输入、版本切换、读取失败重试、宽度拖动 | 交互 | ✅ | `e2e/panel-interactions.spec.ts`（7 条） | 已完成；基线让面板默认打开「产物」且每个分组都有标题，文件树用例显式切到「工作区」；读取失败后再次点击同一行即重填（`placeDocument` 复用失败页签），分隔条可用方向键拖动、Enter 复位 |
| P3-13 | L2 | 远程机器：登记（SSH/自部署）、host key 信任、凭据、连接/断开、ssh_config 导入、密钥生成、删除、项目允许列表 | 交互 | ✅ | `remote-hosts.spec.ts`（13 条） | 已完成 |

### P4 — 核心用户旅程 E2E

| 编号 | CI tier | 场景 | 层 | 现状 | 计划用例 | 状态 |
|---|---|---|---|---|---|---|
| P4-01 | L2 | desktop e2e 入口：独立配置、能启动 desktop 构建、能 mock API | 基建 | ✅ | `apps/desktop/e2e/` | 已完成 |
| P4-02 | L2 | 认证 → 主界面 | E2E | ✅ | `boot.spec.ts` | 已完成 |
| P4-03 | L2 | 首跑向导 → 主界面 | E2E | ✅ | `setup.spec.ts` | 已完成 |
| P4-04 | L2 / L3 | 新建会话 → 发送 → 流式回答 → 停止 | E2E | ✅ | `conversation.spec.ts`、`e2e-real/conversation.real.spec.ts` | L2 已完成；L3 已在真实栈实跑通过 |
| P4-05 | L2 / L3 | 危险工具授权 → 允许 → 运行继续 | E2E | ✅ | `e2e-real/permission.real.spec.ts` | L3 已在真实栈实跑通过 |
| P4-06 | L2 / L3 | 拖拽上传 → 文件树 → 产物 → 预览 | E2E | ✅ | `workspace.spec.ts`（4 条）、`e2e-real/workspace.real.spec.ts` | L2 已补拖拽、遮罩文案与归档拒收；L3 真实上传/预览已在真实栈实跑通过；产物生成由既有 real API 套件覆盖 |
| P4-07 | L2 | 设置保存 → 关闭 → 重新打开仍在 | E2E | ✅ | `settings.spec.ts` | 已完成 |
| P4-08 | L2 | 重命名/删除会话 → 刷新后仍生效 | E2E | ✅ | `sessions.spec.ts` | 已完成 |

## 实施记录

| 批次 | 内容 | 新增文件 | 结果 |
|---|---|---|---|
| 0 | 建立副本，跑通基线 | — | 362 passed |
| 1 | P0 数据契约 | `api-sessions.test.ts`、`api-settings.test.ts`、`api-remote.test.ts`、`api-permissions.test.ts`、`api-models.test.ts`、`api-stub.ts` | ✅ 已完成 |
| 2 | P1/P2 启动与全局反馈 | `boot-screens.test.tsx`(6)、`dialogs.test.tsx`(6)、`sidebar-extra.test.tsx`(7) | 19 passed |
| 3 | P3 设置页首屏 | `settings-screens.test.tsx`(11) | 11 passed |
| 4 | P4 desktop E2E | `apps/desktop/e2e/{playwright.config,fixtures,boot.spec,setup.spec,conversation.spec,sessions.spec,settings.spec,workspace.spec}.ts`、README、.gitignore | 15 passed |
| 5 | L3 真实后端变体 | `apps/desktop/e2e-real/{playwright.config,support,setup.real,models.real,conversation.real,permission.real,workspace.real,runner.real}.ts`、README、.gitignore | 8 tests；真实栈 + 独立 Runner 实跑 7 passed / 1 skipped；无凭据时 8 skipped（已验证） |
| 6 | P3 设置交互与远程机器 | `e2e/settings-interactions.spec.ts`(20)、`e2e/remote-hosts.spec.ts`(13)、`tests/session-bar.test.tsx`(6)、`tests/runner-resources.test.tsx`(10)、`e2e/fixtures.ts` 扩展（远程机器、NPU、凭据、ssh_config 路由） | 静态 453 passed；desktop L2 e2e 48 passed；typecheck 通过 |
| 7 | P2 外壳交互 | `e2e/shell-interactions.spec.ts`(9) | desktop L2 e2e 57 passed（该 spec 连跑 3 轮稳定） |
| 8 | P3 右侧面板 | `e2e/panel-interactions.spec.ts`(7)、`e2e/fixtures.ts` 扩展（按会话的产物、版本内容、按路径的文件内容） | 7 passed |
| 9 | 结构查看器与拖拽上传 | `e2e/structure-viewer.spec.ts`(2)、`e2e/workspace.spec.ts` +2 | 4 passed；全套 desktop L2 e2e 68 passed |
| 10 | 移植回仓库 `test/desktop-coverage`；#584 合入后重放到 `main`（`0bb6d493`） | 12 个单测文件、`e2e/`、`e2e-real/`、本文件 | 单测按基线改写：`untitled` 文案、`ListSelect`、MCP 单页、设置无页脚；E2E 补 `POST /api/inbox` mock，并按新行为修正设置、启动、面板、远程、结构查看器五组用例；rebase 后重跑：561 静态/单测通过（含 #584 合入时新增的用例）、69 L2 e2e 通过、typecheck 通过 |
| 汇总 | 基线 + 批次 1–10 | 12 个单测文件 + 11 个 e2e spec + 6 个 L3 spec | 561 静态/单测通过，69 L2 e2e 通过，7 L3 通过（1 具名跳过），typecheck 通过 |

## 已知缺陷（补用例时发现，未改动产品代码）

1. **在标题栏改名后，标题不会立即更新。** `PromptDialog` 提交后调用
   `renameSession`，它写入服务端并刷新侧栏列表，但 `state.detail.title`
   没有同步；会话列表已经显示新名字，标题栏仍是旧名字，刷新后才正确。
   证据：`e2e/sessions.spec.ts` 的改名用例先断言侧栏与 PATCH，再刷新断言标题栏。
2. **会话行的 `⋯` 菜单右半部分点不到。** `.sidebar` 是 `position: sticky`，
   形成层叠上下文；`.ctx-menu` 虽然 `z-index: 300`，但被限制在这个上下文里，
   超出 296px 侧栏的部分被右侧 `.main-area` 盖住。真实点击落在空白页面上。
   用例改为点击菜单左缘（`position: { x: 10, y: 10 }`）并在此记录。
3. **从设置页打开的确认框点不到“删除/确认”。** `SystemSettingsDialog` 的
   `.config-backdrop` 是 `z-index: 1200` 的全屏层，确认框的遮罩在其下方，
   确认按钮虽然被画出来，但真实点击会落在设置层的 `.settings-group-detail` 上。
   键盘（Enter）仍能触发同一个动作，所以不是无法完成，而是只能用键盘。
   证据：`settings-interactions.spec.ts`（删除专家、删除 MCP）与
   `remote-hosts.spec.ts`（删除机器）都只能用 `press("Enter")`。
4. **设置页没有任何关闭控件，“点遮罩关闭”也永远触发不了。** 关闭逻辑挂在
   `.config-backdrop` 的 `onMouseDown`（只有 `event.target === currentTarget`
   才关），但 `.config-panel { flex: 1 }` 填满整个 backdrop，中间没有可点的
   空隙；#565 又去掉了页脚与“关闭设置”按钮。于是只剩两条出路：键盘 Escape，
   或侧栏的「会话」。指针用户如果不知道后者，会觉得被困在设置里。
   `settings-interactions.spec.ts` 与 `settings.spec.ts` 都按 Escape 退出。
5. **MCP 测试的 toast 打印原始状态值。** `TEXT.settings.system.mcp.tested(status)`
   直接拼接服务端返回的 `ready`/`error`，中文界面上出现
   “测试结果：ready”。用例按现状断言并在此记录。
6. **SessionBar 在时间不可解析时留下一个孤立的圆点。** `stamp()` 对非法时间
   返回空串，但分隔符 `<span className="sep" />` 无条件渲染，于是标题栏出现
   “项目 · ”后面什么都没有。纯视觉问题，`session-bar.test.tsx` 固定了现状。
7. **信任 host key 的请求多带一个 `trusted: false`。** 页面把 `RemoteHostKeyState`
   整体交给 `trustRemoteHostKey`，而接口只定义 `{algorithm, fingerprint}`。
   多余字段大概率被服务端忽略，未确认；用例按现状断言。
8. ~~在设置页上按 Escape 会同时关掉它背后的设置页。~~ **#565 已修复**：
   `SystemSettingsDialog` 现在先看 `defaultPrevented`，确认框用
   `claimsEscape` 独占这一下。`shell-interactions.spec.ts` 的用例已改为断言
   “一次 Escape 只关确认框，设置页仍可见”。`ListSelect` 的菜单同样按这一
   规则处理，所以列表开着时按 Escape 只关列表。
9. **启动时打开会话的产物列表被读两遍。** `refreshSessionLists` 对侧栏里每个
   会话调用一次 `readSessionArtifacts`，`refreshPanel` 又为当前会话单独读一次
   `artifact-outputs`，后者不查前者已经建立的缓存，于是同一个 GET 并发两次。
   对其他会话没有影响（缓存生效），只是启动时多一次请求。
   `panel-interactions.spec.ts` 的跨会话用例按现状只断言“非当前会话只读一次”。
10. **产物面板只知道「最近会话」的标题，项目内会话改名后分组标题不跟着变。**
    `App.tsx` 把 `state.recent`（收件箱的会话）传给 `WorkspacePanel`，而
    `artifactGroups` 用这份列表找“会话的当前标题”。项目里的会话不在其中，
    分组只能退回产物记录里的 `createdInSessionTitle`，于是重命名后面板仍用
    旧名字（列表为空时甚至显示“未命名会话”）。`artifact-groups.test.ts`
    用完整列表覆盖了“优先当前标题”，E2E 只能固定接口记录标题这条回退路径。
11. **空工作区启动不再创建“我的工作区”。** 这是 #552 之后的有意改动，不是
    缺陷，但会让按旧行为写的断言失败：`POST /api/inbox` 是启动第一个请求，
    `GET /api/projects` 回答空列表，侧栏显示“还没有项目 / 还没有最近会话”。
    `boot.spec.ts` 的用例已按此改写；mock 里必须有 `POST /api/inbox` 路由，
    否则启动会停在 `not mocked: POST /api/inbox`。

## 运行方式

静态/单测：

```bash
cd apps/desktop
./node_modules/.bin/tsx --test tests/*.test.ts tests/*.test.tsx
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

E2E（在仓库根目录；`apps/desktop/e2e/node_modules` 指向 `.e2e/node_modules`）：

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" \
  apps/desktop/e2e/node_modules/.bin/playwright test \
  --config apps/desktop/e2e/playwright.config.ts
```

L3 真实变体（需要服务栈与 `E2E_API_TOKEN`；真实模型用 `E2E_MODEL_ID` 复用栈上已有档案，或用 `E2E_LLM_*` 新建；缺一项就具名跳过）：

```bash
export E2E_API_TOKEN=...
export E2E_BASE_URL=http://127.0.0.1:4410
export E2E_MODEL_ID=...            # 复用已有模型档案，不删除
# 或者：export E2E_LLM_BASE_URL=... E2E_LLM_MODEL=... E2E_LLM_TOKEN=...

PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" \
  apps/desktop/e2e-real/node_modules/.bin/playwright test \
  --config apps/desktop/e2e-real/playwright.config.ts
```
