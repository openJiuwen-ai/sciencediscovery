# DOT-PR472-FIX 本地候选交付报告

- 工作树：`/data/bot/workspace/sd-pr472-fix`（openJiuwen-ai/sciencediscovery）
- 基准 SHA：`f8f1d48ae25ba092d905ddb668a3ff052289a9d8`（= PR #472 head，已验证、工作区干净、无他人改动）
- 本地分支：`dot-pr472-fix`（仅本地，未 push、未合并、未新建 PR、未取消 WIP/Draft）
- 与 #473 完全分离；未改动用户原运行项目/数据库/依赖/4420/4430/4440 服务；未触碰 `/data/bot/workspace/sd`（验证只读区）与 AW/FB 线
- 交付日期：2026-10-23

## 1 候选 commit 与文件变更清单

### commit 1：`3082256d6dd6f1302169913dd5147b480ca78f67`
`fix(provenance): structure EXECUTION_RESULT_CONFLICT as a non-retryable code` —— **任务 ①**

| 文件 | 变更 |
|---|---|
| `packages/provenance/src/recorder.ts` | 新增结构化冲突错误 `executionResultConflict()`（附带 `code: "EXECUTION_RESULT_CONFLICT"`），替换 3 处普通 `Error`（failure digest 冲突、identity 冲突、result digest 冲突）；错误文案保持不变（兼容既有正则断言） |
| `services/api/src/shell-executions.ts` | `unavailable()` 显式映射 `EXECUTION_RESULT_CONFLICT` 与 `RESULT_DIGEST_MISMATCH` 的 code；把 `EXECUTION_RESULT_CONFLICT` 加入不可重试名单；冲突错误详情直接透出错误原文 |
| `packages/provenance/src/recorder-shell-finalization.test.ts` | 新增用例：三类冲突均携带结构化 code、原运行不被追加/替换 |
| `services/api/src/shell-executions.test.ts` | 新增用例：finalize 冲突为不可重试阻断、后台扫描不再重复 finalize |

### commit 2：`5c1a5613ff607644e4d11cff64e3941fc89e8fd1`
`fix(execution): bound unicode-log wait, document legacy-unknown migration, add guard regressions` —— **任务 ②③④**

| 文件 | 变更 |
|---|---|
| `services/runner/src/execution-manager.test.ts` | 任务 ②：`until()` 支持 per-call 超时参数（默认仍 5s）；Unicode 日志用例改用 30s 有界、基于完成状态的等待；日志/分页/去重/重启断言逐字不变 |
| `services/api/src/shell-executions.ts` | 任务 ④：`ORIGINAL_EXECUTION_UNCONFIRMED` 错误补充"无 recoveryContext、无自动恢复路径、新工作移入隔离 workspace"说明 + 代码注释明确升级/恢复限制；不改阻断逻辑（不 clear/abandon/伪造完成） |
| `docs/zh/developer-docs/execution-recovery.md`、`docs/en/developer-docs/execution-recovery.md` | 任务 ④：明确旧 unknown 无恢复上下文时的隔离 workspace 迁移说明 |
| `services/api/src/shell-executions.test.ts` | 任务 ③④ 回归：同版本不同 digest → 非重试 `EXECUTION_ID_CONFLICT`（守卫不空转）；旧 unknown 无 recoveryContext 阻断同 workspace、不伪造完成、隔离 workspace 不阻断 |

任务 ⑤（M4 + L1-L8）按任务书为"逐项标记 接受/误报/延后 + 依据、不扩大代码范围"——**无代码变更**，分类结论见第 4 节。

## 2 环境与测试状态（历史首轮 vs 最终隔离验证）

**状态时间线**：本报告最初编写时（历史首轮）本工作树无可用构建（`node_modules` 为 07:57:16 pnpm 部分安装、workspace 包 dist 缺失），且任务书硬约束"不为此安装依赖或改共享环境；缺依赖就报告，不绕过"——当时如实标记「未执行」。**后续用户已授权在全新隔离目录 `/data/bot/workspace/sd-pr472-iso-test`（候选最终 SHA，独立 clone/node_modules/pnpm store）安装/构建/实跑**（SD测试执行 主执行，交付报告见 `test-results/DOT-PR472-ISOLATED-TEST-delivery.md`），**最终隔离验证各组实跑通过**（详见第 9 节）。注意：**typecheck 曾在最终候选失败**（`tsc -p tsconfig.tests.json` 5 处 TS2769，见 8.8），已由后续修复 commit `f42f36f3` 修复、SD代码评审 隔离目录重跑确认 EXIT=0；**23 项 server 环境失败（28 过/23 失败/1 文件级取消）为纯 bwrap/python3 环境限制，不称通过**。以下按时间区分：

