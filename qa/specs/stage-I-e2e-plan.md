# 阶段 I 门 E2E 执行预案（W1+W2 完成时触发）

> 状态：预案就绪（2026-09-08 20:3x 巡航落盘）。触发条件：STATE.stage_gate_pending=true
> （Claude 完工通知声明「阶段 I 末」）且交互会话空闲 ≥30 分钟。执行者：ZCode（锁接管流程按 playbook）。

## 0. 前置检查

- [ ] 完工通知含 W2 验收自查（对照迁移计划 W2 节：MMR/AA/Chao1/L-P 纯函数单测 + 真实 cycle）
- [ ] git 静止（无 dev 未提交变更）；HEAD 记录进报告
- [ ] 锁接管：STATE.lock → zcode-cruise（接管前确认无 claude.exe）

## 1. 环境准备（WSL 栈）

1. `~/sync-sd.sh install && ~/sync-sd.sh build`（rsync D:→WSL，含 CR 剥离）
2. 清旧部署：pkill 进程树 + 端口核查（4310/4311/4313/17674 无残留）
3. **mocked 实例**：起栈带 `SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR=~/sciencediscovery/test/fixtures/scholarly`（隔离数据目录、专用端口）；health 全 200；token 从 secrets 读
4. Windows 侧组装 `.e2e/`：`node test/sync-e2e.mjs --write`；确认 Playwright chromium 可用（巡航 #0 已验证缓存存在；若 Windows 直连 WSL :4310 失败 → 退回 WSL 内跑，记归因）
5. **real 实例**（第二遍）：不带 fixture env 的独立数据目录栈；用 `sd-qa-providers.json`（本地临时件）经 API 注册 minimax-text（默认模型）+ siliconflow-embedding（1024 维）——凭据不入库

## 2. mocked 层（CI 对齐层）

| 套件 | 内容 |
|---|---|
| 回归底线 | 现存 9 条 journey-*.spec.ts 全绿（不破坏） |
| J-KE1 | 建库→种子→任务成功→刷新持久（先过校准清单） |
| J-KE2 | 图谱渲染零 console error→实体详情逐字证据 |

**首跑校准清单**（logs/2026-09-08-1932-cruise.md 5 项）：
① 导航按钮名「知识引擎」按实际 UI 改；② scriptedModel 被管线多次调用的行为（必要时改为可循环脚本或裸 http stub）；③ stub 抽取 JSON 对照 `extraction` 实现的提示词契约；④ fixture 参数（max_results/maxPapers）与 orchestrator 实际取值校准——**优先向 dev 要运行时录制代理模式**（transport 包装 + `SCIENCE_AGENT_KE_SCHOLARLY_RECORD_DIR`），一次真实运行覆盖全部 7 项录制面；⑤ W2 grow 面的 fixture（若 grow 走连接器）。

## 3. real 层（波次验收级）

1. `journey-ke-seed-real`（阶段门时按白盒补写，@real 标签）：真实种子 "Ebola virus glycoprotein antibody neutralization" 10 篇，验收 ≥8 ready（B7）
2. minimax 管线抽取 + siliconflow 1024 维写入验证（B8；查 ke_entities embedding BLOB 非空率）
3. 实体数 150–250 区间（A4）；溯源门抽查：随机 10 条边 evidence quote 回原文可验证
4. W2 增长：grow 2 个 cycle（maxPapers=10/depth=1）真实跑通，四信号计算正确、L-P 兜底显示
5. 失效归因四分类记录（学术 API 波动 → 外部环境，不熔断）

## 4. demo 层（可选，用户决定）

埃博拉全链路 + 用户人工 ground truth（mAb114/REGN3471/7TN9）。建议放阶段 I 门演示环节由用户在场跑。

## 5. 全量代码评审

范围：`e2c07ed..HEAD` 全部 dev 提交（f4036b5/81cce98/4208c92/W2 末提交）+ 工作区收尾核查。
重点（W0 已评审过的不重复）：grow 选择/收敛算法正确性（对照 DA 直搬源）、SSE 防竞态、
前端轮询/指纹门控、C10 lean 查询在 grow API 的延续、错误分类传播。

## 6. 产出

- `qa/reports/2026-09-08-stage-I-review.md`（结论 PASS/FAIL/BLOCKED + E2E 矩阵 + 归因 + 评审发现 P1-P3 + 调查建议 + 阶段 II 特性建议 + Claude 行动项）
- 通过 → STATE：stage=II、stage_gate_pending=false、wave=W3；不通过 → 行动项任务书 to-claude（不熔断除非连败 3 次）

## 预算

单门预计：评审 1 次巡航 + 环境与 mocked 1-2 次 + real 1 次（学术 API 波动可能重试）。K3 额度不消耗（E2E 不派 dev；real 层消耗 minimax/siliconflow API，量级：10 篇抽取 + ~200 实体 embedding）。
