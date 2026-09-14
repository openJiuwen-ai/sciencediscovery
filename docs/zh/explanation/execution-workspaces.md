# Shell、环境与 Workspace

一次执行选择 Runner 和环境 ID：Runner 提供沙箱，环境提供 Python、R 等工具。环境不是机器，Workspace 也不是环境。

| 对象 | 身份与生命周期 |
|---|---|
| Runner | 本地、SSH 隧道或直连的受管执行端；命令必须经过 Runner 沙箱 |
| Workspace | Agent 实例 × Runner 对应的持久目录；Session 主 Agent 和每个子 Agent 各有独立根目录 |
| Environment | Runner 内按 ID 选择的最新版受管前缀，可同时安装 Python、R |
| Revision | 包状态与来源的追溯记录，不是可选择执行的历史环境副本 |
| Execution | 独立于模型回合的持久命令记录 |
| Transfer | 从已提交源快照到目标 Workspace 的显式文件映射 |

## 执行与观察

统一使用 `run_shell`，通过 `command` 或 `scriptPath` 二选一传入命令，可选 `runner_id`、`environment_id`。例如 `python -m module`、`python analysis.py`、`Rscript analysis.R`。每次都从 Workspace 根目录启动新进程，`cd`、`export` 和解释器内存不跨调用保留；本期不提供 Notebook。

前台 `wait_ms` 是等待响应的预算，默认 10 秒、最多 30 秒，不是杀进程的超时。到期返回仍在运行的 Execution ID；`background: true` 在接受任务后立即返回。`execution_status`、`execution_logs`、`execution_cancel` 不另起 Shell、不取 Workspace 写锁。只有显式取消才停止作业，终态必须等进程清理和文件版本提交。

Session 文件面板的 **Executions & reminders** 展示执行、日志、复制和提醒。`unknown` 表示结果尚未确认，例如响应丢失或 API 重启，并不证明命令没运行；先检查，再决定是否主动重试。

## 文件归因

同一 Workspace 同时只允许一个写入者，Shell、编辑、上传、复制、删除与恢复共用边界。并行写入使用独立 Workspace。读取与复制使用已提交快照，不把后台命令的半成品作为输入。进程清理及 CAS/ref 提交后才返回成功回执；文件走 data 池，日志与 Agent 状态走 agent-state 池。迟到的 provenance 保留历史，但不得倒退文件最新版本指针。

`workspace_transfer` 可发现有权访问的 Workspace，显式启动、查询、列出和取消复制。记录源快照和逐文件结果；部分失败或取消保留已提交文件，传输字节数不等于发布成功。本地↔远端、主↔子交接使用同一机制，不自动镜像、不重放交接。仅本地所属 Workspace 中的文件可以声明 Artifact；远端产物必须先显式复制回本地，复制本身也不会自动声明 Artifact。

## 环境管理

用 `environment_create`、`environment_install`、`environment_uninstall` 管理依赖。创建时的语言只是初始工具；之后可用 conda 增加 Python 或 R，再在同一环境用 pip、CRAN/Bioconductor 安装包。更新在原前缀进行，不为每个 Revision clone 环境；执行按环境 ID 使用最新版并记录实际 Revision。历史重建不开放给 Agent。

沙箱把受管前缀只读挂载。Prompt 提示使用环境管理工具，不拦截或自动改写 Shell 包管理命令。长任务使用环境时与更新协调，避免执行途中看到半更新的依赖。

## 完成、提醒与停止

任务完成后，空闲的所属 Agent 开新回合，忙碌时通知留在持久队列。子 Agent 用原 ID、原上下文、原 Workspace 续跑，不把通知转给主 Agent。`timer_create` 的 `after_ms` 与带时区的 `at` 二选一；`timer_list`、`timer_cancel` 查询和取消一次性提醒。关联 `execution_id` 后，完成事件取消尚未触发的提醒。提醒只投递文本，不执行命令、不取 Workspace 写锁；不提供循环定时器。

Stop 关闭对应唤醒门；Session Stop 和 Archive 关闭整个 Session 门并取消待触发定时器。结果和通知保留。用户新请求恢复 Session，汇总主 Agent 未读通知但不重放命令；被单独停止的子 Agent 需要用户显式 Resume。恢复归档本身不重开自动化，旧定时器不会复活。