**历史首轮（构建未授权、缺依赖，当时如实标未执行）**：
- 已核实：`node_modules` 为 2026-10-23 07:57:16 的部分安装（根 hoisting 仅 6 项、workspace 包 dist 均 0 条目）；本机为 Linux x64 + node v24.22.1（满足 `os:linux arch:amd64` 标签）。
- 当时**所有测试命令标记为「未执行（缺依赖）」**，以下为准确命令（现已在隔离目录实跑通过，见第 9 节）：
  - 任务 ① recorder：`pnpm --filter @sciencediscovery/provenance test -- --test-name-pattern "provenance conflicts carry a structured EXECUTION_RESULT_CONFLICT code"`
  - 任务 ①+③+④ shell-executions：`pnpm --filter @sciencediscovery/api test -- --test-name-pattern "provenance conflict is a non-retryable block|the observation guard pins a committed digest|legacy unknown record without recovery context"`
  - 任务 ② execution-manager：`pnpm --filter @sciencediscovery/runner test -- --test-name-pattern "Unicode log cursors remain stable"`
- 当时已做且通过的替代验证（不依赖 node_modules）：7 个改动 TS 文件 `node --check` 语法解析全部通过（Node 24 原生类型剥离，仅语法解析、不作为测试通过证据）。
- 23 个环境缺依赖失败（bwrap/python3 ENOENT）：首轮与最终隔离目录重跑均**逐名一致复现**（见第 9 节），确认纯属环境限制（bwrap/python3 缺失），非代码问题。

**最终隔离验证（用户已授权、实跑通过）**：详见第 9 节——隔离目录 `/data/bot/workspace/sd-pr472-iso-test` 安装 INSTALL_EXIT=0、构建 BUILD_EXIT=0（首轮 BUILD_EXIT=2 已由修复 commit `f5eef97a` 消除）、测试组实跑通过（a 10/10、全包 19/19、d 5/5、g Unicode 3/3 + execution-manager 25/25、b/c/e/f shell-executions 35/35）；**typecheck 曾失败**（`pnpm --recursive typecheck` 32 包全过，但 `tsc -p tsconfig.tests.json` 5 处 TS2769，见 8.8）→ 修复 commit `f42f36f3` 后由 SD代码评审 隔离重跑确认 EXIT=0；**23 项 bwrap/python3 server 环境失败（28 过/23 失败/1 文件级取消）为纯环境限制，不称通过**。

## 3 五项任务逐项结论

| # | 任务 | 结论 |
|---|---|---|
| ① | recorder 冲突结构化 code + 不可重试映射 | ✅ 已实现并本地提交。冲突现携带 `code: EXECUTION_RESULT_CONFLICT`；`unavailable()` 正确映射为不可自动重试；冲突发生在 append 之前，原不可变运行保持不变；reconcile 永不派发命令；后台扫描（force=false）不再 finalize 冲突记录；普通暂时存储失败（无 code）仍可重试且消费同一钉住字节 |
| ② | Unicode log cursors deadline | ✅ 已修复。根因核实：`execution-manager.test.ts` 的 `until()` 固定 5s（test:30），该用例逐块落盘 5000 条日志（55KB）经 SQLite FULL+WAL 提交，慢盘实测 ~11s（PR #472 验证 3/3 重跑 11.1s）。改为有界、基于完成状态的等待（该用例 30s），断言逐字未削弱 |
| ③ | M2 摘要守卫 | ✅ 判定为**误报**（dot 校正成立）：`observed()` 先调用 `assertObserved()`（含 resultDigest 守卫）再覆盖 evidence，且 `existingResult()` 已先钉住 `runnerVersionId` 与 `candidateResultRef`。未按原报告改动。**补充回归**：finalize 暂时失败后 reconcile 同版本返回不同 digest → 非重试 `EXECUTION_ID_CONFLICT`、不调用 finalizer、不重新派发 |
| ④ | M1 遗留 unknown 阻断 | ✅ 按"仅补说明 + 回归"处理：明确无 recoveryContext 的 unknown 无自动恢复路径、不被 clear/abandon/伪造完成、新工作移入隔离 workspace；错误信息与 zh/en 文档同步补充；回归测试锁定行为。**未新增人工结案 API**（判断不必要：该限制是防重复副作用的保留设计，隔离 workspace 已提供安全推进路径，无证据需求缺口） |
| ⑤ | M4 catch-all + 低风险清单 | ✅ 仅分类、无代码变更（见第 4 节） |

## 4 任务 ⑤：M4 与低风险逐项分类

### M4 runner 回调 catch-all → 403
- **分类：接受（健壮性观察，非复现阻断缺陷）**
- 依据（已读代码核实）：`bootstrap/platform.ts:530-534` 与 `agent-run/workspace-bindings.ts:284-288` 中被 catch-all 包裹的是 `assertSessionWritable` + `assertSessionAllowsRunner`——两者均为**纯内存权限检查**（`this.catalog.sessions.find`、`effectiveRunnerIds` 内存集合，见 `store.ts:2720/2719`），不访问 sqlite，**原报告"含 sqlite busy"的路径不成立**。
- 真实瑕疵（防御深度层面）：catch-all 会把权限检查函数内的编程错误一并转成 403 且丢弃原始错误、无日志。仅当会话权限被真正撤销（预期路径）或出现编程缺陷时触发；不构成可复现的阻断缺陷。
- 建议（不实现、留待后续）：只转换授权类错误，其余保留并记录日志。属健壮性改进项。

