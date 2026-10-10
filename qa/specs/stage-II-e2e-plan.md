# 阶段 II 门 E2E 执行预案（W3+W4 完成后触发）

> 状态：预案就绪（2026-09-09 13:3x）。触发：stage_gate_pending=true 且会话空闲 ≥30 分钟。
> 前提检查：P2-V2（面板冻结二修）/P2b（maxTokens）修复通知若已到，先 sync 再测；未到则 mocked 照跑（面板断言按现状归因）。

## 1. 环境

1. mocked 栈：`sed data6→data7` 后 `~/start-sd-e2e-mocked.sh`（embedding stub 4399 须活着，死了先 `~/start-ke-embedding-stub.sh`）
2. real 栈：复用 4392 实例；若 P2b 修复落地则 sync+重启（data 复用，凭据已注入的 provider 仍在）
3. 多栈启动**必须串行**（gateway 装配竞态教训）

## 2. mocked 层（.e2e 内，TZ=UTC）

| 套件 | 内容 | 通过判据 |
|---|---|---|
| 回归 11 条 | journey-*.spec.ts 全量 | 全绿（阶段 I 已绿基线不回退） |
| J-KE1/J-KE2 | 重跑 | **P2-V2 修复的验收**：文档 ✓ 出现、图谱渲染、实体详情 |
| J-KE3 | 首跑（消费层） | concept_explore 工具步骤可见 + 答复含实体/证据（动态 kbId stub） |
| roots 下钻 | 在 J-KE2 补断言或临时脚本 | `ke-roots` → `ke-community-<id>` → 实体详情；面包屑 `ke-breadcrumb`（W4 通知 testid） |

## 3. real 层（4392，P2b 修复后）

1. **重种子**（复用 ~/sd-real-seed.mjs 改造：可指定既有 KB 再 seed 或新建）：目标 ready ≥8/10（B7 复验；剩余失败须为外部网络类）
2. **resolution mode=on**：POST /kbs/:id/resolution → job succeeded → GET /merges 审计行合理（合并率、absorbedName）；抽 1 条 unmerge 往返
3. **resolution eval**：`node scripts/ke-resolution-eval.mjs --set pairs.realworld`（真实模型下 R≥0.60 门槛，W4 通知口径）
4. **grow 2-cycle**：POST grow {maxPapers:10, depth:1} ×2 → engineState 四信号 + frontier 计数正确（W2 验收遗留项）
5. A4 复验：实体 150-250（10 篇全抽取后）

## 4. 产出

- `qa/reports/2026-09-09-stage-II-review.md`：评审结论已齐（0P1/1P2/7P3）+ E2E 矩阵 + 归因 + 阶段 III（W5）建议
- 通过 → stage=III、W5（评测加固收尾）；两 P2（I 的 V2/II 的 attach）行动项清零状态如实记录

## 预算

mocked ~25 分钟（J-KE3 600s×2 + 回归）；real ~40-60 分钟（重种子+2 grow cycle+eval）；K3 额度仅驱动 minimax/siliconflow。
