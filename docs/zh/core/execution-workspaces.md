# Shell、环境与 Workspace

运行命令时，命令会在一个受管的运行端（Runner）中执行；所选的软件环境（Environment）提供 Python、R
等工具。运行中创建和保存的文件位于工作区（Workspace），工作区与软件环境不是同一对象。本文讲用户可见
的执行行为；Runner 内部与沙箱设计见[沙箱执行](../developer-docs/sandbox-execution.md)。

| 对象 | 身份与生命周期 |
|---|---|
| Runner | 已注册的本地、经 SSH 隧道或直接连接的受管执行端；命令始终经过 Runner 沙箱 |
| Workspace | 一个 Agent 实例在一个 Runner 上使用的持久文件夹；Session 主 Agent 和每个子 Agent 各有独立根目录 |
| Environment | 在 Runner 内按 ID 选择、解析为最新版本的受管环境，可同时安装 Python 和 R |
| Revision | 记录包状态与来源，不是可选择执行的历史环境副本 |
| Execution | 一条可持久保存、且独立于请求它的模型回合的命令记录 |
| Transfer | 显式发起的文件复制操作，将已提交源快照中的文件映射到目标 Workspace |

## 执行与观察

统一使用 `run_shell`，通过 `command` 或 `scriptPath` 二选一传入命令，可选 `runner_id`、`environment_id`。例如 `python -m module`、`python analysis.py`、`Rscript analysis.R`。每次都从 Workspace 根目录启动新进程，`cd`、`export` 和解释器内存不跨调用保留；本期不提供 Notebook。

前台 `wait_ms` 是等待响应的预算，默认 10 秒、最多 30 秒，不是杀进程的超时。到期返回仍在运行的 Execution ID；`background: true` 在接受任务后立即返回。`execution_status`、`execution_logs`、`execution_cancel` 不另起 Shell、不取 Workspace 写锁。只有显式取消才停止作业，终态必须等进程清理和文件版本提交。

Session 文件面板的 **Executions & reminders** 展示执行、日志、复制和提醒。`unknown` 表示最终结果尚未确认，例如响应丢失或 API 重启，并不证明命令没运行；先检查 Runner 状态，再决定是否主动重试。Runner 已接受命令后，API 查询状态时遇到短暂错误会继续用原 Execution ID 查询，不重新提交命令。连续 5 次可重试的状态查询失败也会使结果保持 `unknown`；中间查询成功则重新计数。

## 文件归因

同一 Workspace 同时只允许一个写入者，Shell、编辑、上传、复制、删除与恢复共用边界。并行写入使用独立 Workspace。读取与复制使用已提交快照，不把后台命令的半成品作为输入。命令完成清理并提交文件快照后才会报告成功。文件、日志和执行记录会分别保留，便于之后追溯；迟到的记录更新不会替换最新保存的文件。

`workspace_transfer` 可发现有权访问的 Workspace，显式启动、查询、列出和取消复制。记录源快照和逐文件结果；部分失败或取消保留已提交文件，传输字节数不等于发布成功。本地↔远端、主↔子交接使用同一机制，不自动镜像、不重放交接。仅本地所属 Workspace 中的文件可以声明 Artifact；远端产物必须先显式复制回本地，复制本身也不会自动声明 Artifact。

## 环境管理

用 `environment_create`、`environment_install`、`environment_uninstall` 管理依赖。创建时的语言只是初始工具；之后可用 conda 增加 Python 或 R，再在同一环境用 pip、CRAN/Bioconductor 安装包。更新在原前缀进行，不为每个 Revision clone 环境；执行按环境 ID 使用最新版并记录实际 Revision。历史重建不开放给 Agent。

沙箱把受管前缀只读挂载。Prompt 提示使用环境管理工具，不拦截或自动改写 Shell 包管理命令。长任务使用环境时与更新协调，避免执行途中看到半更新的依赖。

## 完成、提醒与停止

任务完成后，空闲的所属 Agent 开新回合，忙碌时通知留在持久队列。所属 Agent 已经通过工具调用读到的结果（前台 `run_shell` 等到了终态，或对已结束的执行调用 `execution_status` / `execution_logs`）会在那一刻标记为已读，不再开新回合；只有它没看过的结果（`background: true` 提交、等待用尽、提醒到期）才会唤醒它。子 Agent 用原 ID、原上下文、原 Workspace 续跑，不把通知转给主 Agent；唤醒回合也不会改写子 Agent 原任务的终态。`timer_create` 的 `after_ms` 与带时区的 `at` 二选一；`timer_list`、`timer_cancel` 查询和取消一次性提醒。关联 `execution_id` 后，完成事件取消尚未触发的提醒。提醒只投递文本，不执行命令、不取 Workspace 写锁；不提供循环定时器。

Stop 关闭对应唤醒门；Session Stop 和 Archive 关闭整个 Session 门并取消待触发定时器。结果和通知保留。用户新请求恢复 Session，汇总主 Agent 未读通知但不重放命令；被单独停止的子 Agent 需要用户显式 Resume。恢复归档本身不重开自动化，旧定时器不会复活。