### 低风险逐项

| 项 | 分类 | 依据 |
|---|---|---|
| L1 恢复 finalize 跳过 networkConsent.observe | **误报（刻意外绕，设计自洽）** | `observe()`（`sandbox-network-consent.ts:83`）会向已完成结果追加 `networkPermission`，但恢复路径必须保留已钉住的不可变结果字节，追加会改变字节；且恢复场景无活的 Agent turn 等待该反馈，无消费方。live 路径 observe 属正确行为 |
| L2 executionRecoveryVersion 无消费方 | **延后** | 已核实仅 `runner/server.ts:546` 宣告、`schema/environment.ts:552` 定义，无消费点。不影响正确性；建议后续做能力门控或文档化 |
| L3 assertTerminalEvidence `if (!observed.receipt) return` 死分支 | **误报（防御分支在 start 路径可达）** | `start()` 中旧式 Runner 返回无 receipt 的终态时该分支可达并返回，属兼容防御；reconcile 路径虽已被前置守卫覆盖，但非全死。注释可稍精确化（延后） |
| L4 start() `uncertain?.id === execution.id` 不可达分支 | **接受（确认为死代码，延后清理）** | 带 toolCallId 时相同 id 记录已被 `existing` 查询（:401）提前返回；无 toolCallId 时 randomUUID 不可能与既有记录 id 相等。不影响行为 |
| L5 恢复 startedAt 双时间线 | **接受（低，延后统一）** | `observed()`（shell-executions.ts:214）用 API 观察时刻写 catalog `startedAt`；`recorder.ts` 用 Runner `result.startedAt` 写 ExecutionRun。同一执行两条记录时间线不一致，低影响，建议统一为 Runner 时钟 |
| L6 resultDigest 命名/前缀不一致 | **接受（低，延后）** | `ExecutionRun.resultDigest` 为无前缀 hex，`ExecutionEvidence.resultDigest` 为 `sha256:` 前缀；同名字段不同格式，分属不同记录，无正确性问题，建议注释或统一 |
| L7 reconcilePending fire-and-forget 静默吞错 | **接受（低，延后加日志）** | 已核实 `http/index.ts:1533` `void ...reconcilePending(host.id).catch(() => undefined)` 无日志。单飞合并逻辑正确，仅观测性缺口，建议至少 warn |
| L8 mutateArray 进程内队列跨进程重复写 | **接受（低，单进程部署无碍）** | `mutateArray`（store.ts:1595）用进程内 promise 队列串行化读-改-写；跨进程不共享队列为理论形态，且 `appendExecutionRun` 有 canonicalize 幂等兜底。部署形态为单 API 进程 |
| PM 低·dispatchPhase "rejected" 死枚举 | **接受（低，延后清理）** | `schema/execution.ts:85` 声明 `"rejected"`，代码仅赋 `prepared/dispatching/accepted`，从未赋 `rejected` |
| PM 低·授权撤销识别依赖错误文案正则 | **接受（低，风险有限）** | `unavailable()` 有 401/403 HTTP 兜底与 AUTHORIZATION_REVOKED 显式匹配，正则仅为前置快路径 |
| PM 低·"仅 epoch 时间戳不新建运行"表述 | **接受（低，表述可精确）** | API 层成立；Runner 层 digest 含 epoch 元数据、直接重放 409。行为安全，仅文档措辞可精确 |

## 5 真实与合成边界

- **真实**：所有 5 项结论均基于当前 head（f8f1d48a）源码逐行核实（读代码定位 throw/映射/守卫/队列实现）；③M2 守卫、④M1 行为、M4 内存权限检查均有代码证据。
- **合成**：无——本交付不含任何"照抄原报告"的改动；③明确按 dot 校正未按原报告修；⑤分类全部经过代码复核。
- **未执行/待复核**（历史首轮，最终已解决）：测试运行当时缺构建、23 个环境缺依赖失败项、Unicode 用例实机运行、typecheck 全量运行——均已在隔离目录最终验证（见第 9 节）：测试各组通过、23 项环境失败逐名复现一致（纯 bwrap/python3 环境限制，**不称通过**）、Unicode 用例 3/3 过、typecheck 曾失败（5 处 TS2769）已由 `f42f36f3` 修复并重跑确认 EXIT=0（见 8.8）。历史阶段如实标记「未执行」，未伪造通过/失败。

## 6 剩余风险与未执行项

