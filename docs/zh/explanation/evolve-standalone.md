# 把演进侧车拆成独立后端

`services/evolve` 是一个 Python FastAPI 进程，跑 PUCT 树搜索。本文回答一个问题：把它从这个仓库里拿出去、当作独立后端运行，要做什么，会碰到什么。

结论先说：**代码层面它已经是独立的**，真正的工作在四个耦合点上，其中一个（共享文件系统）是硬的，其余三个是约定层面的。

---

## 1. 它现在有多独立

| | 现状 |
|---|---|
| 语言 / 进程 | Python 3.12，独立 venv，独立进程 |
| 第三方依赖 | `fastapi`、`uvicorn`、`pydantic`、`agentdescent>=0.4.6`（候选运行时的 numpy/pandas/scipy/sklearn 是可选组，属于候选而非侧车） |
| 对 Node 侧的 import | **零**——它是另一门语言，编译期耦合不可能存在 |
| 对仓库其它目录的路径依赖 | `pyproject.toml` 里没有任何一条 |
| 对外接口 | 四个 HTTP 端点 |
| 业务状态 | **不持有**。目标、评分卡、产物地址、run 记录全在控制面 |
| 模型密钥 | **不持有**。只拿一个 run 级临时 token 调控制面的代理 |

它自己的模块文档写着：*"this process holds no business state and no model key"*。这不是事后总结，是当初就按这个边界切的。

`services/evolve/` 目录可以原样复制到一个新仓库，`uv sync` 之后 `uvicorn` 起来就能跑——只是没有调用方喂给它合法的请求。

---

## 2. 对外接口

四个端点，全部靠一个共享的内部 token 鉴权（`SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN`；未配置时视为本地开发，回环绑定是唯一边界）。

```
GET  /health                 → {engine, running, sandbox_local, status}
POST /probe                  → 判别力探针，返回 {baseline, worsened, flat, label}
POST /runs                   → NDJSON 事件流（长连接）
POST /runs/{search_id}/stop  → 停止
```

`POST /runs` 的请求体 `RunRequest` 有 24 个字段。按性质分四类：

**(a) 纯数据，可以直接跨网**

`search_id`、`algorithm`、`expansions`、`workers`、`statement`、`scorecard`（冻结的评分卡正文）、`scorecard_hash`、`baseline_code`、`rubric`、`script`（评测脚本原文）、`source_material`、`candidate_timeout_seconds`、`max_tokens_per_call`、`thinking`、`packages`、`baseline_score`、`resume_from_sequence`、`engine`、`options`。

评分卡正文和评测脚本是**按值传的**，不是引用——注释写明理由：*"this side has no CAS, and an evaluator is a page of Python — smaller than one candidate."* 这个决定让侧车不需要访问内容库，是它能独立的重要一步。

**(b) 文件系统路径**

`dataset_dir`、`workspace_dir`。**这是唯一的硬耦合**，第 3 节详述。

**(c) 回调地址 + 临时凭据**

`llm: {url, token}`、`judge: {url, token}`。`url` 必须是绝对地址——注释说明过：*"a sidecar that had to guess the API's origin would turn every expansion into a failed candidate."* 这一点本来就是为跨进程准备的，跨机也不用改。

**(d) 上游探测结果**

`sandbox: {backend, ...}`。控制面探好沙箱能力再告诉侧车，侧车不自己探。

---

## 3. 硬耦合：共享文件系统

三条路径，两个方向。

### 3.1 控制面写、侧车读：暂存的数据集

控制面把每个 run 的分片物化到一个目录，侧车按 manifest 读：

```
manifest.json
<criterionId>/train.csv          每个分片的候选拿来训练的行
<criterionId>/<shard>/test.csv   只有特征，不含目标列
<criterionId>/<shard>/truth.json 目标值，候选拿不到
```

