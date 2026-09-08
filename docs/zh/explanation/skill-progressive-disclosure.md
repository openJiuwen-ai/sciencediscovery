# 技能渐进式披露

本文说明 Agent Skills 在一轮运行中如何被模型发现、读取和审计。本次运行已选的技能会以**完整技能包**在沙箱启动前放入固定目录；系统提示依旧保持轻量，只携带 metadata 和路径，而不是正文。

## 设计目标

- **系统提示保持轻量**：leader prompt 只列出本次运行已选技能的名称、描述、version、revision、包路径和包 hash，不直接注入完整 `SKILL.md`。
- **启动即就位**：模型 loop 开始之前，每个已选技能的完整包已经写入固定沙箱路径，Agent 不需要再调用挂载、提取或落地类工具。
- **冻结运行快照**：运行开始时，Node API 已固定所选技能的 revision、包 hash、instructions 和资源清单。放入沙箱的字节来自这份快照，而不是磁盘上可能已经变化的文件。
- **目录与内容读取分离**：系统 Prompt 只给出位置，正文由普通文件工具和执行工具按需读取。
- **默认只读，预留可写扩展**：默认技能包目录对 Agent 只读；另有一个独立的可写目录，供后续自演进使用。

## 运行流程

```text
Session 生效设置选择技能
        │
        ▼
API resolve 技能 revision，生成 frozen snapshot
        │
        ▼
prepareSkillSandbox 把完整技能包写入本次执行的 snapshot 根目录
        │
        ▼
沙箱启动时这些包已经挂好
        ├─ $SCIENCEDISCOVERY_SKILLS_DIR            只读（bubblewrap 下为 /skills）
        │     └─ <skillId>/SKILL.md、scripts/、references/、assets/…
        └─ $SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR  可写（bubblewrap 下为 /skill-extensions）
        │
        ▼
system prompt 逐个列出 <package_path> 与 <package_hash>
        │
        ▼
用 read_file 读取 $SCIENCEDISCOVERY_SKILLS_DIR/<skillId>/SKILL.md（read_skill 作为兼容通道保留）
        ├─ 按 instructions 引用，从同一包路径读取 supporting text
        └─ 直接在包路径上用显式 argv 执行捆绑脚本
```

## 目录约定

| 路径 | 权限 | 用途 |
|------|------|------|
| `$SCIENCEDISCOVERY_SKILLS_DIR/<skillId>` | 只读 | 一个已选技能的完整冻结包，含 `SKILL.md`、`scripts/`、`references/` 和其它资源 |
| `$SCIENCEDISCOVERY_SKILLS_DIR/.sciencediscovery-snapshot.json` | 只读 | 清单文件，记录每个已放入技能的 id、revision、version 和包 hash |
| `$SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR` | 可写 | 为后续自演进预留的扩展目录；默认为空，且不属于冻结树 |

引用技能包时一律走 `$SCIENCEDISCOVERY_SKILLS_DIR`，这也是 Prompt 在 `<package_path>` 中给出的形式。它展开后的值与平台有关：bubblewrap 下是 bind 路径 `/skills`；macOS Seatbelt 没有 mount namespace，变量里是宿主快照目录的真实路径。因此写死 `/skills` 在 Linux 上能跑，在 macOS 上会失败。

两侧都认这种写法。Shell 和 Python 正常展开；Node 侧的工作区工具（`read_file`、`list_files` 以及 `run_shell` 的 `scriptPath`）把 `$SCIENCEDISCOVERY_SKILLS_DIR/...`、`${SCIENCEDISCOVERY_SKILLS_DIR}/...` 和裸 bind 路径当作同一个文件的别名；`run_shell` 还会把脚本路径重新用变量拼回命令，使生成的命令在两种沙箱下都能直接运行。

## 工具职责

| 工具 | 执行位置 | 职责 |
|------|----------|------|
| `read_file` | Node 工作区工具 | 像读工作区文件一样，分页读取技能包根目录下任意已放入的包文件 |
| `run_shell` | Runner 沙箱 | 直接在包路径上用显式 argv 执行捆绑脚本，不复制、不改写 |
| `read_skill` | Node 工作区工具 | 兼容通道，返回同一份冻结 instructions 以及包路径 |
| `read_skill_resource` | Node 工作区工具 | 按 path 读取有界 UTF-8 supporting resource；不执行脚本、不安装依赖 |

放入沙箱由 `services/api` 的 `prepareSkillSandbox` 完成，挂载由 `services/runner` 施加，工具仍由 `packages/workspace` 的 `createWorkspaceTools` 产出。

## 为什么用冻结副本，而不是直接给目录中的实时路径

如果把技能目录里的实时 `SKILL.md` 路径交给模型，运行中的一次磁盘编辑就会改变模型读到的内容，破坏 Prompt Manifest 中已记录的 revision 与包 hash。

放入冻结副本同时满足两侧要求：模型拿到的是一个普通文件路径，而路径背后的字节是每次执行只复制一次的冻结 revision，并在沙箱启动前先与记录的包 hash 校验。

## 安全边界

- 注入系统提示的技能条目只含 metadata 和路径，不含完整 `content`。
- 只有本次运行已选的技能会被放入；未选中的技能不会出现在技能包根目录下。
- 默认包目录只读：沙箱内对技能包根目录的写入和删除都会失败，宿主侧文件权限为 `0444`。
- **放入技能包不等于安装或执行**。仅仅选择技能不会自动执行 `scripts/`，也不会自动安装依赖；执行必须由 Agent 显式发起 argv 调用。
- 大文件或二进制包字节直接从冻结 snapshot 进入磁盘，不进入模型上下文。不要把捆绑大脚本重新读回上下文，也不要为寻找包资源而全盘搜索文件系统——Prompt 中已经给出路径。
- 所有 skill revision、version、package hash 会进入 Prompt Manifest 和快照清单文件，便于审计与按精确包复现。

## 相关入口

- [agent-backend.md](agent-backend.md) — Node 原生 loop 的模块结构与工具调度
- [builtin-tools.md](../reference/builtin-tools.md) — 模型可见工具清单
- [运行时行为参考](../reference/runtime-behavior.md) — 用户侧技能管理说明