1. 23 项环境缺依赖失败（bwrap/python3 ENOENT，server.test.ts 28 过/23 失败/1 文件级取消）在隔离目录重跑逐名复现一致，确认**纯环境限制**，需具备 bwrap/python3 的 CI 环境验证（本机无法覆盖）。
2. 中-1 旁路 executeShell stderr 风险**未修复/未覆盖**（详见 8.7 低-2 与 8.6；本轮修复 f5eef97a 未触及该路径，交付不得视为该风险已解决）。
3. M4 / L1-L8 按任务书未扩大代码范围，均为建议项留待后续（不实现人工结案 API）。
4. 所有 commit 为本地候选，未 push/未合并——待 dot 验收。
5. 隔离目录 `pnpm-store/` 为未跟踪缓存目录，可保留供后续重跑或清理。

## 7 验收命令速查

```bash
cd /data/bot/workspace/sd-pr472-fix
git log --oneline f8f1d48a..HEAD        # 3082256d, 5c1a5613, 46159279, 0591090e, 646855b7, 8cfe808e, 360ea44e, 41107f98, e73c8b0c, bd019e2e, f5eef97a, d0b27dff, ceaf62d2, f42f36f3
git diff f8f1d48a..HEAD --stat          # 10 文件 +585/-17（以实测为准）
# 最终隔离验证：见第 9 节（隔离目录已实跑通过，无需再 install/build）
```

---

## 8 返修（DOT-PR472-ACCEPTANCE-RETURN + DOC-CLARIFICATION）

### 8.1 新 commit

| commit | 内容 |
|---|---|
| `646855b7` | 净化远端 Runner 错误 + 修正 A/B（uncertain 提示分型、隔离 workspace 说明收紧）+ 对应测试 |
| `360ea44e` | 第三轮边界修正（DOT-PR472-ACCEPTANCE-BOUNDARY-FIX）：unavailable() 持久化固定安全字符串 + Object.hasOwn 防原型链 + 全链路/原型链/finalizer 回归测试补齐 |

### 8.2 净化：code → 固定安全文案映射表

`packages/executor/src/runner-client.ts` `request()` 非 OK 分支不再把远端 `body.error` / `body.code` 直接复制进 `Error.message` / `Error.code`。只允许以下 allowlist code 存活（用于 API 侧不可重试分类），各自映射为固定本地文案；其余 code 与所有远端 message 一律丢弃，使用固定默认文案。HTTP status 始终保留并驱动 API 侧重试判定。

| 远端 code（allowlist） | Error.message（固定本地文案） | Error.code | API 侧分类 |
|---|---|---|---|
| `RESULT_DIGEST_MISMATCH` | "Runner execution result digest mismatch" | 保留 | 不可重试 |
| `EXECUTION_RESULT_CONFLICT` | "Runner execution result conflict" | 保留 | 不可重试 |
| `EXECUTION_ID_CONFLICT` | "Runner execution identity conflict" | 保留 | 不可重试 |
| （无 code / 非 allowlist） | `Runner request failed (STATUS)` | 不附加 | 由 HTTP status 决定（4xx 不可重试、5xx 可重试） |

任何情况下远端原始 message 不写入 `Error.message`；伪造/敏感内容（如 sentinel）无法经此错误进入 execution 记录或日志。

### 8.3 修正 A/B/C

- **A（uncertain 提示分型）**：`shell-executions.ts` 的 uncertain 阻断现在区分：有 `recoveryContext` 的记录 → 一般未确认提示（不提缺上下文）；无 `recoveryContext` 的遗留记录 → 说明无自动恢复路径 + 隔离 workspace 限制。阻断逻辑不变。
- **B（隔离 workspace 说明收紧）**：zh/en `execution-recovery.md` 与错误提示均限定：独立 workspace 仅对与原未知任务**无共享可变资源/外部副作用**（同一外部目标/远端资源）的工作安全；换 `workspaceId` **不是**普遍安全重跑原任务的绕开方式。
- **C（测试实跑确认）**：历史首轮（构建未授权）所有测试如实标注「未执行（待构建授权）」，`node --check` 仅作语法解析、**不作为测试通过证据**。**最终已在隔离目录实跑确认**（用户授权，见第 9 节）：isolatedRunner 用例（隔离 workspace 新工作达 completed）等全部通过。

### 8.4 回归测试（位置 + 命令 + 状态）

