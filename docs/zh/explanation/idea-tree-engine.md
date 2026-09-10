# Idea Tree 自主研究引擎

Idea Tree 在现有 evolve Python 服务内运行，使用一个 ASGI worker。API 负责会话鉴权、模型代理和用量记录；Python 负责研究循环；Web 原有树面板负责启动、观察和控制。聊天 Agent 不执行树工作流，不创建执行计划，也不派发 Subagent。

## 使用

在工作区 Idea Tree 展示区域内配置默认预算及角色提示词，然后在会话输入框使用 `/idea-tree <研究任务>` 或 `/idea-tree-team <研究任务>` 启动。前端不提供独立的目标、文本材料或文件读取表单；objective/materials 保留为后端创建研究的输入。检索与解析必须在启动前完成；引擎没有外部检索、代码执行或工具能力。运行状态、暂停/继续/结束和节点详情直接显示在工作区树面板内，不另开弹窗。

一轮是“一批候选 + 逐个设计/评估 + 反馈”。默认最多 3 轮、每轮最多 3 个候选；另外受候选总数、节点总数和深度上限限制。最大深度是上限，浅层候选可以评估。下一轮依据已有洞察探索新方向或改善旧候选；到达深度上限时可以创建同级改进版本。

在树展示区域中可替换设计、三个评估、聚合和传播角色的提示词，修改对新研究生效。默认评分维度保留活性、稳定性、可持续性，Python 按权重计算分数。构思提示词由后端管理，没有新增编辑入口。

暂停不取消已发送到模型的请求：面板先显示“正在暂停”，在途响应退出后变为“已暂停”。在途调用仍可能产生用量，但不会触发下一阶段。继续由用户明确点击；进程重启后研究显示“已中断”，不会自动唤醒。结束需确认，已有结果保留，不能继续。

## 代码与状态

- `vendor/idea_tree/research.py`：构思、设计、独立评估、聚合、逐层传播；保存每个已完成阶段，恢复时只执行尚未完成的阶段。
- `vendor/idea_tree/research_tree.py`：复用根目录 `tree.py` 的节点/祖先查询。
- `vendor/idea_tree/prompts.py`：角色指令与评分标准。
- `vendor/idea_tree/research_service.py`：创建、查询、暂停、继续、结束；进程内保证每个会话只运行一项研究。
- `services/api/src/idea-tree/research.ts`：研究 HTTP 客户端和临时模型代理凭证。
- `apps/web/src/IdeaResearchPanel.tsx`：已有树面板中的研究控制。

唯一持久状态位于 Python 服务的 `$SCIENCE_AGENT_DATA_DIR/idea-research/<projectId>/<sessionId>/<researchId>.json`，原子替换保存。文件包含材料、预算、节点、阶段结果和用量，不含模型密钥。新路径不使用外部 revision、租约、childDigest、SHA 校验或结果句柄。旧树继续通过旧读取接口查看，写操作返回只读错误；不自动迁移旧执行状态。

公共入口为 `POST /api/sessions/:sessionId/idea-tree/research`，`operation` 支持 create/get/list/pause/continue/end/defaults。GET 同一路径列出研究。直接向聊天消息 API 发送 Idea Tree 命令会得到引导到研究入口的 409，不会悄悄启动 Lead。

## 边界

当前使用会话的 OpenAI-compatible 模型，实际请求经 API 的既有模型代理。API 或模型不可用时保存为中断，恢复依赖这些服务重新可用。模型输出只允许 JSON，每次格式错误最多纠正一次；网络超时不自动重发。模型请求沿用代理的约 20 分钟上限。

可选 token 总预算依靠提供方返回的用量，发起请求前以 UTF-8 字节数保守预留输入和输出预算，因此可能提前暂停；它不是计费系统的精确额度限制。提供方不报告用量时显示未知，配置总预算的研究会中断。材料与各阶段输出有长度限制，构思只携带方向摘要、近期及较优候选，不重放聊天历史。

研究评分和材料建议都是模型评估；没有实验或提供的证据时，不应把它们视为实测结论。
