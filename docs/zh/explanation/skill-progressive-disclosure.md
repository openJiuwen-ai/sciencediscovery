# 技能渐进式披露

本文说明 Agent Skills 在一轮运行中如何被模型发现、读取和审计。整体遵循「先看目录，再按需读取」，并保留 ScienceDiscovery 的冻结快照语义。

## 设计目标

- **系统提示保持轻量**：leader prompt 只列出本次运行已选技能的名称、描述、version、revision 和资源数量，不直接注入完整 `SKILL.md`。
- **按需加载说明**：模型认为某个技能相关时，先调用 `describe_skill` 查看匹配结果和资源摘要，再调用 `read_skill` 读取完整说明。
- **冻结运行快照**：运行开始时，Node API 已固定所选技能的 revision、包 hash、instructions 和资源清单。模型后续读取的始终是这份快照，而不是磁盘上可能已经变化的文件。
- **目录检索与内容读取分离**：`describe_skill` 只按名称和描述检索目录并返回 metadata，完整内容由 `read_skill` 从冻结快照返回。

## 运行流程

```text
Session 生效设置选择技能
        │
        ▼
API resolve 技能 revision，生成 frozen snapshot
        │
        ├─ system prompt: 只写 name / description / version / revision
        │
        └─ 工具表: describe_skill / read_skill / read_skill_resource
        ▼
describe_skill(query)
        │  按名称和描述检索本次运行的技能目录
        ▼
模型选中 skillId
        │
        ▼
read_skill(skillId)
        │  返回本次 run 冻结的完整 instructions
        ▼
read_skill_resource(skillId, path)
           仅按 instructions 引用读取 supporting resource
```

## 工具职责

| 工具 | 执行位置 | 职责 |
|------|----------|------|
| `describe_skill` | Node 工作区工具 | 按名称和描述检索本次运行的技能目录，只返回 metadata、revision、hash 和资源摘要 |
| `read_skill` | Node 工作区工具 | 读取本次 run 的冻结 `SKILL.md` instructions，返回完整说明和 supporting resource 清单 |
| `read_skill_resource` | Node 工作区工具 | 在读取完整技能后，按 path 读取有界 UTF-8 supporting resource；不执行脚本、不安装依赖 |

三者都由 `packages/workspace` 的 `createWorkspaceTools` 产出，和其他工作区工具一样由 Node 原生 loop 在进程内直接调用。

## 为什么不用「给出文件路径、让模型自己读」

一种常见做法是把 `SKILL.md` 的磁盘路径告诉模型，让它用通用文件读取能力打开。

ScienceDiscovery 需要更强的可审计性：每次 run 开始时已经固定技能 revision 和包 hash，Prompt Manifest 也记录这份快照。若运行中再按文件路径读取磁盘内容，可能读到后续编辑过的版本，破坏「本轮运行看到的说明可复现」这个约束。

因此完整说明统一通过 typed tool `read_skill` 从 frozen snapshot 返回，而不是走通用文件读取。

## 安全边界

- 注入系统提示的技能条目只含 metadata，不含完整 `content`。
- `read_skill` 的 `skillId` 枚举限定为本次运行已选择的技能。
- `read_skill_resource` 的 `path` 限定为 frozen snapshot 中记录的文本资源。
- `scripts/` 目录仅作为技能包内容保存，运行时不会自动执行、安装或复制到 Python 工作区。
- 所有 skill revision、version、package hash 会进入 Prompt Manifest，便于审计和复现。

## 相关入口

- [agent-backend.md](agent-backend.md) — Node 原生 loop 的模块结构与工具调度
- [builtin-tools.md](../reference/builtin-tools.md) — 模型可见工具清单
- [运行时行为参考](../reference/runtime-behavior.md) — 用户侧技能管理说明