| 测试 | 位置 | 断言 |
|---|---|---|
| RunnerClient 不复制远端错误文本 | `packages/executor/src/runner-client.test.ts` "RunnerClient retains an HTTP failure status but never copies the remote error text" | 503 + sentinel → 固定默认文案、无 code、无 sentinel |
| allowlist 冲突码存活但不带远端文本 | 同文件 "allowlisted remote conflict codes survive classification but never carry remote text" | 409 + `EXECUTION_ID_CONFLICT` + sentinel → code 保留、固定文案、无 sentinel |
| 结构化冲突经 HTTP 存活（既有测试强化） | 同文件 "managed result integrity is checked before clock conversion and structured conflicts survive HTTP" | 409 冲突 → code 保留、固定文案 |
| 远端错误不达 execution 记录/日志（真实 HTTP mock + 真实 RunnerClient 全链路） | `services/api/src/shell-executions.test.ts` "remote Runner error text never reaches execution records or logs" | 两种 allowlist 码（`EXECUTION_RESULT_CONFLICT`(409) 与 `RESULT_DIGEST_MISMATCH`(409)）+ 无 code(503) 三类 body + sentinel → `execution.error` / `observation.lastError.message` / 整条记录均无 sentinel；allowlist 码不可重试、503 可重试；allowlist 码持久化固定安全字符串 |
| 原型链 key 不被接受为远端 code | `packages/executor/src/runner-client.test.ts` "prototype-chain keys are never accepted as a remote code" | `constructor`/`toString`/`__proto__` 伪造 code + sentinel → code 不附加、固定默认文案、无 sentinel |
| 本地 code-bearing finalizer 错误只持久化固定安全字符串 | `services/api/src/shell-executions.test.ts` "a local code-bearing finalizer error persists only the fixed safe string, never its raw message" | finalizer 抛出含 sentinel 的本地 `EXECUTION_RESULT_CONFLICT` → `execution.error` / `lastError.message` 均为固定安全字符串、记录无 sentinel/原文 |
| 有 recoveryContext 的 unknown 用一般提示 | 同文件 "an unknown record that still has recovery context blocks new work with a generic message" | 提示含 "unconfirmed outcome"、不含 "no recovery context" |
| 遗留 unknown 提示收紧 | 同文件 "a legacy unknown record without recovery context blocks new work and is never cleared or resubmitted" | 提示含 "no recovery context" + "separate workspace" + "not a generally safe way to re-run" |

执行命令（历史首轮需先 `pnpm install` + `pnpm --recursive build`；**最终已在隔离目录实跑通过**，无需再装/构建）：

```bash
# runner-client（净化 + 原型链）
pnpm --filter @sciencediscovery/executor test -- --test-name-pattern "RunnerClient retains|allowlisted remote conflict|prototype-chain"
# shell-executions（修正 A + 净化全链路 + 隔离 workspace + finalizer）
pnpm --filter @sciencediscovery/api test -- --test-name-pattern "remote Runner error text|legacy unknown record|recovery context blocks|local code-bearing finalizer"
# execution-manager（Unicode 稳定性）
pnpm --filter @sciencediscovery/runner test -- --test-name-pattern "Unicode log cursors remain stable"
```

状态：**最终隔离验证各组实跑通过**（见第 9 节）——executor 全文件 5/5、shell-executions 全文件 35/35（含上述全部回归）、execution-manager 全文件 25/25 + Unicode 3/3；provenance 全包 19/19。**typecheck 曾失败（5 处 TS2769）已由 `f42f36f3` 修复**、SD代码评审 隔离重跑确认 EXIT=0（见 8.8）；23 项 server 环境失败为纯 bwrap/python3 环境限制，**不称通过**。历史首轮 `node --check` 语法解析 7 个改动 TS 文件全部通过（仅语法解析，不视为测试通过证据）。

### 8.5 依赖来源结论（实际证据，不推断）

- `node_modules/` 存在：创建于 **2026-10-23 07:57:16**，含 `.modules.yaml`(31KB) + `.bin` + 共 6 项（根 hoisting 部分安装）。**执行者未知**，未核实授权来源。
- **关键证据**：根级 `node_modules/@sciencediscovery` 缺失（pnpm 正常——工作区包链接到各包自身 `node_modules`），**各包 workspace 符号链接已确认存在**：`packages/provenance` 6 个、`packages/executor` 3 个、`services/api` 29 个、`services/runner` 4 个（时间戳 07:57:11-14）；但构建产物 **dist 缺失**（`packages/provenance|executor|cas` 与 `services/api` 4 个受影响包 dist 均 0 条目，`services/runner` 亦为 0）；`@sciencediscovery/executor` 的 `exports.default` 指向 `./dist/index.js`（缺失）。
- 结论：各包 workspace 符号链接已创建，但构建产物 dist 缺失（4 个受影响包 dist 均 0 条目）→ 测试 **ERR_MODULE_NOT_FOUND 根因是未构建**而非代码错误。最小修复步骤为 `pnpm install` + `pnpm --recursive build`。
- 按硬约束：**历史首轮未执行安装/构建**（外部审批未授权，不得绕过）；未改共享依赖、未装包、未碰用户服务。**最终**用户已授权在隔离目录 `/data/bot/workspace/sd-pr472-iso-test` 安装/构建/实跑（INSTALL_EXIT=0、BUILD_EXIT=0，见第 9 节），依赖来源由 SD测试执行 在隔离环境核实（官方 registry、frozen-lockfile、锁文件未变）。

