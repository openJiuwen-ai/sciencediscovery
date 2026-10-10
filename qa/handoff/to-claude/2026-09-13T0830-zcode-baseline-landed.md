# 基线落地：bench-v1-baseline 539/539 已提交（676df93）——重部署窗口 GO

日期：2026-09-13 08:30 · 作者：ZCode · HEAD=676df93

## 基线数字（守门参照，越基线为退化）

| 子集 | accuracy | 备注 |
|---|---|---|
| LitQA2 | **80.0%**（20/25） | 论文 64.7% |
| DBQA | 54.0%（27/50） | 拒答 13、precision 84.4% |
| HLE-Medicine | 40.0%（12/30） | 论文 40% |
| HLE-Biomedicine | 65.0%（26/40） | |
| SuperGPQA-hard | 45.3%（78/172） | 论文 47.1% |
| EvidenceSynthesis | **94.0%**（47/50） | 本轮续跑段 |
| TRQA（多选） | 59.9%（103/172） | meanF1 86.7% |

总 313/539=58.1%；18 条错误条目（13 trqa 超时+5 dbqa）按错计冻结。**构建溯源 caveat 已写进 commit message**（三段构建全 pre-V1-Z；对 V2-C 单独评估不可用）。终审计 AUDIT-CLEAN（我方 237 次问答零他侧残留）。钉定栈已拆净（4390/4391 释放、快照与 checkout 删除；bench 日志留 `~/bench-resume-baseline.log`）。

## 重部署窗口清单（你的 T2120 待办 + 我的补充，按序）

1. **4310 停→sync→build→重启到 HEAD（676df93+）**——含我全部 V1-Z 四项、gwas 标签修复、J-KE4 钉定，你的 V2-C 全量、V3-C1..C5。
2. 你侧：V2-C4 polish_report / V3-C1 agent memory / V3-C2 plan-first 实栈 E2E + V3-C3 hover 手动验证。
3. **skill-test-runner 轻量真实验证**（T2100 你留的）：1-2 场景即可，我可以代跑——说一声。
4. post-z bench：**另起 `qa/baselines/bench-v1-post-z-<date>.json`** 在重部署后的 4310 跑（~13h，建议夜间）。对比基线守门 V1-Z。
5. 我侧已备好：七旅程 7/7（5931d95）、V1-Z 真实冒烟 PASS（6dde709）——4310 重部署后我做一轮轻量确认（novelty 外部反证 + 七源连接器各一发）即可关 V1 出口。

## 开放项提醒

- reader-vs-gate 块级/文档级 parity 缺口（P3，我域，V2-Z 间隙修）。
- playwright actionTimeout 缺失（e2e 配置小改，谁先动都行）。
- 聊天侧 scite 徽章桥：待用户定向（我倾向后置）。

V1 出口就差重部署窗这临门一脚——你 ready 就开工，我这侧无阻塞。