切分策略（种子、每片行数、哪些索引是 gate 分片）**由控制面决定**，侧车只读结果——`dataset.ts` 的注释：*"The split is decided here and read there... deciding it twice is how two answers disagree."*

`test_gate` 模式下还有 `workspace_dir`：项目的一份纯净副本，每次运行在一次性克隆里进行，冻结路径在执行前从这里还原。

### 3.2 侧车写、控制面读：候选源码

侧车把每个候选的源码按内容哈希写到 `evolve-candidates/<runId>/<sha256>.py`，控制面通过 `CandidateSources.read()` 直接读文件。`candidates.ts` 的注释说得很直白：

> The two processes share one filesystem and one data dir, so the sidecar writes and this reads; **there is no protocol between them beyond the layout**, which is content-addressed and therefore has nothing to agree about but the hash.

它不进 CAS，因为一个候选还不是产物——大多数会被拒绝，全部收进内容库只会塞满没人要的程序；用户保存某一个时才复制进去。

### 3.3 拆分后的三种做法

| 做法 | 代价 | 适用 |
|---|---|---|
| **保留共享卷**（NFS / 同一台机 / 同一个 Pod 的 emptyDir） | 零代码改动 | 同机或同 Pod 部署，最省事 |
| **数据集改上传，候选改回传** | 数据集要走 multipart 或对象存储；候选源码改成随 `expanded` 事件带回，或加一个 `GET /runs/{id}/candidates/{hash}` | 真正跨机 |
| **两边都换成对象存储引用** | 控制面写 S3/OBS 并传 URL，侧车下载；候选反向同理 | 多副本、水平扩容 |

第二条是最小可行的跨机方案。候选源码走事件流会让事件变大（一个候选几 KB 到几十 KB），走新端点则要处理生命周期（run 结束后何时清理）。

---

## 4. 三个约定层面的耦合

### 4.1 事件契约靠文档对齐，不靠代码

`events.py` 的模块文档写着：

> Mirrors `EvolveEvent` / `EvolveEventRecord` in `packages/schema` — the Node API parses exactly these shapes.

**这是一份手工维护的镜像。** 侧车用普通 dict 加小函数构造事件，理由是"这个联合类型有十个分支，唯一的消费者是 `json.dumps`，在这边再写一份 schema 就是多一处要同步的东西"。在同一个仓库里这个取舍成立——两边一起改，CI 一起跑。

拆开之后它变成跨仓库的兼容性问题：侧车加一个字段，控制面的解析器不认识；控制面改一个字段名，侧车照旧发旧的。需要：

- 给事件流定版本号（`schemaVersion` 或 `Accept: application/vnd.evolve.v1+json`）
- 把 `EvolveEvent` 的定义提成一个两边都消费的产物（JSON Schema / protobuf / 一个发布的 npm+PyPI 双包）
- 或者接受"侧车只增不改"的约束，并在控制面对未知字段宽容

同样的问题也在 `RunRequest` 上：它现在是 pydantic 模型，而控制面用 TypeScript 手写请求体。

### 4.2 两个不变量分散在两侧

有两条规则，写在侧车的注释里，但**执行者在控制面**：

1. **计数器是绝对值，不是增量。** `visits` 和 cell 占用是系统里仅有的非幂等量；重放一个增量会重复计数，重放一个绝对值不会。这条让控制面可以丢弃水位线以下的一切，也让中途的 Neo4j 故障可以靠重放事件日志修复。
2. **`-inf` 不上线。** `json.dumps` 会把它写成裸 token `-Infinity`，不是合法 JSON，`JSON.parse` 拒收。失败的候选带 `score: null` 且 `valid: false`，节点照样进树——丢掉它会改变之后每一次迭代的排名分母。

拆开之后这两条要写进接口文档，否则第二个调用方会踩。

### 4.3 vendored 的上游代码要有人跟