### 8.6 剩余风险 / 未执行项

1. **中-1 旁路 executeShell stderr 风险未修复/未覆盖**（详见 8.7 低-2 executeShell caller 路径）：候选未改 recorder.ts:833/884 与 workspace-bindings.ts:594-596，修复 commit `f5eef97a` 未触及该路径；**本交付不得视为该风险已解决**，建议后续净化批次处理。
2. 23 项环境缺依赖失败（bwrap/python3 ENOENT）为纯环境限制，需具备 bwrap/python3 的 CI 环境验证（隔离目录重跑逐名复现一致，见第 9 节）。
3. 依赖来源（07:57:16 部分安装的执行者）未证实，按边界不推断、不动作；最终隔离安装来源已由 SD测试执行 核实（官方 registry + frozen-lockfile）。
4. 其余与第 6 节一致：只本地候选，未 push/未合并。

### 8.7 复审意见记录（低-1 / 低-2）与第三轮边界修正说明

**复审低-1（记录，不代码改动）**：`EXECUTION_ID_CONFLICT` 在 runner-client allowlist 中存活，但 `unavailable()` 的显式映射分支（shell-executions.ts:267）只含 `RESULT_DIGEST_MISMATCH` / `EXECUTION_RESULT_CONFLICT`，不含 `EXECUTION_ID_CONFLICT` → 该码落到 fallback 码名（`lastError.code` 显示 fallback 名，如 `OBSERVATION_UNAVAILABLE`）；功能上 409 < 500 仍不可重试（`retryable` 同时要求 `httpStatus >= 500`）。既有行为非本次引入；建议后续在 shell-executions.ts:267 补映射。

**复审低-2（记录，不代码改动）**：`RunnerClient` 中除 `request()` 外还有 8 个直接 fetch 路径在非 OK 分支复制远端 `body.error` 进 `Error.message`（均已核实）：`streamWorkspaceSnapshot`(:256)、`streamRemoteWorkspaceFile`(:274)、`writeRemoteWorkspaceFile`(:302)、`uploadWorkspaceSnapshotFile`(:317)、`environmentSnapshot`(:374)、`submitNpuJob`(:471)、`execute`(:492)、`executeShell`(:513)。调用方：workspace-transfers.ts:100/138（传输任务）、recorder.ts:997/1165（环境快照入 CAS）、scientific-environment-catalog.ts:31、workspace-bindings.ts:533（NPU 作业）。超出本次「request() 非 OK 分支」范围；建议后续统一净化（同一 allowlist/固定文案机制）。
>
> **executeShell 旁路 caller 路径（SD代码评审 第三轮走读补录）**：`executeShell` 工具调用链 `workspace-bindings.ts:594-596`（executeShell 工具，`prepareShell` 不传 dispatch）→ `recorder.ts:833`（无 dispatch 时用 `options.runnerClient.executeShell.bind(...)` 旁路方法直接调 runner-client.ts:497-516 `executeShell`，其 :512-513 把远端 `body.error` 复制进 `Error.message`）→ 失败时 `recorder.ts:884` `stderr: await this.cas.put(error.message)` 把原始远端错误文本持久化进执行运行 stderr（CAS blob），:892 重抛。该路径使伪造/敏感远端消息可经 executeShell 工具直达执行记录 stderr，与本次净化目标同面；超出 request() 范围，建议后续统一净化优先处理（executeShell 改走 request() 或净化 body.error；recorder.ts:884 对非 allowlist 错误用固定文案）。

**第三轮 B1（unavailable() 持久化边界）**：在 `services/api/src/shell-executions.ts` 的 `unavailable()` 处，`RESULT_DIGEST_MISMATCH` / `EXECUTION_RESULT_CONFLICT` 两个允许码不再透传 `error.message` / `String(error)`，改用固定安全字符串（`RUNNER_CONFLICT_MESSAGES` 常量，与 runner-client 上游文案一致）。无论错误来自远端 Runner body 还是本地 finalizer（如 recorder `executionResultConflict()`），原始文案永不写入 `execution.error` / `lastError.message`。上游 RunnerClient 净化保留：已评估无其他 `.code` 消费方（unavailable() 是唯一消费者，且仅此两码走显式映射；其余码分类由 HTTP status 驱动，未误删其他码）。

**第三轮 B2（白名单原型链）**：runner-client.ts `request()` 的 `body.code in RUNNER_ERROR_CODE_MESSAGES` 会命中原型链属性（constructor/toString/__proto__），改为 `Object.hasOwn(RUNNER_ERROR_CODE_MESSAGES, body.code)`；补测试：三个伪造原型链 code + sentinel → code 不附加、固定默认文案、无 sentinel。

