# bench 基线抢救：断电中断已在钉定构建上续跑（4390 私有栈，4310 未动）

日期：2026-09-12 19:50 · 作者：ZCode · HEAD=01c4d56（你的 attachToEntity 幂等修复已入库）

## 事故还原（你需要知道的）

- **白天 ~10:05 宿主机断电/休眠**，WSL 硬停：4310 栈 + bench 进程同死。非代码问题。
- 基线跑到 **323/539**：litqa2/dbqa/hle-med/hle-biomed/supergpqa 完整，**evidence-synthesis 只 6 题（全 conn 错误）、trqa 全空**，另有 21 条散布的传输错误条目（多为你在 03:1x 基线期间重部署造成的窗口）。
- 你 19:31 重启 4310 + 19:33 重建 dist——**03:16 的基线构建冻结工件就此丢失**（当时运行中 api 进程的构建身份也变得不可判定：进程起于 dist 覆盖前 ~30s）。我判断无法再在 4310 上纯净续跑，且你在活跃迭代 4310，改走私有栈方案。

## 我做了什么（全部零触碰你的资产）

1. `~/sd-baseline-checkout`：clone 共享树 → 钉定 **a9ed783**（V2-C5 完整、pre-V2-C6、pre-V1-Z，原样可编译；fec6a12 不行——它带 c2a7177 的 runtime.test.ts TS2534，修复在 5c09f3d）。
2. `~/sd-baseline-data`：4310 数据快照（python sqlite3 `.backup()` 一致性拷贝 catalog/ke/web-cache/web-audit/mcp-result-cache 五库 + projects/ + messages/；envs 符号链接；versioning/scientific-envs/run-events/tool-outputs 刻意不拷）。**坑一枚供你记录：`model-secrets.key` 是根级文件，漏拷会让 api 自生新 key 然后一切加密 secrets 解密 500（"Unsupported state or unable to authenticate data"）**——已补拷修复。
3. `~/sd-baseline-launch.sh` 起 4390/4391 精简栈（同 token、含 minimax VISION env、无 embedding=4310 同款 fail-soft、gateway 解释器共享你树的 .venv 但脚本用我的 checkout）。
4. bench 续跑已启动：同 out 文件、concurrency 2、SD_BASE=4390。**首验证通过**：litqa2 错误条目重试后判对（80%=20/25），dbqa 10 条重试中。预计 ~4h 收口（trqa 172 + evidence-synthesis 50 + 散错 21 ≈ 237 次问答）。

## 基线的构建混合 caveat（守门时请知悉）

- 头 ~25 题（litqa2 早期）跑在 03:11 基线启动时的旧栈（593665c 时代，pre-V2-C）；中段 ~297 题在 03:16 构建时代；本次续跑 237 题在 a9ed783。
- **三段全部 pre-V1-Z** → 对 V1-Z/V2/V3 波次门控有效；但**不适用于 V2-C 单独评估**（本就无纯净 pre-V2-C 基线）。提交基线 json 时我会在 commit message 写明。
- trqa（多选格式）从未端到端跑通过（dryrun 只测了 litqa2）——若 trqa 判分异常，两侧同构仍可比较，但留意。

## 对你的请求

1. **bench 跑完前（~4h）不要 `wsl --shutdown`/休眠宿主机**——再断一次我就再续一次（逐题落盘），但白费机时。4310 你随便用，互不影响。
2. bench 期间 minimax API 有 2 并发常驻负载，你的 E2E 若打同一模型端点，错峰更稳。
3. 基线收口后我提交 json 并回执；**V1 出口的重部署窗口**（4310 → e3c7065+ 全量 + V1-Z 真实冒烟 + 七旅程复验）等你的协调信号——你 19:33 的重部署已把 e3c7065+ 你当时的 WIP 构建放上去了，等你这轮 store-resolution/attach 验证收尾后说一声即可。
4. `01c4d56`（attach 幂等）我已确认入库；本回执与基线 json 是我今晚仅有的两个提交。

## 4310 未动声明

我未重启/未写 4310 及其数据目录（快照是只读连接 .backup 出来的）。我的所有进程/目录都带 `sd-baseline-` 前缀，跑完即拆：`~/sd-baseline-checkout`、`~/sd-baseline-data`、4390/4391、`~/bench-resume-baseline.log`。
