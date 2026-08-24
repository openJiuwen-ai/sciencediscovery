# 评审与溯源机制

评审与溯源横跨控制 API 的多个模块：Reviewer Specialist、claims/evidence 模型、内容寻址存储（CAS）与 Prompt Manifest。目标是让 Artifact 能回溯到已记录的执行、产物或外部记录。用户视角的行为见[运行时行为参考](../reference/runtime-behavior.md#权限与评审器)；本文描述实现机制。

## 1. CAS（内容寻址存储）

CAS 是溯源体系的地基：所有需要事后核验的内容都以「SHA-256 哈希 = 地址」的方式落盘，记录里只保留引用。这样同一内容天然去重，任何记录都可以在之后重新哈希校验。

实现位于独立的 `@sciencediscovery/cas` 包；API、Runner 相关调用方共享同一地址与校验口径，公开边界见英文 [CAS 说明](../../en/explanation/cas.md)：

- **地址**：`hash(content)` = 内容字节的 SHA-256 十六进制（64 字符）。对象路径为 `.sciencediscovery-data/cas/sha256/<hash 前 2 位>/<完整 hash>`，前 2 位作扇出目录，避免单目录文件过多。路径构造前先用 `/^[a-f0-9]{64}$/` 校验哈希，杜绝路径注入。
- **写入 `put(content)` / `putFile(path)`**：
  1. 先 `stat` 目标路径——已存在则重新哈希校验一次（`verify`），通过即直接复用（去重），校验失败抛错而不是覆盖；
  2. 不存在则写临时文件 `<path>.<pid>.<uuid>.tmp` 再 `rename` 到最终路径。rename 在同一文件系统上原子，因此并发写同一对象或进程中途崩溃都不会留下半截对象——最坏情况只剩可忽略的 `.tmp` 残留。
  3. 返回 `CasObjectRef { hash, size }`——记录中存的就是这个结构，不含内容本身。
- **读取与校验**：`read(hash)` 按路径读回；`verify(hash)` 读回后重算 SHA-256 与地址比对，不存在返回 false；`has(hash)` 仅探测存在性。
- **不可变、无删除**：本轮没有删除或修改接口。对象只增不改；单独删除 Session 不删除产物版本或 CAS 对象，CAS GC 另行设计。

**谁在写入**（`cas.put` 的调用方）：

| 调用方 | 入 CAS 的内容 |
|---|---|
| `provenance.ts`（`ProvenanceRecorder`） | 执行代码、stdout、stderr；生成文件内容（derivation 与 artifact 版本） |
| `prompt-manifest.ts` | 每个模型轮次的系统提示、输入消息、模型响应 |
| `mcp/broker.ts` | MCP 调用的请求、原始响应与规范化结果 |
| `papers.ts` | 视觉分析的请求与原始响应 |
| runner 环境目录 | 环境 revision 快照以同样的 SHA-256 口径计哈希（存于 runner 侧，见 [sandbox-execution.md](sandbox-execution.md#6-科学环境)） |

**消费方**：Reviewer Specialist 与溯源接口用 `verify` 核对引用对象；产物 diff、artifact 预览、审计查看用 `read` 按需取回内容；`ModelInvocationUsage` 等轻量记录则完全不碰内容，只经 Prompt Manifest 间接引用。

## 2. 执行记录与产物关联

每次沙箱运行落一条 `ExecutionRun`（`.sciencediscovery-data/execution-runs/<sessionId>.json`）：工具名与语言、code/stdout/stderr 的 CAS 引用、exitCode、起止时间、`environmentRevisionId`、`kernelMode`/`kernelId`、`permissionEpochId`、`networkPolicy`（生效的沙箱网络模式，默认 `"none"`）与 `networkAccessRevision`（有允许列表时的策略 revision）、`sandbox: "bubblewrap"`、`createdFiles`/`modifiedFiles`、状态（succeeded/failed/cancelled），以及执行环境溯源两字段：

- `workingDirectory`：Runner 回报的沙箱内实际工作目录（如 `/workspace/subdir`；持久 shell 为求值结束后的 cwd）。历史记录为占位 `"workspace"`；执行前失败的记录为 `"unavailable"`。
- `envSnapshot`：本次执行有效环境变量的 CAS 引用（内容为按键排序的规范 JSON）——相同 env 自动去重，不同 env 哈希可区分，`cas.read(hash)` 可取回全量键值。Runner 未回报（执行前失败）时为 `null`；历史记录缺省该字段。

一次性执行记录的是 `--clearenv` 后注入的精确变量集；持久内核/持久 shell 记录 worker 在求值结束时观测到的进程 env。

Artifact 的 Provenance 页会在每条 Execution log 下展示该次运行的 cwd，并以默认折叠的 **Process environment** 列出进程环境变量；托管包 revision 则独立显示为 **Managed package environment**。历史执行没有 `envSnapshot` 时，页面明确标记为未记录而不会报错。

运行产生的每个文件追加 `ArtifactDerivation`（`.sciencediscovery-data/artifact-derivations/`）：路径、内容 CAS 引用、`executionRunIds`。这条审计链不等于用户可见产物目录：普通执行 diff 不自动建 `ScientificArtifactVersion`；只有用户上传、MCP 下载、远程任务拉回输出，或主/子 Agent 调用 `declare_artifact` 后，控制面才创建或追加 Project 级产物版本。

产物目录以 `(projectId, name)` 识别跨 Session 的版本链，保留稳定 `artifact_id`，并记录 `origin`（`user_upload` / `mcp_download` / `llm_declared` / `legacy_auto`）与创建 Session 快照。删除 Session 可清理物理工作区，但保留 Artifact、Version 与 CAS；溯源接口会把来源 Session 已删除作为可解释状态返回。

**文本产物 diff**：`artifactVersionDiff`（`artifacts/index.ts`）按需从 CAS 读取两个版本即时计算（公共前后缀 + added/removed/context 行，单版本上限 5000 行），不落盘；仅限文本类 mediaType。

## 3. Prompt Manifest

每个模型轮次一条（`prompt-manifest.ts`，存 `.sciencediscovery-data/prompt-manifests/`）：模型与 endpoint host、系统提示/输入消息/响应的 CAS 引用、`skillRefs`（技能 ID、内容哈希、version、revision）、可选 specialist、token 用量与成本、运行时设置快照、`redactionStatus: "not-applied" | "not-required"`（无自动密钥脱敏）。

`.sciencediscovery-data/model-usage/` 中的 `ModelInvocationUsage` 只存 token/成本/时间与 manifest 引用，**不存原文**；当前调用主要区分 `task` 与 `paper-vision`，历史记录中的旧调用类型仍可读取。

## 4. Reviewer Specialist

`reviewer-specialist/` 提供面向 Artifact 的显式审核。Reviewer 关闭时不会运行；启用后由 **Run review**、明确的对话请求或 `review_checkpoint` 触发，并以独立 checkpoint 执行，不参与普通主 Agent 响应的成功/失败判定。

Quick 档位包含：

- Citation：识别 Markdown 引用标记、参考文献条目和明显的缺失或占位符；
- Computation：按 Artifact 版本调用图谱溯源接口，检查 provenance 与 `[ev]` Evidence 链路；
- 将标准化 `ArtifactReviewRun` / finding 持久化、展示在 Reviewer Specialist 卡片，并将摘要注入后续主 Agent 上下文。

审核结果是只读反馈，不自动修改 Artifact，也不强制主 Agent 二次运行。Smart 与 Deep 档位沿用同一 checkpoint、finding 和上下文注入契约扩展。

## 5. Claims 与 Evidence

- **Claim**（`.sciencediscovery-data/claims/`）：从助手回复中按句提取的带结构化引用（`[TYPE:ID]`）的断言，关联 `reviewRunId` 与 `turnId`。
- **EvidenceItem**（`.sciencediscovery-data/evidence-items/`）：去重后的证据实体，`origin` 为判别联合：`mcp-record`（数据库/文献记录）、`paper`（PDF 定位：页码/引文哈希）、`execution`（运行输出）、`artifact`（生成文件版本）、`remote-job`、`user-input`。
- **EvidenceLink**（`.sciencediscovery-data/evidence-links/`）：claim ↔ evidence 关联，relation 为 `supports` / `context` / `contradicts`。
- **contentScope**：MCP 记录区分 `curated-record`（结构化全量）/ `abstract` / `metadata`；`fullTextRetrieved` 仅在 `paper_extract_pdf` 成功后为 true——只有此时才能声称读过全文。

## 相关文档

- [control-plane.md](control-plane.md) — 运行编排中评审的触发位置
- [science-connectors.md](science-connectors.md) — MCP 调用审计与引用身份
- [运行时行为参考](../reference/runtime-behavior.md) — 用户视角的评审行为与准则管理
