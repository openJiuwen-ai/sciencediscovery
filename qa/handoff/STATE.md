# 双 Agent 闭环状态（单一事实源）

> 规则见 qa/handoff/CRUISE-PLAYBOOK.md。任何 agent 修改本文件必须同时把动作追加到 logs/。

```yaml
stage: III（W5 已提交 395bdfe——六波全齐，终局 E2E 窗口待会话空闲）
wave: W4 完成——阶段 II 门开启
stage_gate_pending: true    # 13:0x 置位（W4 完工通知）
qa_mode: stage-gate
turn: zcode
lock:
  owner: human-interactive  # 13:01 仍活跃；部署/E2E 等空闲 ≥30 分钟
  since: 2026-09-09T13:01+08:00
fuse:
  consecutive_failures: 0
budget:
  dispatches_today: 0
stage_gate_progress:
  review: 完成——0×P1 / 1×P2（attach 重跑 support 虚增，任务书 2026-09-09T1320）/ 7×P3；直搬声明核实为真（Louvain/消解门/合并快照/W3 kb 作用域）
  deploy: 待会话空闲（复用隔离栈模式：mocked data7 + real data2）
  mocked: 待——回归 + J-KE1/KE2（若 P2-V2 已修）/ J-KE3 首跑 / 新增 roots 下钻断言（testid ke-roots/ke-community/ke-breadcrumb 已由 W4 通知给出）
  real: 待——P2b 修复确认后重种子（目标 B7 ≥8）+ resolution mode=on 实机链路 + grow 2-cycle
  report: 待——阶段 II 报告（评审数据已齐）
notes: >-
  阶段 I 开放项仍未闭环：P2-V2（面板冻结，0e32e78 未命中，等 dev 二修）+ P2b（maxTokens）。二者与阶段 II E2E
  共用部署窗口。W4 通知另给：resolution eval 脚本（scripts/ke-resolution-eval.mjs，确定性基线 P=1.0/R=0.583，
  R≥0.60 需真实模型）——阶段 II real 层可顺带跑 realworld 集。
```