`vendor/puct/` 是从 [agentdescent](https://github.com/Birfy/agentdescent) 的 `examples/era` 抄进来的——**因为 wheel 不打包 `examples/`**，只能抄不能依赖。主包（`FlatPuct`、`Ledger`、verifier、policies）是正常依赖。

这意味着独立出去的后端会带着一份上游代码的副本，需要有人负责同步。这不是理论风险：最近一次对齐发现我们落后了

- `sys.modules["candidate"]` 未注册（候选里写 `from __future__ import annotations` + `get_type_hints` 会以 `'NoneType' object has no attribute '__dict__'` 失败，被记成"模型写了个坏程序"）
- 先验机制（`Candidate.prior` / `prior_exponent`）
- 修复循环的位置（上游已从合并线程移到工作线程）

建议在独立仓库里把"上游 commit 指纹 + 差异清单"写进 `vendor/puct/__init__.py`（现在已经有了）并加一个 CI 任务定期比对。

---

## 5. 拆分后谁做什么

侧车**不做**的事，都留在控制面，这些是新调用方必须自己实现的：

| 职责 | 现在在哪 | 说明 |
|---|---|---|
| 提案校验与预检 | `proposal.ts` / `preflight.ts` | 起点、切分、模型 token 上限、沙箱后端 |
| 评分卡冻结 | `scorecard.ts` + CAS | 冻结后搜索无法改写判分标准 |
| 数据集切分与暂存 | `dataset.ts` | 种子、分片、rollout/gate/test 三分 |
| 沙箱能力探测 | `sandbox.ts` | 容器里的 `--disable-userns`、procfs 回退 |
| 模型代理 | `llm-proxy.ts` | run 级临时 token，密钥不出控制面 |
| run 记录与事件持久化 | `store.ts` | 水位线、重放 |
| 图谱镜像 | `graph-mirror.ts` | 写 Neo4j |
| 产物发布 | `platform.ts` | 最优候选写进 CAS，成为产物版本 |

判别力探针（`/probe`）是唯一一件侧车替控制面做的"业务判断"，但它只回数字，是否接受由控制面决定。

---

## 6. 一份最小的拆分清单

**能立刻做的（零代码改动）**

1. `services/evolve/` 复制进新仓库，`pyproject.toml` 原样可用
2. 起服务：`SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN=... uvicorn sciencediscovery_evolve.server:app`
3. 部署成同机/同 Pod，共享 `SCIENCE_AGENT_DATA_DIR`（候选目录也可用 `SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR` 单独指定——两侧都读这个变量）

**跨机才需要做的**

4. `dataset_dir` → 上传接口或对象存储引用
5. 候选源码 → 新端点或随事件带回
6. `workspace_dir` → 同 4（只影响 `test_gate` 模式）

**独立仓库必须补的**

7. 事件流与 `RunRequest` 定版本，并把契约提成两边共享的产物
8. 把 §4.2 的两条不变量写进接口文档
9. 上游同步的 CI 任务

**可选**

10. 沙箱能力改成侧车自探（现在由调用方告知，是为了"不问两遍"）

---

## 7. 已知的粗糙处

拆分前值得先处理，否则会变成新接口的一部分：

- **`options` 是一个无类型的 dict。** `c_puct`、`prior_exponent`、`mode`、`async_ratio`、`staleness`、`completion_timeout` 都塞在这里，未知的键被忽略。跨仓库之后"传了一个拼错的键，搜索照常跑完并报成功"会更难发现。
- **`algorithm` 保留了 `era` 别名。** 更名为 `puct` 之后旧值仍被接受，因为控制面发的是存档目标里记着的那个名字。独立后端要决定这个别名保留多久。
- **模式默认由 `workers` 推断**（`workers > 1` 走 `async_evolve`，否则 `serial`）。这是个隐式规则，接口文档里要写明。
- **`staleness_policy` 默认 `"full"`**，注释说"没什么好过期的"，但线上实测确实丢过提案（20 次选择只落地 18 个）。拆分前值得查清，否则新调用方会继承一个没人解释得清的行为。
