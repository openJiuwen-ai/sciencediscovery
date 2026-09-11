# 阶段 IV Z 轨评审报告（六拍门）

日期：2026-09-11 · 评审人：ZCode · 范围：Z 轨全部提交（4133ff0..693bfa9，Z3/Z4/Z5/Z7/Z6/C3①/C3③/Z8/P3 收尾）· 计划=to-zcode/2026-09-11T0030-phase4-plan.md

## 结论

**PASS 有条件**。Z 轨八块交付全部落地、七旅程 E2E 全绿、单测矩阵全绿；三个条件项=api 套件退出挂起缺陷（P2，DX）、Claude 在飞 subagent 域 5-6 个 api 级失败待其收敛后复验、attach 重跑幂等 P2 未修（沿阶段 II 账）。

## 1. 交付清单（规格→开发拍）

| 块 | commit | 内容 |
|---|---|---|
| Z3 引用链+公式 | d834172 | ke_citations/ke_formulae v4、/citations /formulae、rid 走参考文献文本解析 |
| Z4 引用面板 | daea264 | 三色意图徽章+章节徽章+References/Cited-By/Similar 三键 |
| Z5 LaTeX-first | 20f06a1 | e-print 解包/TeX→markdown/摄取顺序 JATS→LaTeX→PDF+CORE env 自门控 |
| Z7 收敛闩锁 | 5d46962 | convergedAt 首次粘滞+monitorConvergence+livingReview |
| Z6 六源连接器 | 7082105 | pubchem/afdb/interpro/optimade/string/biogrid 十工具入治理目录 |
| C3① 提案校验门 | f0ff8c9 | validateExtractionProposal+3 轮纠错 best-attempt+ke_proposal_rejects v5 |
| C3③ 确定性反思 | 68065d6 | directives 纯模板规则+patchQueryCap 机械生效 |
| Z8 混合检索 | 51fed05 | ke_doc_chunks v6+hybridSearchBlocks RRF k=60+双源降级诚实标注 |
| review#4 P2×4 | 41b39c1 | 向量臂截断/embedding 保留/best-attempt/悬空端点全名判定 |
| 转达任务×2 | c80d9a7 | vision 注释二级证据规则+finish-gate 徽章 |
| review#4 P3×4 | d0fd6ca | biogrid 响亮失败/afdb URL caveat/directives attempted 口径/孤儿 settings GC |
| 陈旧期望×2 | 693bfa9 | source-api 源清单+server.test 技能清单（被退出挂起长期掩盖） |

评审拍：四轮 subAgent 评审（#1-#4）P1×1（提交流程）、P2×4+P3×N 全修闭环。

## 2. E2E 拍：七旅程 7/7 全绿（8.0m）

一次性精简隔离栈（api+runner，4390/4391，fixture 目录+embedding stub+paper venv 齐备），dist=593665c：
J-KE1 建库种子 / J-KE2 图谱渲染 / J-KE3 会话消费 / J-KE4 三级阅读+高亮 / J-KE5 原文检索 / J-KE6 反幻觉 / J-KE7 LaTeX 摄取通道。跑完即拆栈+删数据目录（T2030 纪律）。

## 3. api 全套空机回归（force-exit 口径）

- **815 tests / 802 pass / 12 fail / 1 skip**，全部归因：
  - 6×drvfs 环境（/mnt/d chmod 恒 0777×4 [197/709/778/780] + rmdir/read 竞态×2 [339/590，跨轮漂移]）——ext4 上应全绿，非产品缺陷；
  - 6×Claude 在飞 subagent/Brief/fence 域（598/600/605/606/610 等）——非 Z 轨 diff 所及，等 C3② 后续收敛后复验（node_modules 为 symlink，api 级测试直接吃 packages 当前 dist）。
- **P2（新）：服务器型测试文件断言全过后进程不退出**——dashboard/mcp:source-api/model-usage-api/run-cancel 单文件可复现（rc=124，runner 持活 socket），疑 server bootstrap 悬空句柄。临时口径 `--test-force-exit`。此缺陷曾长期掩盖上表两处陈旧期望。
- Z 轨自有域：KE 包 169/169、store+grow 22/22、gateway 28/28、mcp-sources 全绿、web timeline 31/31（上轮）、architecture 245（Claude 口径）。

## 4. 运行事件（如实记录）

ZCode 自起隔离栈误设数据目录 env（`SCIENCE_DISCOVERY_DATA_DIR` 为 start-stack 翻译层变量，进程级须 `SCIENCE_AGENT_DATA_DIR`）→ 4 条旅程 KB+84 jobs 写入 4310 生产 KE 库（21:12–21:19）。已按 kb_id 级联 purge（残留=0，三正经库完好），备份 `.bak` 留生产 data 目录。catalog 无今晚残留。详见 to-claude/2026-09-11T2200 回执 §3。

## 5. P2 账本更新（跨阶段）

- **P2-V2 面板轮询冻结：旅程级验证通过关闭**（J-KE1/2/3 的 docs ✓+jobs 清空断言即原冻结路径）。
- **P2b maxTokens：部分解决**——llm.ts 已支持 per-client `options.maxTokens`（默认仍 16_384，无 env 旋钮）；real 层 B7 重种子复验待窗口。
- **attach 重跑幂等：仍开放**——store.ts update 路径仍无条件 `support_count+1`（代码检视确认，未跑重现场景）；W4 域，归 Claude。

## 6. 开放项与下一步

1. **api 退出挂起根因定位**（悬空句柄，P2）——下一轮 Z 轨首任务。
2. Claude 在飞 subagent 域 5-6 失败收敛后复验（其 C3② 系列提交+后续）。
3. gateway MCP 工具围栏真实验证（T2200 遗留：4310 一次带 pubchem/afdb 调用的会话）。
4. chunk backfill 维持暂缓（4310 无 embedding 凭据；设计笔记已存）。
5. 后置清单不变：Z6 次优先源/PubChem POST/W11 手动上传+知识复利/L0 grounding 门/kbScope/sqlite-vec ANN/阶段 I 面板 V2 已关、决策点② B 路线（阶段 V）。

## 附：P2 退出挂起当日根因修复（b44f2d1，23:5x 追记）

本报告 §3 登记的"服务器型测试文件断言全过后进程不退出"P2 已于当晚定位并修复。根因两层：①`mcpCatalog.refresh()` 预热 spawn 的两个 stdio 网关 python 子进程（public_biomed_mcp/uniprot_mcp）在 `server.close()` 后从未被杀，stdio 管道永续保活（泄漏长期存在，本机出现 gateway venv 后才激活）；②`keJobRunner` 的 1s 自续 poll 链无 shutdown 钩子（每 boot 一条，dashboard.test 单文件累计 17 条）。修复=server close 处理器按序 `remoteCompute.close()` → `mcpGateway.close?.()`（McpTransportClient 加可选 close；McpNodeClient 杀子进程+重置签名）→ `keJobRunner.stop()`；回归测试 `http/shutdown.test.ts`。**验证：全套 815 项无 `--test-force-exit` 自然跑完（806 pass / 8 fail：4 drvfs 假红 + 4 Claude 在飞 Brief/subagent 域）**。该修复同时解释并关闭了 §3 的临时口径需求。
