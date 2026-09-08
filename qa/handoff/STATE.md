# 双 Agent 闭环状态（单一事实源）

> 规则见 qa/handoff/CRUISE-PLAYBOOK.md。任何 agent 修改本文件必须同时把动作追加到 logs/。

```yaml
stage: I                    # 阶段 I = W1+W2（主链路+增长闭环）；II = W3+W4；III = W5
wave: W1.3（orchestrator/routes/bootstrap/前端图谱页，开发中）
stage_gate_pending: false   # 阶段末波次（W2）完工通知出现时置 true → 触发 QA 全量评审
qa_mode: whitebox           # 平时=白盒测试写作（追加式约束）；阶段门=全量评审+E2E 强化
turn: claude                # dev 行动方 = 用户交互式会话 bd0af9db
lock:
  owner: human-interactive
  since: 2026-09-08T18:26+08:00
fuse:
  consecutive_failures: 0
budget:
  dispatches_today: 0
queued: []                  # 阶段门模式下平时无派发任务；阶段门时写行动项任务书
notes: >-
  2026-09-08 18:4x 用户决策：波次门 → 阶段门 + 平行白盒测试（qa/README.md 与 playbook 已同步）。
  进度：f4036b5（W0+W1.1/W1.2）已提交；W1.3 工作区开发中（routes/orchestrator/前端）。
  QA 白盒待办 backlog：① journey-ke-* 骨架×4（依 qa/specs/W1-acceptance.md）② scholarly fixture
  录制模式对接 FixtureScholarlyTransport（注意 JATS 4xx→null 双路径）③ 单测边界补强（W0 代码已
  定稿部分）。Claude 波次末完工通知照写，但不等 QA、直接进下波次；全量评审在 W2 完成后（阶段 I 门）。
```
