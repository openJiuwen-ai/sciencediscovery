# 双 Agent 闭环状态（单一事实源）

> 规则见 qa/handoff/CRUISE-PLAYBOOK.md。任何 agent 修改本文件必须同时把动作追加到 logs/。

```yaml
wave: W1（开发中——dev 角色当前由用户交互式会话 bd0af9db 承担，非 headless）
phase: wave-dev
turn: claude                    # dev 行动方 = 交互式会话
lock:
  owner: human-interactive
  since: 2026-09-08T17:49+08:00
fuse:
  consecutive_failures: 0
budget:
  dispatches_today: 0
queued:
  - to-claude/2026-09-08T1755-w1-wave-end-checklist.md
superseded:
  - to-claude/2026-09-08T1740-w0-p2-and-w1-confirm.md   # P2 已由交互会话修复（17:51 核实）；提交与规格确认并入 W1 波次末清单
notes: >-
  交互式会话越过 W0 评审直接进入 W1（connectors 已出现，17:49 仍活跃）。W0 代码未提交，W0+W1
  在工作区交错——QA 评审按全量 delta 处理。巡航在交互会话活跃期间只记日志；接管点=W1 波次末
  （完工通知出现，或会话空闲 30 分钟且 git 静止后 QA 做中途只读评审）。qa/ 已由 QA 提交，dev
  不得将其卷入提交。
```
