# QA 协作契约：Claude 开发 ↔ ZCode 测试

> 本目录是 sciencediscovery（feature/knowledge-engine 分支）SKE 迁移工程的 QA 协作子系统。
> 设计批准于 2026-09-08（与用户逐项确认：共享仓库分工 / 测试先行 / 复用 DA 凭据）。

## 角色分工

| 角色 | 职责 |
|---|---|
| Claude（Claude Code 开发会话） | 产品代码 + 单元测试；按 `qa/specs/Wn-acceptance.md` 验收标准开发 |
| ZCode（QA 角色） | 波次验收规格（波次开工前写好）、全量代码评审、E2E 执行与部署、波次报告 |
| 用户 | 最终决策；演示层人工 ground truth（埃博拉课题：mAb114 / REGN3471 / 7TN9） |

## 阶段门循环（2026-09-08 晚调整：波次门 → 阶段门 + 平行白盒测试）

用户决策：不再每波次介入评审。开发连续推进，QA 双轨并行：

**平时（开发进行中）— 白盒测试模式**：
- ZCode 基于已落地代码持续写测试用例：单测补强（边界/DA 回归陷阱）、journey 骨架（`test/journey-ke-*.spec.ts`）、scholarly fixture 录制
- 约束：**只新增 QA 域文件**（qa/、test/journey-ke-*、test/fixtures/scholarly/），绝不编辑 dev 源码；git 只 add 自己文件；不部署不杀进程
- Claude 每波次末写简短完工通知到 `to-zcode/`（供 QA 排测试优先级），**无需等 QA 即进下波次**

**阶段门（大阶段完成时）— 全量评审 + E2E 强化**：六拍完整执行一次——全量代码评审（P1/P2/P3）→ 清旧重部署 → mocked/real/demo 全层 E2E → 阶段报告（失效归因/调查建议/下阶段特性建议）→ 行动项清零后进下一阶段。

**阶段划分（默认，可调）**：阶段 I = W1+W2（主链路+增长闭环，首个可演示里程碑）；阶段 II = W3+W4（消费层+消解治理）；阶段 III = W5（评测加固收尾）。

## 工件布局

```
qa/
  README.md                # 本契约
  specs/Wn-acceptance.md   # 波次验收规格（测试先行，波次开工前存在）
  reports/                 # 波次报告（只增不改，历史可追溯）
test/
  journey-ke-*.spec.ts     # KE 旅程代码——必须遵守 .agents/skills/e2e-testing/SKILL.md
                           # （{ journey } fixture、E2E-META 11 字段、check-e2e-meta.mjs 强制）
  fixtures/scholarly/      # 外部学术 API（arxiv/EuropePMC/S2 等）的录制回放件
```

不进 `docs/en|zh` 镜像树（QA 工件非产品文档，不要求中英对照）；纯 markdown 不影响 `architecture:check`。

## E2E 分层（三横）

| 层 | 触发 | 依赖 | 说明 |
|---|---|---|---|
| mocked | 每次提交 / CI | stub 模型 + `test/fixtures/scholarly/` 录制回放 | 网络守卫保持默认全禁；学术 API 响应走本地 fixture |
| real | 波次验收 | minimax-text（管线 LLM）+ siliconflow Qwen3-Embedding-0.6B（1024 维）+ 真实学术 API | `E2E_REAL=1`；小预算（种子 10 篇）；凭据复用 DeepAnalyzet，配在 SD 设置 |
| demo | 关键波次（W1/W3/W5） | 全真实链路 | 埃博拉课题端到端；用户人工判抽取质量 |

## 旅程目录（三纵，随波次渐进落地）

- **管理**：建 KB、种子查询、任务状态轮询、KB 列表切换
- **图谱**：图谱渲染、实体详情、实体搜索、渐进下钻（W4 后）
- **消费**：KB scope 会话、带逐字证据回答、grow 控制面板、收敛徽章
- 另有存量 9 条旅程作回归底线，不得破坏。

## 失效归因四分类（报告必填）

产品缺陷 / 外部环境 / 测试缺陷 / 测试基建——每条失败必须给出证据（截图、日志路径、复现步骤）。

## 波次报告模板

```markdown
# Wn 波次报告（日期）
结论：PASS / FAIL / BLOCKED —— 一句话
## 代码评审发现（P1/P2/P3 + 文件:行号）
## E2E 结果矩阵（旅程 × mocked/real）
## 失效归因（四分类 + 证据）
## 调查建议（根因分析）
## 下一波次特性建议
## 给 Claude 的行动项（可勾选清单）
```

## 闭环驱动（2026-09-08 起：全自动巡航）

用户已授权**全自动级别**（含自动进波次）+ dev-Claude **完全权限**。三个组件：

1. **共享邮箱** `qa/handoff/`：`STATE.md`（波次/拍/轮次/锁/熔断——单一事实源）、`to-claude/`（QA 任务书）、`to-zcode/`（dev 完工通知）、`logs/`（巡航与派发日志）、`DEV-BRIEF.md`（headless 会话必读前缀）、`CRUISE-PLAYBOOK.md`（巡航决策手册）。
2. **headless 派活**：ZCode 编排器执行 `claude -p --dangerously-skip-permissions "$(cat qa/handoff/DEV-BRIEF.md <任务书>)"`，dev 会话按任务书工作并回写完工通知。走用户 Kimi K3 端点，注意额度（每日派发软上限 12）。
3. **定时巡航**：ZCode 侧每 30 分钟自动巡检（00:00–08:00 安静时段只记录不行动），按 playbook 分支推进；连续 3 次同拍失败熔断停派等用户。

**并发红线**：用户交互式 Claude 会话活跃（会话 jsonl 30 分钟内有写入）时，巡航只记日志，不派活不部署；锁超时接管前必须确认无 claude.exe 进程。

## 纪律引用

- 部署清理：杀进程树、端口无残留监听、确认跑的是新代码（先例事故见 Claude memory `sd-dev-workflow`）
- E2E 旅程契约：`.agents/skills/e2e-testing/SKILL.md` 全文适用，包括 worktree/SHA 纪律与报告工件要求
- 推送：gitcode origin，身份 lbchw；本目录随 feature/knowledge-engine 分支提交
