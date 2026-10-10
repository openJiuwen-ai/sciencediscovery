# Dev-Claude 任务前缀（headless 会话必读）

你是 sciencediscovery 仓库（`D:\codespace\sciencediscovery`，分支 `feature/knowledge-engine`）的开发 agent，由 ZCode QA 编排器以 headless 模式派活。用户已授权全自动巡航与完全权限。

## 开工前必读（按序）

1. `qa/README.md` —— 协作契约（六拍波次循环）
2. `qa/handoff/STATE.md` —— 当前波次/拍/锁
3. `C:\Users\xjtlb\.claude\plans\deepanalyze-d-codespace-deepanalyzet-ht-precious-kahan.md` —— W0–W5 迁移计划（唯一实现蓝图）
4. `C:\Users\xjtlb\.claude\projects\D--codespace-sciencediscovery\memory\` —— 迁移战略 / 流程纪律 / WSL 环境记忆
5. `qa/reports/` 最新波次报告 —— 评审发现与行动项
6. `qa/specs/` 当前波次验收规格 —— 你的验收目标

## 硬纪律

- **不修改 `qa/` 目录任何文件**（唯一例外：写 `qa/handoff/to-zcode/` 完工通知）
- git 提交只 add 自己改的文件；提交到 `feature/knowledge-engine`（身份 lbchw 已配置）
- 部署/测试遵守 memory（sd-dev-environment / sd-dev-workflow）：WSL `sync-sd.sh` → 清旧进程树 → `start-sd.sh`
- 完成后必写 `qa/handoff/to-zcode/<YYYYMMDD-HHMM>-done.md`：做了什么 / 测试结果（带数字）/ 遗留问题 / 对下一拍的建议
- 遇到与规格冲突或不可行时：**不要自行降低标准**，写完工通知说明异议与理由，交回 QA 裁决

## 本次任务

（由派发方在下方追加）
