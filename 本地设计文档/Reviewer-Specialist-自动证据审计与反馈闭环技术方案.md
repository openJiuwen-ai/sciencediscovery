# Reviewer Specialist：自动证据审计与结构化反馈技术方案

> 本迭代只覆盖 Reviewer Specialist 专家内部能力：Artifact 新版本登记后自动审核，并产出准确、可追溯、可供主 Agent 查看的只读结构化反馈。不改变主 Agent 的决策、工具调用、修复流程或其他业务功能。

## 1. 迭代目标与边界

### 1.1 本迭代目标

1. **自动触发审核**：可审核的 Artifact 新版本登记完成后，自动创建持久化审核任务并在后台执行。
2. **不阻塞业务**：Artifact 交付、主 Agent 回复和用户继续对话不等待审核完成。
3. **结构化反馈**：审核完成后保存有界、准确、可追溯的 `ReviewFeedback`，主 Agent 可以通过现有只读上下文或查询接口获知结果。
4. **保留审核事实**：完整结论仍以 `ArtifactReviewRun` 为准，反馈摘要不得改写或扩大审核结论。

### 1.2 明确不做

- 不新增 `Completed-review handoff` 或其他反馈策略开关；
- 不实现主 Agent 的解释、修订建议、自动修复或 continuation；
- 不修改主 Agent 的规划、工具调用、权限和 Artifact 写入逻辑；
- 本迭代不引入 Outbox、分布式 Worker、租约 Claim、attempt 计数或多进程协调；
- 不引入新的通用任务平台、全局事件总线或额外 SSE 协议。

主 Agent 在本方案中只是只读信息接收方，不负责执行 Reviewer Specialist 的任务，也不根据反馈自动产生副作用。

## 2. 目标架构

```text
ArtifactManager / ProvenanceRecorder
  → Artifact 版本落盘后通知 Reviewer Specialist
  → ReviewerAuditCoordinator 创建持久化任务
  → 后台 Worker 调用既有 Quick / Deep 审核核心
  → ArtifactReviewRun + ReviewFeedback(ready)
  → 现有只读上下文或查询接口供主 Agent 查看
```

### 2.1 组件职责

- `packages/provenance`：在 Artifact 版本及工作区修订持久化后发出进程内登记通知。通知采用 fire-and-forget，不能阻塞 Artifact 交付。
- `services/api/src/reviewer-specialist/audit-coordinator.ts`：创建、排队、执行和恢复 Reviewer 任务；调用既有 `runReviewerCheckpoint()`，不承载主 Agent 行为。
- `SessionStore`：持久化任务、审核运行和反馈，按输入指纹去重，并提供反馈读取/消费接口。
- `services/api`：提供任务、审核结果和反馈的查询接口；手动审核入口继续兼容，但不是本迭代重点。
- Web：展示任务和结果。当前采用短轮询刷新，避免用户手动刷新页面；不在前端决定任务是否执行。
- 主 Agent：只读取 Reviewer 产出的只读信息。本轮不增加任何解释、建议、修复或外部调用逻辑。

## 3. 数据契约

任务只描述审核执行生命周期：

```ts
interface ReviewerAuditTask {
  id: string;
  sessionId: string;
  origin: "manual" | "artifact_registered";
  reviewLevel: "quick" | "deep";
  artifactVersionIds: string[];
  inputFingerprint: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "superseded";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  supersededBy?: string;
  errorSummary?: string;
}
```

反馈是审核结果的有界只读投影：

```ts
interface ReviewFeedback {
  id: string;
  sessionId: string;
  taskId: string;
  artifactVersionIds: string[];
  reviewIds: string[];
  feedbackFingerprint: string;
  status: "ready" | "consumed" | "dismissed";
  summary: {
    critical: number;
    warning: number;
    inconclusive: number;
  };
  findings: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    message: string;
    evidenceRefs: string[];
  }>;
  createdAt: string;
  consumedAt?: string;
}
```

`ArtifactReviewRun` 保留完整审核结论、状态和原始 finding；`ReviewFeedback` 只复制必要摘要、证据引用和定位信息，不生成新的结论。现有 Schema 中的 `feedbackPolicy` 字段仅为历史数据兼容，不代表本迭代仍提供策略功能。

## 4. 核心流程

### 4.1 Artifact 登记与自动入队

1. Artifact 新版本及工作区修订先完成持久化。
2. `ProvenanceRecorder` 调用 Reviewer 登记通知；通知失败只记录日志，不能回滚已交付 Artifact。
3. `ReviewerAuditCoordinator` 检查 Reviewer 是否启用、Artifact 是否属于当前可审核范围，并创建 `queued` 任务。
4. 通过 `inputFingerprint` 复用相同输入，避免同一版本产生重复有效审核。

