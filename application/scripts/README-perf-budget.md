# perf-budget — CI timing guards

耗时看护门禁：把壳 / start-stack / jiuwenswarm 三域已打好的
`[SD-PERF]` / `[perf]` / `[warmup]` 毫秒打点，变成可判定的两层预算
（挂死预算 + 回归预算）。设计文档见
`mac-design` 仓 `perf-guard/design/P1_耗时看护体系设计.md` §4。

## 一分钟上手

```bash
# 判定一份 shell.log（出包冒烟后跑；退出码 0=过 / 1=挂死 / 2=用法错）
node scripts/perf-gate.mjs ~/Library/Logs/sd-shell/shell.log

# CI / 脚本消费
node scripts/perf-gate.mjs <log> --json
node scripts/perf-gate.mjs <log> --fail-on-regression   # 发布跑或两连击时用
node scripts/perf-gate.mjs <log> --hang-only             # CI 机器无本机基线时

# 单测（18+3+2 项，fixture 钉死 2026-11-24 真机实数）
node --experimental-strip-types --no-warnings --test test/perf-budget.test.ts
```

## 机制（四件怎么配合）

```
shell.log ──parse-perf-timeline.mjs──▶ 事件流（按 module-load 切会话，
                                        provisioning 标记分 first/warm 档）
              │
              ▼ 事件对差值（同域减 offset；跨域用 ISO 墙钟）
        {component: durationMs}
              │
              ▼ perf-verdict.mjs + perf-budget.json
        三态判定：ok / regression / hang
              │
              ▼ perf-gate.mjs（CLI）
        报告 + 退出码（hang=1；regression 默认 warn=0，
        --fail-on-regression 或两连击时=1）
```

### 判定规则

| 判定 | 条件 | 后果 |
| --- | --- | --- |
| `ok` | 两层线内 | — |
| `regression` | 超 `baselineMs × 1.4` 但未超 `hangMs` | **warn**（退出码仍 0）；连续第 2 次由外层升为 fail |
| `hang` | 超 `hangMs`；**或事件对缺失**（ready/healthy 行从未出现） | **fail**（退出码 1，带缺失事件归因） |
| `blocked` | 事件对缺失**仅因上游组件挂死**（如 jw 没起来 → AGENT-READY 不会发） | 归因到**根**（`BLK ... blocked by jw-ready`——报根因不报中间跳，F6），不重复计数 |
| `skipped` | 组件被合法禁用——会话里有栈侧显式 `*-skipped` 打点（F7：`SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE=0` 等文档化配置） | 可见不判定（`SKP ... feature off`），不算 hang |

**退出码**：0 过 / 1 有 hang / 2 用法错 / **3 会话存在但零判定行**（什么都没测到——reuse / wizard 路径目前不发 kind 标记，属覆盖缺口信号而非通过）。

规则细节：

- **缺失即挂死**：组件的 healthy 事件没到，本身就是挂死信号——判
  hang 而不是放过（W25 教训：门禁全绿但用户等几分钟的形态不允许
  重现）。
- **零判定 = exit 3**：一个没测到任何东西的 run 不允许报绿（同 W25
  形态的 CI 版）。
- **分档判定**：`first`（首启）与 `warm`（热启短路）用各自预算表；
  混档必误报。识别不了档位（reuse/wizard 路径无标记）报 note 拒猜。
- **从属归因**：`BLOCKED_BY` 表实现（jw→agent-ready→shell-ui/warmup
  传递闭包求根）——一次 jw 挂死只红一条，级联行标 blocked；
  `agent-ready` 的 180s 与运行时常量 `AGENT_READY_TIMEOUT_MS` 对齐
  （单测从 `src/main.ts` 读源码钉死耦合）。
- **copy 路径豁免**（原 warm unpack 豁免推广）：unpack 对缺失时看
  **证据而非档位**——会话里有 `bootstrap short-circuit` 或
  `bootstrap in-place-fix-enter`（win32 in-place 分支在 unpack 之前
  return）即豁免；provisioning=true + in-place 的健康 win32 首启不会
  误报。
- **hang-only 模式**（`--hang-only`）：CI 机器没有在本机采过基线时，
  回归层（基线×容差）无意义（构建机基线铁律：跨机器比较无意义），
  只判挂死层（绝对秒数跨机器成立），其余行报
  `no baseline for this machine`；从属归因照常。CI 首采基线（P3-2）
  落地后换回全量判定。

### 两层预算的数值出处

`perf-budget.json` 的 hangMs（H1-H9）与 baselineMs（R1-R12）出自
设计文档 §4a/§4b，基线采自 2026-11-24 签名 v0.4.0 包的真机三会话
日志（首启 18.8s / 热启 8.5s & 8.2s 到 AGENT-READY）。热启基线是
两会话均值；n=1~2 的项待 P3-2 发布跑补到 n≥5 冻结。

## 预算维护（改 perf-budget.json 前必读）

1. **hangMs 改动 = 走 PR + 带实测依据**。阈值不可放松到测不出
   事故（pyc-budget 先例：单测里钉着 W25 事故实数）。
2. **回归基线只在发布跑刷新**；PR 跑只读比对（防青蛙温水：
   每次刷新都比上次慢一点）。刷新时更新 `updated` 字段并记 n。
3. **加新组件**：在 `parse-perf-timeline.mjs` 的 `PAIRS` 表加事件
   对（必须单域，或跨域但两行都带时间戳）→ 在 perf-budget.json
   两档都加预算行 → 跑单测（`COMPONENT_NAMES` 交叉校验会抓漏配
   对的死预算行）。
4. **防呆测试已钉**：hang 线必须严格高于回归线；容差被锁在
   1.2-2.0 区间；verdict 内存表与 json 必须一致（单一真源）。

## 已知边界（诚实清单）

- warmup 段只覆盖 `AGENT-READY → [warmup] 200`；模型 API 往返不
  归 CI 看（首答全口径归真机实测，见设计 §1 分层）。
- `adapter-spawn` 无 healthy 配对（缺口①，P2-1 补打点）。
- warmup 只记 status 无 elapsed（缺口②，P2-2 补）——本门禁用墙钟
  近似，两处打点补齐后换精确值。
- 基线 n=1~2，单机单环境；跨机器比较无意义（构建机基线铁律）。
- 时间戳继承误差：无时间戳裸行继承上一行时间戳，实测误差为
  管道 flush 间隔（亚秒级），远低于秒级预算线。

## 接线状态

- **已就绪**（本 PR）：机制件 + CLI + 单测，纯函数零行为变化。
- **已就绪**（本 PR 增补）：`--hang-only` 模式（CI 机器无本机基线时
  只判挂死层）+ `perf-smoke-mac.sh` 冒烟脚本（出包后真启动 App：
  隔离 HOME、预种 wizard 状态、等 AGENT-READY、温退出、交门禁判定；
  超时/中途崩溃不放弃——把日志交给门禁判成 hang 才是冒烟的意义）。
- **P3-1**（待拍板后）：`build-mac.sh` step 6 接线
  `perf-smoke-mac.sh`；两连击计数逻辑届时放 CI wrapper。
- **P3-3**（可选）：Windows 侧 `package-sd-windows.sh` 同构对接。
