# 双 Agent 闭环状态（单一事实源）

> 规则见 qa/handoff/CRUISE-PLAYBOOK.md。任何 agent 修改本文件必须同时把动作追加到 logs/。

```yaml
stage: phase-IV（双轨并行开发，计划 2026-09-11T0030-phase4-plan.md）
wave: Z 轨 Z6+C3①+C3③+Z8+e-print fixtures 落地（7082105..fixture 提交）+ C 轨 C3②/C6（Claude，78684ed/292eedc）
stage_gate_pending: false
PAUSED: true    # 巡逻保持暂停（用户明示删除 cron，恢复须用户明示）
dev_mode: zcode-developer    # ZCode=KE 域纵深（Z 轨），Claude=agent 运行时侧（C 轨）；最新交接 to-claude/2026-09-11T1330-zcode-z6-c3-z8.md
cruise_automation: deleted
qa_mode: dev-verify
turn: zcode
lock:
  owner: zcode-dev-round
  since: 2026-09-11T00:30+08:00
fuse:
  consecutive_failures: 0
budget:
  dispatches_today: 0
dev_round_status:
  commits: >-
    3bbde0c W7 接线（文档行+证据卡→reader+KaTeX+i18n）；5597cc9 W8 尾（kb_expand/doc_grep）；
    aaf7925 J-KE5；4c6a1e8 review#1 P1/P2/P3 修复（高亮 effect 守卫顺序=真 P1）；d51bb0d W9
    （三级注入+novelty_check+verify_citation+evidence_ledger+J-KE6）；f3eb72a ke-stub 弯引号修复；
    2cd7cfd J-KE4 排空预算 180s；e1dd935 review#2 修复（stub 解析转义 JSON、grep 扫描预算、
    ledger 独占+原子写、50→200 文档上限+诚实标注）；d5cd81a 旅程预算 900s/600s；
    d834172..fbc2b5 阶段IV Z3/Z4/Z5/Z7（引用链三件套+意图面板+LaTeX-first+闩锁）；
    7082105 Z6 连接器扩容（pubchem/afdb/interpro/optimade/string/biogrid 六源十工具入治理目录）；
    f0ff8c9 C3① 抽取提案校验门（严格校验+3 轮纠错重试+ke_proposal_rejects v5 留证）；
    68065d6 C3③ grow 周期确定性反思→directives（patchQueryCap 机械生效）；
    51fed05 Z8 混合检索（ke_doc_chunks v6+RRF 融合+降级）；e-print fixtures（1706.03762 真
    tarball+1901.02624 PDF-source 降级面）
  unit_tests: >-
    KE 包 166/166、api KE 域 98/98（WSL）、gateway 27/27（uv）、mcp-sources 9/9、
    apps/web tsc 0、architecture 243 OK；api 全套待空机补跑（Claude 在飞 finish-gate/runtime-core
    期间全量 typecheck 暂红，KE 域编译干净）
  subagent_reviews: >-
    #1（接线轮）NO-GO→修复后 GO：抓到 P1 高亮 effect 守卫顺序（blocks 只在 L1 payload，先判 blocks
    再切层=永远切不了）+ P2 gate/reader 不对称（词重叠臂通过的引文读不到块）→ gate 对称修复；
    #2（W8+W9）NO-GO→修复后 GO：P1-2 stub 正则匹配不到转义 JSON（工具结果是 body 里的 JSON 字符串，
    引号带反斜杠）→ JSON.parse 后在解码内容上匹配；P2 ReDoS 扫描预算/ledger 并发竞争/50 文档静默假阴性；
    #3（W10 轮）P1 漏提交 orchestrator 修复；
    #4（Z6+C3①③+Z8+J-KE7）FIX-FIRST→修复后 GO（41b39c1）：0 P1；4 P2 全修——kb_search 向量臂
    全量加载文档（改 topK×2 over-fetch+onWarn 降级日志）、重抽取抹向量（replaceDocChunks 保留存活
    锚点的 embedding）、纠错重试末轮覆盖最优轮（best-attempt 保留）、悬空关系端点不留证（对全部
    已发射名判定→纠错循环+留证）；顺手修 P3×6（空提案重试/FTS 臂对称截断/死字段/truncated 精确
    语义/RRF 注释失实/pubchem 值上限）；七旅程 stub 端点闭合性核验=行为中性。遗留 P3×6 记录在
    review 报告（biogrid 形状漂移告警/afdb URL 注记/directives 措辞/孤儿 settings 等，低风险）
  e2e_mocked: >-
    全绿（第 5-6 轮，隔离栈 4390 + 私有检出场 ~/sd-e2e-checkout@df6ba07）：J-KE1 1.9m ✓
    J-KE2 58s ✓（/api/environments 503 豁免，见下）J-KE3/4/5/6 ✓ 4.0m。
    **J-KE7（arXiv LaTeX-first 摄取）2026-09-11 下午新增并全绿**（6.0s 暖栈；隔离栈 data7 +
    ~/start-sd-e2e-jke7.sh 启动器，fixture 目录指向私有检出场）：短语引号种子查询 → 1706.03762
    走 e-print tarball → API 断言 ingest_channel=arxiv-latex → 阅读器 L0 摘要（TeX 转写的标签/
    50 条引用/[@rid] 句）→ 切 L1 锚点块渲染。首轮失败=断言找 L1/L2 容器而默认层级是 L0（旅程修
    正 cc98894 后继提交）；两轮报错根因=误用 checkout 自带 playwright 副本（与 spec 解析的
    ~/sciencediscovery 副本成双实例→test.use 收集失败；正确跑法=memory 里的 cli.js 路径）。
    前四轮历史失败与修复：①600s 预算<实际管线→900s；②KE 全屏浮层盖侧栏→step2 先 ke-close；
    ③点击已激活 KB 清空面板且轮询链死（P2 产品缺陷，c5c2ab9）→同库重点击=手动刷新；④页面开机
    拉一次 /api/models→注册后 page.reload；⑤引文跨页拆块无单块≥85%→reader 加 60% 兜底档
    （61fc4bc）；⑥离线栈 provisioner 恒 503→J-KE2 定向豁免（df6ba07）。
    七旅程 stub 端点闭合性已核验=review #4 修复对现有旅程行为中性；全套 7 旅程复验挂下次栈重部署
    （当前 4390 跑的是 ~/sciencediscovery 现有 dist，未含 41b39c1 修复——重部署归 Claude 节奏，
    勿覆盖他的 dist）
  mcp_visual: >-
    完成——Windows Edge 实访 4390：KE 页图谱（mAb114⇄GP binds）→节点详情证据卡（校准 quote）→
    查看原文→L1 自动切换+逐字高亮（无 miss/fuzzy）→L0（摘要+标签+来源）→L2（markdown 渲染）全过
  kbScope: 显式延后（resident summary 已注入 KB 发现 + 显式 kbId 符合失败哲学；真绑定属 settings 层设计→留 Claude）
  finish_gate: Claude 在飞（finish-gate.ts 未跟踪+runtime-core 改动，收尾中）
notes: >-
  阶段 I 开放项（P2-V2 面板冻结/maxTokens）与阶段 II E2E 窗口被开发轮取代——待用户重定向。
  Claude 与 ZCode 同分支并行开发中：分文件提交纪律双方保持；ZCode 的 E2E 一律走
  ~/sd-e2e-checkout 私有检出场，不再用 ~/sciencediscovery（Claude 会话活跃）。
  Z6 扩进了 mcp-sources/gateway/settings.ts（超出 phase4 §3 Z 轨文件清单，已在交接件记录）。
  Z8 存量 KB 无 chunk 行（下次重抽取才生成）；chunk backfill 任务待 Claude/用户裁决。
```