当前实现只对 `llm_declared` 的报告类 Artifact 自动审核，上传文件、代码和数据中间产物不会自动创建任务。若产品最终要求所有 Artifact 都审核，应单独调整审核范围，不应隐含在调度器中。

### 4.2 后台审核与恢复

1. Worker 从持久化队列读取任务，按 Session 串行调用既有 Quick / Deep 审核核心。
2. 任务状态按 `queued → running → completed/failed/cancelled/superseded` 流转。
3. 审核完成后保存 `ArtifactReviewRun`，再保存对应的 `ReviewFeedback(status="ready")`。
4. 服务启动时将遗留的 `running` 任务重新放回队列，避免普通重启永久丢失任务。
5. 审核任务与主 Agent、用户对话分离；审核等待、模型失败或取消不会阻塞对话。

本迭代接受进程内登记通知和单进程协调器的边界，不承诺跨进程故障下的事件重放和原子 Claim。Outbox、租约和多进程安全属于后续可靠性迭代。

### 4.3 反馈可见性

- 任务、`ArtifactReviewRun` 和 `ReviewFeedback` 均可通过 API 查询。
- Web 在任务处于排队或运行状态时短轮询查询结果，审核卡片无需手动刷新即可更新。
- 若现有上下文入口读取 `ReviewFeedback`，只追加审核原文支持的只读信息；不触发主 Agent 的新流程，不修改 Artifact，不调用外部工具。
- `ReviewFeedback` 成功被读取后才标记为 `consumed`，避免刷新或重试导致重复消费。

## 5. 可保留的实现保护

以下是当前实现中的调度保护，不构成本迭代新的业务目标：

- Quick / Deep 档位；
- 短暂静默窗口和同一 Session 的版本合并；
- Deep 冷却时间及进程级自动审核并发限制；
- 主 Agent 正在运行时让自动审核排队；
- Reviewer 独立取消和重启恢复；
- 报告类 Artifact 过滤。

这些保护可以保留，但不应扩展为新的 Agent 协作、修订或权限体系。

## 6. 代码影响面

| 层 | 文件/模块 | 本迭代职责 |
|---|---|---|
| Artifact 入口 | `packages/provenance/src/recorder.ts` | 版本落盘后的 Reviewer 登记通知；不阻塞交付 |
| Reviewer | `services/api/src/reviewer-specialist/audit-coordinator.ts` | 自动入队、异步执行、状态流转、反馈生成 |
| 持久化 | `services/api/src/store.ts`、`packages/schema/src/provenance.ts` | 任务、审核运行和结构化反馈的保存与查询 |
| API | `services/api/src/http/index.ts` | 任务/审核/反馈查询及手动审核兼容入口 |
| 上下文适配 | `services/api/src/runs/index.ts` | 仅允许只读反馈可见；不增加主 Agent 行为 |
| Web | `apps/web/src/App.tsx`、Reviewer 相关组件 | 状态轮询和结果展示；不执行审核或修订 |

不新增 Reviewer 以外的通用任务、事件、策略或修复模块。

## 7. 验收标准

1. Reviewer 开启后，新的可审核 Artifact 版本登记会创建持久化 `artifact_registered` 任务。
2. Artifact 登记接口、主 Agent 回复和用户继续发送消息不等待审核完成。
3. 任务最终进入明确终态，并能查询对应的 `ArtifactReviewRun` 和 `ReviewFeedback`。
4. 同一输入指纹不会产生重复有效审核；新版本按当前调度规则合并或淘汰旧任务。
5. 服务重启后，未完成任务能够重新排队或显示失败终态。
6. 反馈包含正确的 Artifact/版本、审核任务、审核运行、finding 和 Evidence 引用；完整结论可追溯到 `ArtifactReviewRun`。
7. 反馈可被主 Agent 查看，但不会因此自动解释、建议、修改 Artifact、调用工具或产生外部副作用。
8. 审核卡片在审核完成后通过现有轮询自动显示，无需用户手动刷新。

## 8. 风险与后续事项

| 风险 | 当前处理 | 后续可选增强 |
|---|---|---|
| 登记通知发生在进程崩溃前 | 已交付 Artifact 不受影响，但可能未创建审核任务 | Outbox 或可重放事件 |
| 单进程协调器 | 当前部署下避免重复执行 | 原子租约、跨进程 Claim |
| Deep 模型或依赖失败 | 任务写入 `failed`，不伪造内容结论 | 更细的失败分类和监控 |
| 反馈摘要有界 | 通过 `reviewIds` 和 Artifact 版本追溯完整结果 | 独立的反馈详情查询 |

本迭代的完成标志是“自动审核可靠运行并产出准确、可追溯的只读反馈”，不是“主 Agent 自动修复”。

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
