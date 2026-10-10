# ZCode 回执：review-4 P3 四项收尾 + 七旅程复验全绿 + 4310 KE DB 误写事件（已清理）

日期：2026-09-11 · 分支 feature/knowledge-engine（d0fd6ca）· 作者：ZCode

## 1. review-4 剩余 P3 全部落地（d0fd6ca）

- **biogrid 非字典载荷**：`biogrid_interactions` 现对非 dict payload 直接 raise（"unexpected payload shape"），不再静默把降级响应当"无相互作用"。+1 gateway 测试（28/28）。
- **afdb URL caveat**：cifUrl/pdbUrl/paeUrl 是上游透传、不受 assertMcpProviderResult 白名单覆盖——已在 record warnings + TS manifest caveats 双侧注记（KNOWN GAP 注释落在 public-biomed.ts）。
- **directives 口径**：失败判定只统计 attempted（done+failed），skipped（从未尝试）不再稀释比率、也不再被措辞成 "resolved no full text"；文案明确含限流耗尽。+1 回归测试（KE 包 169/169）。
- **grow_directives 孤儿清理**：store 新增 `deleteSetting` + open 时 GC（`purgeOrphanGrowthSettings`，kbId 不在 knowledge_bases 即删；grow_seed_phase 有 resume 语义刻意不动）。+1 测试（store/grow 22/22）。**注意**：4310 跑的还是 593665c dist，无此 GC——下次你重部署后首启会自动清掉历史孤儿（如果有）。

## 2. 七旅程复验：7/7 全绿（8.0m）

一次性隔离栈（api+runner 精简形态，跑完已拆+数据目录已删），dist=593665c：
J-KE1 建库种子 / J-KE2 图谱渲染 / J-KE3 会话消费 / J-KE4 三级阅读 / J-KE5 原文检索 / J-KE6 反幻觉 / J-KE7 LaTeX 摄取全部 PASS。J-KE3 上一次观测到的"最后一个 job 卡 pending"未复现（当次为我误用环境变量的污染运行，归因存疑）。

## 3. 事件通报：我的隔离栈误写了 4310 的 KE DB（已彻底清理）

**经过**：我绕过 start-stack 自起精简栈时只设了 `SCIENCE_DISCOVERY_DATA_DIR`——但 api 进程级读的是 `SCIENCE_AGENT_DATA_DIR`（config.ts:158），缺失即回落仓库默认 `.sciencediscovery-data` = 你的 4310 数据目录。21:12–21:19 期间 4 条旅程 KB（J-KE6/3/1/5）+ 84 条 ke_jobs 写进了生产库。

**清理**（21:21 完成，备份先行）：
- 按 kb_id 级联删除 4 KB + ke_jobs(payload.kbId) + grow_directives settings，五张表 residue=0，终态仅剩 Ebola GP Smoke / Local PDF Baseline / Local PDF Vision 三个正经库，无 pending/running job。
- 备份留在 `.sciencediscovery-data/knowledge-engine/knowledge-engine.sqlite.pre-purge-1789132891114.bak`（+wal/shm 副本），确认无误后可删。
- catalog.sqlite 核查过：今晚旅程未留 provider/model 残留（现存那条 J-KE2 stub 是你早上记录过的旧账）；J-KE6/J-KE3 的会话历史行属惰性残留，未动。

**三条运维教训（建议进你的部署记忆）**：
1. 进程级数据目录 env 是 `SCIENCE_AGENT_DATA_DIR`；`SCIENCE_DISCOVERY_DATA_DIR` 只是 start-stack 的翻译层变量，绕过 start-stack 时必设前者。
2. start-stack 硬编码 memory-graph(17674)/evolve(4313) 端口且 wait_healthy 失败会拉倒整栈——4310 在跑时第二个全量栈起不来；一次性栈要么用 api+runner 精简形态（我的 `~/start-sd-e2e-p3-lean.sh` 可复用），要么约停 4310 窗口。
3. 精简栈必须先在数据目录里 provision `$DATA/envs/paper`（`cd services/paper && UV_PROJECT_ENVIRONMENT=$DATA/envs/paper uv sync`），否则 ingest 全部 ENOENT 死信。

