# V2 波 C 轨六项全落地（kbScope/账本/groundedness/清洗/检索史/稳健性）

日期：2026-09-12 · 作者：Claude · HEAD=f30a356 已推送（a607a23 → 46ca8a2 → 66a0e9a → a9ed783 → c2a7177 → f30a356）

## 交付清单（均经 subAgent 评审 + 测试全绿，评审发现的问题全部修复）

| 项 | commit | 内容 | 评审 |
|---|---|---|---|
| V2-C1 kbScope | a607a23 | 设置字段 kbScopeKbIds/kbScopeWebSearch；keTool 单库默认填充+越界拒绝；prompt scope 行；**web 禁令走 profile.toolPolicy**（E2E 抓出真 bug：WorkspaceAgentOptions.toolPolicy 被 create-agent-run.ts:84 的 profile 合成静默覆盖——主 run 工具政策只认 profile）；子代理镜像；resident-summary 包装过滤 | 0P1/2P2 |
| V2-C2 项目账本 | 46ca8a2 | Kosmos 式跨轨迹世界模型：promote/hydrate/project-summary；goal 时序（新者胜）；dropped 不复活；跨进程锁（mkdir+ownership fencing）；originId 跨存储审计；不确定性台账 evidence 指针 | 2P1+6P2→复审 SHIP |
| V2-C3 groundedness | 66a0e9a | OpenScholar 引用验证必经化机制硬阶段：finish-gate stage 2——确定性提取草稿引用段（引号对/blockquote），与本 run verify_citation/ledger verify 覆盖比对，未验证→directive；E2E 实证：门火后模型补 22 次 verify_citation 才收尾 | 0P1/2P2 |
| V2-C4 报告清洗 | f30a356 | polish_report 工具：样板剥离（头部 20 行限定）+ verifyCitation 逐字臂精确补标 [n]（未验证原样保留）+ 围栏感知标题归一；exclusive+.md 守卫；report-writer 技能 final pass | 1P1+5P2 |
| V2-C5 检索史 | a9ed783 | run 级检索记忆 contributor（活在 NativeAgent 实例上=天然抗压缩）；"do NOT repeat same tool+query" 段（4K 预算）；压缩模板检索史标题（跨重启双保险） | 0P1/4P2 |
| V2-C6 稳健性 | c2a7177 | runtime-core stallGuard（模型调用静默 idleMs→只踢 attempt，3 踢有界失败，stall_kick 事件全管线）；finish-gate stage 1.5 终止干预（空内容/重复退化/计划未执行）；MAX_FINISH_GATE_CONTINUATIONS 2→3 | 0P1/2P2 |

## 接口契约变更（你侧可能需要知道）

- `EffectiveRuntimeSettings.kbScopeKbIds: string[]`（必填默认 []）+ `kbScopeWebSearch?: boolean`；settings PUT 接受两字段（形状校验，存在性 run 启动才对 KE 校验——未知 id 只披露不 400）
- keTool 参数 schema 在 kbScope 绑定时 kbId 变 Optional（未绑定时逐字节一致）；polish_report 加入 KE 工具组（默认围栏 knowledge-base，exclusive）
- `MainAgentProfileInput.deniedToolNames?` 新可选字段；**主 run 工具政策只认 profile.toolPolicy**（create-agent-run.ts:84 覆盖 workspace 级——以后加禁令走 profile）
- research_state 工具加 promote/hydrate/project-summary 三动作 + question-resolve evidence 参数；账本在 `{dataDir}/research-ledgers/{projectId}/.research/ledger.json`（自动水合每 run 一次）
- finish-gate 三阶段（audit→intervention→grounding），MAX_FINISH_GATE_CONTINUATIONS=3；RunEvent/RunStreamEvent 加 stall_kick 变体
- 压缩 checkpoint 标题 +1（"Retrieval history and read documents"，解析按名查找向后兼容）

## 真实层验证状态

- 4310 上已 E2E：kbScope 禁令（绑库后 0 web 调用）、账本双会话水合、grounding 门火→22 verify
- **待 bench 完成后重部署窗口**：V2-C4 polish_report 实栈验证 + V2-C5 段注入 + V2-C6 踢讯观察 + Z 轨全部 V1/V2 内容 + 七旅程复验
- bench 基线在跑（dbqa 收尾中，之后 hle/supergpqa/trqa；**期间不要重启 4310**）
