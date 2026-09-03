# Reviewer Specialist：自动证据审计与反馈闭环技术方案

> 对应产品设计：《Reviewer Specialist：自动证据审计与反馈闭环设计》。本文只描述工程落地、影响面、迁移、收益和风险。

## 1. 技术目标与现有缺口

现有 Quick / Deep 审核核心已经可用：它锁定 Artifact Version、按 Session 串行执行、持久化 `ArtifactReviewRun` 并复用相同输入的结果。升级目标不是重写审核算法，而是把它从“单个 HTTP/Agent 调用中的同步过程”升级为“可恢复、可观测、可反馈的后台任务”。

| 当前锚点 | 当前问题 | 升级目标 |
|---|---|---|
| `services/api/src/http/index.ts` 的手动审核路由 | `await runReviewerCheckpoint()` 后才返回，长审核绑定请求生命周期。 | 创建任务后立即返回 `202 + taskId`。 |
| `packages/provenance/src/review-checkpoint.ts` | 有进程内队列和取消控制器，但它们不是持久化事实来源。 | 保留审核核心，抽出可持久化状态机和 worker 调用入口。 |
| `packages/provenance/src/recorder.ts` | Artifact 登记后没有统一的 Reviewer 触发语义。 | 通过 [#2](https://gitcode.com/openJiuwen/sciencediscovery/issues/2) 的领域事件/Outbox 产生候选审核。 |
| `services/api/src/runs/index.ts` | 显式工具调用可反馈到下一轮历史，但异步结果不会主动进入安全边界。 | 建立有界、一次性消费的 `ReviewFeedback`。 |

## 2. 目标架构

```text
ArtifactManager / ProvenanceRecorder
  → ArtifactReviewRequired（#2 Outbox）
  → ReviewerAuditCoordinator（API 应用层）
  → ReviewerAuditTaskStore（SessionStore 适配器）
  → runReviewerCheckpoint（既有 Quick / Deep 核心）
  → ArtifactReviewRun + ReviewFeedback
  → Context Contributor / 安全边界调度
  → SSE 与 Reviewer 卡片
```

- `packages/provenance`：任务状态转移、输入指纹、复用判断和审核编排；不得依赖 HTTP、SSE 或具体文件存储。
- `services/api`：Store、Outbox 消费、worker 生命周期、模型/Connector 装配、SSE 投影和 continuation。
- `SessionStore`：持久化任务、反馈和消费状态；不承载 Claim 判断或 Prompt。
- Web：只配置和展示，不能自行去重、决定任务可执行性或执行修订。
- Agent Runtime：只接收有界 `ReviewFeedback`，不认识 Artifact、Outbox 或 Reviewer 存储细节。

## 3. 数据契约

首期只增加 Reviewer 专用契约，避免提前抽象成全局任务平台。

```ts
interface ReviewerAuditTask {
  id: string;
  sessionId: string;
  origin: "manual" | "artifact_registered";
  reviewLevel: "quick" | "deep";
  artifactVersionIds: string[];
  inputFingerprint: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "superseded";
  attempt: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  supersededBy?: string;
  errorSummary?: string;
}

interface ReviewFeedback {
  id: string;
  sessionId: string;
  taskId: string;
  artifactVersionIds: string[];
  feedbackFingerprint: string;
  policy: "record" | "explain" | "suggest" | "repair";
  status: "ready" | "consumed" | "dismissed";
  reviewIds: string[];
  createdAt: string;
  consumedAt?: string;
}
```

任务状态只表示执行生命周期；`ArtifactReviewRun.decision` 和 `INCONCLUSIVE` 只表示审核结论。重复 Outbox 投递、页面重试和服务重启以 UUID 与输入指纹幂等，不产生重复有效审核或重复内部修订。

## 4. 具体升级点

### PR1：同步手动审核升级为异步任务

1. 在 `packages/schema` 与 `SessionStore` 增加任务创建、读取、原子认领、终态写入和取消接口。
2. 新增 `ReviewerAuditCoordinator`，从 `queued` 任务中按 `sessionId` 串行认领，并调用现有 `runReviewerCheckpoint()`。
3. 手动路由只校验、锁定当前最新 Artifact、创建 checkpoint 锚点和入队，返回 `202`；Web 改为消费 task 状态而非等待 reviews。
4. worker 持续更新 checkpoint、`ArtifactReviewRun` 和任务状态；复用现有 `reviewer_checkpoint.updated`，必要时补充 task SSE。
5. 服务启动扫描遗留 `running` 任务：只读审核可按租约和尝试次数安全重入队；不可恢复时明确写为中断失败。

显式 Agent `review_checkpoint` 的同步语义在 PR1 保持不变。两入口以 `artifactVersionIds + inputFingerprint` 互斥或复用，禁止并行审核同一版本。

### PR2：Artifact 事件升级为用户授权的低频审核

依赖 #2 的 `ArtifactReviewRequired`/Outbox。协调器消费候选事件时依次判断：

```text
Reviewer enabled
  → 是否是本 Session 最新版本
  → 类型是否适用 Quick / Deep
  → 内容、Evidence、策略、档位指纹是否已审核
  → Deep 冷却和预算是否允许
  → 合并旧任务或创建新任务
```

实现两个独立 policy Port：

- `ReviewerAuditEligibility`：输出 `eligible | skipped(reason) | superseded`；
- `ReviewerAuditBudget`：只管理 Deep 冷却、最大并发和调用预算。

事件只表示“候选审核”，不承诺必须执行。所有跳过、合并和复用原因必须可查询，以解释为什么没有启动 Deep。

### PR3：审核结果升级为 Lead Agent 安全反馈

任务完成时，在同一持久化边界写入 `ReviewFeedback(ready)` 并发布 `reviewer.feedback.ready`。反馈是有界投影，只含 Artifact/版本、结论、finding、严重度、Evidence 引用、来源和策略，不包含完整模型输出或未经治理的外部内容。

消费顺序：

1. AgentRun 在模型调用之间：由下一次调用的 Context Contributor 读取；
2. AgentRun 已结束：仅 `explain/suggest/repair` 创建内部 continuation，`record` 不额外调用模型；
3. 用户发起下一轮：常规上下文装配读取未消费反馈；
4. 投递成功后原子标记 `consumed`，避免重连、多 worker 或刷新重复驱动；
5. `repair` 校验 Session、ArtifactVersion、用户策略、finding 可操作性与循环预算，只允许生成新 Artifact Version，禁止外部副作用。

## 5. 代码影响面与兼容策略

| 层 | 主要文件/模块 | 升级内容 | 兼容策略 |
|---|---|---|---|
| Schema | `packages/schema/src/provenance.ts`、`session.ts`、`runtime-settings.ts` | 任务、反馈、SSE DTO、反馈策略。 | 原有设置默认 `record`；历史 checkpoint/review 可读。 |
| Reviewer 领域 | `packages/provenance/src/review-checkpoint.ts`、新增 `reviewer-audit-task.ts`、`review-feedback.ts` | 状态机、指纹、协调器 Port。 | 不改既有 Quick/Deep finding 名称与结果格式。 |
| API/Store | `services/api/src/store.ts`、`http/index.ts`、`runs/index.ts` | 任务持久化、`202` 提交/查询/取消、Outbox 消费、SSE、continuation。 | 前后端在 PR1 原子升级；保留 `GET artifact reviews` 读取回退。 |
| Artifact 入口 | `packages/provenance/src/recorder.ts`、#2 Outbox | 统一产出候选审核事件。 | 上传、Agent、MCP、执行器不复制触发代码。 |
| Web | `apps/web/src/api.ts`、`App.tsx`、`ReviewerPanel.tsx`、`ReviewerControlCard.tsx`、`Orchestration.tsx` | 队列状态、自动来源、档位快照、策略和结果。 | 保持 On/Off 与 Quick/Deep，不加第三档或重复开关。 |
| 测试 | API Reviewer tests、Web Reviewer tests、集成/E2E | 状态机、恢复、策略、交互和故障覆盖。 | 原有手动 Quick/Deep 回归继续通过。 |

## 6. 升级收益与评估

| 维度 | 升级前 | 升级后 | 建议指标 |
|---|---|---|---|
| 交互 | 手动审核等待长请求。 | 立即返回、后台可见执行。 | 提交接口 P95、排队/执行时长、审核中继续对话比例。 |
| 覆盖 | 依赖用户或 Agent 明确点名。 | 用户开启后覆盖阶段性新 Artifact。 | 符合策略版本的最终审核率、跳过原因。 |
| 成本 | Deep 调用时机不可控。 | 档位、指纹、冷却和预算控制。 | 每 Session Deep 次数、复用率、合并率、单位 Artifact 成本。 |
| 可靠性 | 依附 HTTP/进程内控制器。 | 持久化认领、恢复和可诊断终态。 | 遗留任务恢复率、重复执行率、取消后迟到写入率。 |
| 可行动性 | 用户下一轮才可能要求修复。 | 安全边界解释、建议或受限修订。 | feedback 延迟、建议采纳率、修订后复审通过率。 |
| 安全 | 结果消费边界较弱。 | 有界反馈、显式策略、一次性消费和循环限制。 | 未授权 repair 数、每个指纹修订次数、外部副作用拦截数。 |

首期不以“自动修复率”作为成功指标，应先验证任务不丢失、不阻塞、Deep 不超预算、`INCONCLUSIVE` 不误导，以及反馈不重复；稳定后再逐步开放 `suggest` 和 `repair`。

## 7. 风险与降级

| 风险/依赖 | 影响 | 控制措施 |
|---|---|---|
| #2 Outbox/Artifact 事件未稳定 | PR2 缺少可靠统一触发点。 | PR1 可独立完成；PR2 以 #2 的事件契约为前提。 |
| 多进程认领与取消竞争 | 重复执行或无法物理中断。 | 原子租约、attempt、终态防覆盖；物理取消单列稳定化项。 |
| Deep 成本和外部依赖不稳定 | 自动审核变慢或成本失控。 | On/Off、档位快照、冷却/预算、受治理来源、`INCONCLUSIVE`。 |
| 反馈修订循环 | 无限产生 Artifact 与模型调用。 | feedbackFingerprint、每版本一次、最大轮数、默认 `record`。 |
| 审核故障误判为内容缺陷 | Lead Agent 错误修订。 | 执行状态、审核结论、服务降级三层分离。 |

## 8. 验收重点

- Off、On + Quick、On + Deep 的任务创建与实际执行档位正确；
- 自动审核不阻塞 Artifact 注册、主 Agent 回复或用户继续对话；
- 同版本只有一个有效任务，新版本会合并或淘汰旧任务；
- 页面刷新、服务重启、取消和多 Session 并行可正确恢复或显示终态；
- `INCONCLUSIVE`、超时和依赖降级不汇总为“必须修订”；
- feedback 只在安全边界消费，且内部修订永不越出用户授权范围。