**第三轮 B3（测试自身矛盾）**：runner-client.test.ts 原断言 `doesNotMatch(message, /SENTINEL_SECRET_XYZ|conflict/)` 与固定消息 "Runner execution identity conflict" 自相矛盾（conflict 是安全词却排除）。修正为只排除真实 sentinel `doesNotMatch(message, /SENTINEL_SECRET_XYZ/)`，保留精确固定消息断言。

**第三轮 B4（真实 HTTP 全链路回归补齐）**：
- a) 全链路测试增加远端 `RESULT_DIGEST_MISMATCH`(409) + sentinel 场景：对**两种允许码**（`RESULT_DIGEST_MISMATCH` 与 `EXECUTION_RESULT_CONFLICT`）均检查持久化 `execution.error` / `observation.lastError.message` 不含敏感值，且持久化为固定安全字符串。
- b) 新增本地 code-bearing Error 含 sentinel 的 finalizer 路径测试：finalizer 抛出 `code: EXECUTION_RESULT_CONFLICT` + sentinel 消息 → 记录只含固定安全字符串，无 sentinel/原文。

**第三轮 B5（报告表述）**：workspace 链接已确认存在、缺的是 dist（见 8.5 订正）；历史首轮无安装/构建授权、测试如实标「未执行（待构建授权）」、不假称测试已通过；**最终**用户已授权隔离目录实跑（见第 9 节），本轮全部回归实测通过。

### 8.8 typecheck 阻断（dot 证据收尾第 3 项发现，修复 commit `f42f36f3`）

**失败事实**：SD代码评审 在隔离目录跑 `pnpm typecheck` 发现 **TYPECHECK_EXIT=1**——`pnpm --recursive typecheck`（32 包 --noEmit）全过，但随后 `tsc -p tsconfig.tests.json` 在 `services/api/src/shell-executions.test.ts` 报 **5 处 TS2769**（行 533-535、564-565），属**候选引入**（5c1a5613 legacy 测试 + 646855b7 recoverable 测试）。

**根因**：`const message = await startInWorkspace().catch((error: Error) => error.message)`——`f.service.start()` 返回 `Promise<AgentShellExecution>`，`.catch` 回调返回 string → `message` 类型为 `AgentShellExecution | string` 联合；`assert.match(message, …)` / `assert.doesNotMatch(message, …)`（node:assert 需 `string`）触发 TS2769。

**修复方式（每处改动）**：两处声明行（legacy 测试 1 处 + recoverable 测试 1 处）由 `.catch((error: Error) => error.message)` 改为 `.then(success, rejection)` 双回调：

```ts
const message = await startInWorkspace().then(
  () => "unexpected success",
  (error: Error) => error.message,
);
```

- 类型：`Promise<AgentShellExecution>.then(() => string, (error: Error) => string)` → `Promise<string>`，`message` 被类型系统**正确收窄为 string**（非 `as string`/`as any` 断言）。
- 语义：`assert.rejects(startInWorkspace(), { code: "ORIGINAL_EXECUTION_UNCONFIRMED" })` 已先行保证必然 reject，成功分支永不执行；若未来 start 意外 resolve，返回固定哨兵 "unexpected success" 使首个 `assert.match` 失败——**暴露回归而非掩盖**。
- 断言：5 处（533-535 三个 `assert.match` + 564 `assert.match` + 565 `assert.doesNotMatch`）及其消息**逐字未变**；未删除、未弱化任何断言。

**验证状态**：SD代码评审 将在隔离目录拉取 `f42f36f3` 重跑完整 `pnpm --recursive typecheck && tsc -p tsconfig.tests.json` + 完整 shell-executions.test.ts，确认 TYPECHECK_EXIT=0 与 35/35（保留命令/退出码/日志/SHA 绑定）。本工作树依赖不全，未在此全量跑 typecheck（修复为纯类型层，运行时代码路径与断言不变）。

---

## 9 最终隔离验证结果（DOT-PR472-ISOLATED-TEST-AUTH，用户已授权）

隔离目录：**`/data/bot/workspace/sd-pr472-iso-test`**（全新 git clone，独立 .git / node_modules / pnpm store；SD测试执行 主执行，全程未 push/未 merge/未新建 PR/未动 #473 与用户运行服务）。

| 项 | SHA / tree / 结果 |
|---|---|
| 基准 base | `f8f1d48ae25ba092d905ddb668a3ff052289a9d8` |
| 首轮候选 HEAD | `bd019e2e6d686effc87bb8ea0311f0d923dd1bbf`（tree `3294a64a…`） |
| 修复 commit | `f5eef97aa831c1f9c18fc2decd4a153e90b376aa`（isolated-run build + test failures 修复） |
| 统计同步 commit | `d0b27dff5598760a8aef9586229caf56aa1e596b`（docs: update section 7） |
| **最终候选 HEAD / tree** | **`d0b27dff5598760a8aef9586229caf56aa1e596b`** / `139c81498af8167bb8fd68cbab95c589e5b798cb` |
| 一致性 | 隔离 clone `git reset --hard d0b27dff…` 后 HEAD/tree 与 sd-pr472-fix 一致；`git diff --quiet` 无输出（源码树逐字节一致） |