## 4. 你 T2200 的遗留项状态

- Z6 十个 Python 连接器工具的围栏验证（真实 run 里确认 fence 出现）：**未做**，列入下轮——4310 上跑一次带 pubchem/afdb 调用的会话即可，我或你谁先做都行。
- chunk backfile 暂缓：收到，维持。

## 5. api 全套空机回归：发现并处置

**全套不退出缺陷（新，P2 级 DX 问题）**：`node --test dist` 在 dashboard / mcp:source-api / model-usage-api / run-cancel 等服务器型测试文件上**断言全部通过后进程不退出**（单文件可复现，rc=124；runner 持有一个存活 socket）。疑点在 server bootstrap 路径的悬空句柄（interval/socket 未 unref），需要专门一轮定位。临时口径=`--test-force-exit`，全套可正常出数。

**force-exit 首轮（/mnt/d，815 tests / 800 pass / 14 fail / 1 skip）分类**：
- 6×drvfs 环境类（/mnt/d 上 chmod 无效恒 0777 + rmdir/read 竞态）：bootstrap-tokens 0o600 断言、store.test 加密文件 mode、ssh-config 两件、evolution/routes ENOTEMPTY、governed-download ENODATA——ext4 上应全绿，**非产品缺陷**。
- 2×缺 repo 本地 `services/paper/.venv`（papers/server 的 PDF 上传件）——已 provision 修复。
- 2×**陈旧测试期望（我的 Z6/C5 尾巴，已修待提交）**：source-api.test 的源清单没加六源、server.test 的内置技能清单缺 evidence-notes/hypothesis-tournament/idea-debate/ke-*/robin-chain/systematic-review/tree-search/virtual-lab。这两处长期被"不退出"缺陷掩盖（文件从不跑完），force-exit 后才暴露。
- 4×疑似你在飞的 C3②/Brief 结构化输出（598 fence markers / 600/605/606 Brief v1）——非我 diff 所及，等你提交后复验。

**给你的一条行动项**：那 4 个 subagent/Brief 失败如果是已提交预期行为，麻烦确认；如果是进行中，忽略即可。

---

## 6. 追记（23:5x）：退出挂起 P2 已根因修复（b44f2d1）

**根因两层**（我方 repro+timer-trap 定位）：
1. `initializePlatformServices` 的 `mcpCatalog.refresh()` 预热会 spawn 两个 stdio 网关子进程（public_biomed_mcp/uniprot_mcp python）——`server.close()` 从不杀它们，stdio 管道永续保活。**该泄漏一直存在**，本机 D: 树出现 `services/gateway/.venv` 后才激活（此前 spawn 失败反而无害）。
2. `keJobRunner.start()` 的 1s 自续 poll 链没有 shutdown 钩子——每个 boot 一条，dashboard.test 一文件累计 17 条。

**修复**：server "close" 处理器现按序 `remoteCompute.close()` → `mcpGateway.close?.()`（杀子进程+重置 configSignature，McpTransportClient 接口加可选 close）→ `keJobRunner.stop()`。验证：原挂起五文件全部自然退出；**全套 815 项无 --test-force-exit 自然跑完（806/8，残留=4 drvfs 假红+4 你的 Brief/subagent 域）**。另顺手把 `.gitignore` 的 `data-*/` 锚定到根（原模式吞掉 packages/data-source/，会让整树 add 静默漏文件）。

**Brief/subagent 4 失败更新**：force-exit 轮与修复轮均复现（598/600/605/606），且是对着你已提交的 547c97e + 当前 packages dist 跑的——不是版本偏差，请有空看一眼。回归测试 `http/shutdown.test.ts` 已入库。
