# 闭环巡航手册（ZCode 定时执行；人工触发一次时同样适用）

## 输入

- `qa/handoff/STATE.md`（wave / phase / turn / lock / fuse / budget）
- `git -C D:/codespace/sciencediscovery log --oneline -5` 与 `status --short`
- `qa/handoff/to-zcode/` 是否有新完工通知
- 交互式会话活跃检测：`C:/Users/xjtlb/.claude/projects/D--codespace-sciencediscovery/bd0af9db-7d88-42a3-8bf0-35f65d83645e.jsonl` 的 mtime（30 分钟内有写入 = 活跃）
- 进程检测：`tasklist | grep -i claude`（存在 claude.exe = 有会话在跑，可能是我派发的也可能是用户的）

## 通用守则

- 每次巡航最多派发 **1 个** dev 任务；每日派发软上限 12（记入 budget.dispatches_today，跨日在 STATE 里手工翻页）
- **任务时效校验（派发前必做）**：把 queued 任务与当前 git/code/报告状态比对——若交互式会话已完成其内容或开发已越过它，将任务文件头标记 `[已作废]`、STATE 的 queued 移入 superseded，记日志跳过，绝不派发过期任务
- dev 角色可能由**用户交互式会话**承担（STATE.lock.owner=human-interactive 且 wave 处于开发中）：此期间巡航只记日志；若会话 jsonl 30 分钟无写入且 git status 静止，可做**中途只读评审**（写报告、不派活不部署）
- **白盒测试模式约束（2026-09-08 用户决策：阶段门评审制）**：开发进行中 QA 只允许追加式产出——qa/、`test/journey-ke-*`、`test/fixtures/scholarly/` 下的**新文件**；绝不编辑 dev 源码、不部署、不杀进程、不派活；git 提交只 add QA 自己的文件
- 交互式会话活跃 → 只写日志退出（**绝不与用户会话并发操作工作区**）
- `lock.owner` 非空且未超时 → 只写日志退出；owner 为 `human-interactive` 时超时=交互会话 jsonl 30 分钟无写入；其它 owner 超时阈值 90 分钟，接管前必须确认无 claude.exe
- 熔断：连续 3 次巡航在同一 phase 失败（完工判定失败或测试红）→ `fuse.consecutive_failures` 置 tripped 状态、写明原因、停止派活，等用户处理
- 安静时段 00:00–08:00：只巡检与记录，不派活不跑测试不部署
- 每次巡航向 `logs/` 追加一条：`<时间> <分支决策> <结果>`

## 分支决策（按序判断，命中即止）

1. STATE 标记 PAUSED / fuse-tripped → 记日志退出。
2. 交互式会话活跃（jsonl mtime < 30 分钟）→ 记日志退出，不动锁。
3. `turn=zcode` 且 `stage_gate_pending=true`（阶段门触发：完工通知声明阶段末波次完成）→ 执行六拍全量：读完工通知 + `git diff/log` 核对 → 全量代码评审（P1/P2/P3）→ 清旧重部署 → mocked/real/demo E2E → 写 `qa/reports/` 阶段报告 → 写行动项任务书 → `turn=claude`；报告 PASS 后 `stage_gate_pending=false`、进下一阶段
4. **平时（开发进行中、非阶段门）— 白盒测试模式**（会话活跃时亦可执行，只要遵守追加式约束）：
   - 写/补测试：单测边界补强、`test/journey-ke-*.spec.ts` 旅程骨架、`test/fixtures/scholarly/` 录制件（对接 `FixtureScholarlyTransport`）
   - 只新增 QA 域文件；不部署、不杀进程、不派活；完工通知仅用于排测试优先级，不触发接管
5. `turn=claude` 且无 claude.exe 且 queued 非空（时效校验通过）→ 派发：
   ```bash
   cd "D:/codespace/sciencediscovery" && claude -p --dangerously-skip-permissions \
     "$(cat qa/handoff/DEV-BRIEF.md qa/handoff/to-claude/<最新任务书>.md)" \
     > qa/handoff/logs/dispatch-<YYYYMMDD-HHMM>.log 2>&1 &
   ```
   派发后：`budget.dispatches_today +1`，`turn=zcode`，lock.owner=zcode-cruise。
6. `turn=claude` 且有 claude.exe 在跑（上次派发仍在执行或交互会话活跃）→ 记日志退出。
7. 阶段报告 PASS → 自动进下一阶段（更新 STATE.stage/wave）；**波次之间 dev 连续推进，无 QA 门**。
8. 阶段 III（W5）报告 PASS → STATE=COMPLETE，停止派活，日志注明。

## 完工判定与失败计数

- dev 会话退出后：`to-zcode/` 出现新完工通知 **且** git 有对应提交/变更 = 成功（fuse 清零）
- 任一不满足 = 失败：fuse +1；任务书保留下次重派；**同一任务重派 2 次仍失败 → 熔断**