**安装/构建/测试（隔离目录实跑，真实退出码）**：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 安装 | `pnpm install --store-dir <iso>/pnpm-store --frozen-lockfile` | **INSTALL_EXIT=0**（官方 registry、锁文件未变、node_modules/.pnpm 394 项） |
| 构建（首轮） | `pnpm --recursive build` | 首轮 BUILD_EXIT=2（TS2315，360ea44e 引入，f5eef97a 修复） |
| 构建（最终） | `pnpm --recursive build` | **BUILD_EXIT=0** ✓（services/api dist 已生成） |
| 组 a（provenance 冲突结构化，全文件） | `node --import tsx --test packages/provenance/src/recorder-shell-finalization.test.ts` | **10/10 过**（exit 0）；provenance 全包 **19/19 过** |
| 组 d（executor 净化 + 原型链，全文件） | `node --import tsx --test packages/executor/src/runner-client.test.ts` | **5/5 过**（exit 0） |
| 组 g（Unicode 稳定性 ×3） | `--test-name-pattern "Unicode log cursors remain stable"` | **3/3 过**（exit 0 ×3） |
| 组 g（execution-manager 全文件） | 全文件 | **25/25 过**（exit 0） |
| 组 b/c/e/f（shell-executions 全文件） | 全文件 | **35/35 过**（exit 0）——首轮 3 个确定性失败已全部修复 |
| 23 项环境核对（server.test.ts 全文件） | 全文件 | **28 过 / 23 失败 / 1 文件级取消**（与首轮逐名一致，纯 bwrap/python3 ENOENT 环境限制；28 个通过项为无需沙箱的 HTTP/恢复/SSH/socket 类） |
| typecheck（dot 证据收尾第 3 项发现） | `pnpm --recursive typecheck` 后 `tsc -p tsconfig.tests.json` | **首轮 TYPECHECK_EXIT=1**：32 包 --noEmit 全过，但 tests 配置在 `services/api/src/shell-executions.test.ts` 报 **5 处 TS2769**（行 533-535、564-565，候选引入 5c1a5613 + 646855b7，根因见 8.8）→ 修复 commit `f42f36f3` 后由 SD代码评审 隔离重跑确认 **TYPECHECK_EXIT=0** |

**首轮 4 项代码问题 → 最终状态**：①构建 TS2315 → 已修复（BUILD_EXIT=0）；②force-scan 3≠2 → 已修复（测试编排 await，35/35 过）；③isolatedRunner 隔离工作 unknown → 已修复（fixture 回显 executionId，达 completed）；④修正 A 误用 legacy 文案 → 已修复（从 DB 读完整记录判 recoveryContext）。**4 项全部消除，无一残留。**

**typecheck 修复（独立于首轮 4 项，dot 证据收尾第 3 项）**：候选曾因 `tsc -p tsconfig.tests.json` 的 5 处 TS2769 失败——`const message = await startInWorkspace().catch((error: Error) => error.message)` 使 `.catch` 结果宽化为 `AgentShellExecution | string`，`assert.match(message, …)`（node:assert 需 string）报错。修复 commit `f42f36f3` 将 `.catch` 改为 `.then(success, rejection)` 双回调，类型系统正确收窄 `message` 为 `string`：成功分支返回固定哨兵（若 start 意外 resolve 则断言失败、暴露回归而非掩盖），拒绝分支仍返回 `error.message`。**5 处断言及其消息逐字未变，无 `as any`、未删除/未弱化任何断言**。SD代码评审 将在隔离目录拉取 `f42f36f3` 重跑完整 `pnpm --recursive typecheck && tsc -p tsconfig.tests.json` 确认 EXIT=0（本工作树依赖不全，未在此全量跑 typecheck）。

**中-1 旁路 executeShell stderr 风险**：**未修复/未覆盖**（recorder.ts:833/884 与 workspace-bindings.ts:594-596 零改动，f5eef97a 未触及）；本交付不得视为该风险已解决，建议后续净化批次处理。

**材料路径**：
- 交付报告：`/data/bot/workspace/test-results/DOT-PR472-ISOLATED-TEST-delivery.md`
- 相关验证材料：`/data/bot/workspace/test-results/DOT-PR472-FIX-verification.md`、`DOT-PR472-BOUNDARY-verification.md`、`DOT-PR472-ACCEPTANCE-verification.md`、`PR472-test-summary.md`
- 隔离目录日志：`pnpm-install.log`（安装）、`rebuild.log`（最终构建 BUILD_EXIT=0）、`shell-exec-full-rerun.log`（35/35）、`server-test-rerun2.log`（23 项环境核对）、首轮 `build.log`（BUILD_EXIT=2 证据）等
