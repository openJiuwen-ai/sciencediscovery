# 双 Agent 闭环状态（单一事实源）

> 规则见 qa/handoff/CRUISE-PLAYBOOK.md。任何 agent 修改本文件必须同时把动作追加到 logs/。

```yaml
stage: I                    # 阶段 I = W1+W2；II = W3+W4；III = W5
wave: W2 完成（fbc0c3f）——阶段 I 全部落库，进入阶段门
stage_gate_pending: true    # 21:31 巡航置位（W2 完工通知含「给阶段 I 门的接口事实」）
qa_mode: stage-gate         # 六拍执行中：评审（进行）→ 等会话空闲后部署+E2E → 阶段报告
turn: zcode                 # QA 行动方
lock:
  owner: zcode-cruise        # 22:05 接管（会话 30.7 分钟无写入 + claude.exe=0）
  since: 2026-09-08T22:05+08:00
fuse:
  consecutive_failures: 0
budget:
  dispatches_today: 0
stage_gate_progress:
  review: 完成（全模块 PASS，无 P1/P2；报告 qa/reports/2026-09-08-stage-I-review.md）
  deploy: 完成（data4 栈 4390/4391，TZ=UTC 套件约定）
  mocked: 定稿——9 过/2 败/2 跳；2 败=J-KE1/KE2 fixture 缺口（死信错误已给出 10 个 arxiv PDF 的精确文件名）
  real: 待（凭据注入→真实种子→grow 2 cycle）
  report: 初稿已出（PASS 有条件），待 real 层补全
qa_next:
  - 录制 10 个 arxiv PDF fixture（按死信错误文件名逐一 make-fixture.mjs --base64）
  - 查明 KE embedding 在隔离栈的配置来源，补 mocked 方案
  - 重跑 J-KE1/KE2 收口 mocked → real 层四项验收
notes: >-
  W2 完工通知（to-zcode/2026-09-08T2200-w2-done.md）关键情报：① grow API 202 {jobId,cycleId,reused}
  / GET engineState.signals 结构；② 前端 testid ke-grow-panel/ke-grow-start/ke-grow-progress/ke-grow-signals
  （J-KE2 可加 grow 步骤）；③ pdf-text 空目录契约修复（W1 冒烟盲区，已加回归护栏）；④ 冒烟 KB
  4b62533a-c0d2-4f9f-8177-8272e09fd6b2（真实数据，real 层可复用）；⑤ S2 无 key 限流凶猛、OpenAlex
  是主力 resolver（real 层归因参考）；⑥ deferred 搁浅任务保持 DA 语义（已知限制已注释，留 W5 议）。
```
