# V2-Z2 DRIFT 两阶段检索全项完成 + V2-Z1 潜伏 bug 修复（HEAD 51905ae）

日期：2026-09-14 21:45 · 作者：ZCode · HEAD=51905ae（6241f1e → e915bd8 → 51905ae）

## 1. V2-Z2 drift_search 全项落地

- **机制核心**（`packages/knowledge-engine/src/graph/drift.ts`，纯函数零依赖）：Stage 1 对当前图谱指纹的社区报告做词法匹配（标题命中×2 权重）选出 top 社区；Stage 2 返回各社区的查询命中种子实体（名/描述命中优先，剩余名额按 support 补给定位条目并留空 matchedTerms——报告散文的主题命中先于成员名词法，这正是 DRIFT 的价值）+ 证据边（quote/端点名命中，未命中的边绝不凑数）。全程确定性：全 tie-break（score→support→id），J-KE4 彩票教训直接应用。
- **诚实空态**四分：no-graph / no-reports（用新 store 助手 `latestReadyFingerprint` 区分"从未生成"vs"旧代报告"）/ no-terms / 主题级词法未命中。
- **指纹读取零成本**：从 graph-roots.ts 导出 `graphFingerprintOf`（纯 store 统计，不触发 roots 重算/LLM 命名）。
- **接线**：tools.ts 适配器（端口注入，报告 findings JSON 防御性解析）+ workspace `drift_search` 注册（kbScope 作用域联动、诚实 LIMITATION 文案）；顺手补了 workspace 结构类型里 kbSearch 缺失已久的 minScoreRatio 成员。
- **J-KE9 旅程**（`journey-ke-drift-search.spec.ts`）：J-KE8 种子+报告 → 会话问主题版图 → drift agent stub（ke-stub.ts 新增 `keDriftAgentStub`）调 list_knowledge_bases → drift_search → **最终答复从真实工具结果解析派生**（社区标题/入口实体/逐字证据），断言真依赖非罐头字符串。
- **测试终态**：KE 包 194/194（+7）、workspace 106/106、api KE 域 124/124（+2）、**KE 旅程套件 9/9（9.7m）**（一次性栈 4396/4397，按协议跑完即拆+删数据目录）。

## 2. 顺手抓到并修掉一个 V2-Z1 潜伏 bug（e915bd8）——你下次重部署请带上

- **根因**：generate 路由信任 SWR roots 缓存，而缓存可落后 store 最多 60s（REVALIDATE_MIN_INTERVAL_MS）。J-KE9 第一跑实锤：报告被 key 到 e4:4:x2:2（2 边时刻的旧分区），而 store 已是 e4:40:x4:4——**报告生成了却永远匹配不上当前指纹**，任何活指纹消费者（drift_search）都会正确拒绝它。J-KE8 抓不到（覆盖率和报告读的是同一个旧指纹，自洽地"全绿"）。
- **修法**：`getGraphRoots` 加 `force` 选项（同步对活 store 重算）；generate 路由改用 force。普通读保持 SWR；force 计算顺带刷新缓存。回归测试 28/28（新增 force-bypass 用例断言指纹=活库指纹）。
- **重部署提醒更新**：下次窗口请带上 **5cc13ba（gnomad）+ e915bd8（报告指纹绑定）**。

## 3. post-z bench 状态更正

昨天 13:31 后文件停更不是进程死亡——是宿主机睡眠把 bench 进程（Windows PID 22864，仍活）一起暂停了。今晚 21:31 起恢复写入，当前 **126/539，正确率 53.2%**（hle-med 子集 55% 跑赢基线 40%）。收口仍归我：539/539 后对比基线守门 V1-Z。期间 4310 不动。

## 4. 给你的

- `journey-finish-gate.spec.ts:137` E2E-META 仍是 check-e2e-meta 唯一 ERROR（你域，无催）。
- V2-Z 剩余：L0 LLM 摘要+grounding 门、手动上传入 KB、PPR——待你任务书或我按路线图自行开工。

## 状态

V2-Z2 完成；post-z bench 在跑（机器别睡眠就能收）；下一项候命。
