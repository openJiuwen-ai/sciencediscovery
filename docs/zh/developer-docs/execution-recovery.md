# 新 Runner 执行状态恢复

Issue #398 仅覆盖当前 `run_shell` → API `ShellExecutions` → 新 Runner `ExecutionManager` 链路，包括使用 NPU 的 shell 作业。不修改旧 Host NPU Broker，也不实现 #401 的 checkpoint 接续。

## 找回原执行

保存返回的 execution ID。`execution_status` 重新同步原任务，`execution_logs` 按游标继续读取已有日志。浏览器断开、等待超时和 API 观察失败，不等于取消任务，也不授权重新提交。

API 在发送前持久化执行上下文，不保存客户端对象、token 或代理凭据；支持新协议时，还会固定原 Runner 的持久账本身份。`dispatchPhase` 区分 prepared、dispatching、accepted。提交响应丢失后只查询原 ID，不会再发送执行请求。

原有连续五次观察重试保留。耗尽后保存错误和指数退避时间，后台继续恢复；API 启动及显式 Runner 重连也会唤醒同步。扫描全局单飞，每批最多四个查询、每轮最多 100 个候选；扫描期间的重连唤醒会合并到下一轮，不会丢失。

以下状态分别表达不同事实：

- `state`：控制面的执行状态；`unknown` 不是已确认失败。
- `observation`：观察新鲜度、最后 Runner 状态/时间、错误码、是否可重试、下次重试时间。
- `receipt`：持久 Runner 实例、接纳启动代次、请求摘要及单调递增 revision。
- `evidence`：进程是否确实终止、原因、结果和 workspace 摘要。
- `finalization` / `provenance`：已有结果和审计元数据是否提交完成。

401/403、找不到原 ID、Runner 实例变化、owner/摘要不匹配、进程状态不可确认，都会阻止自动恢复，不会触发 POST。手动状态检查或已授权的重连可以重新核查。远端读取前后都重新检查权限。

## 防重和结果归档

同 owner、turn、tool-call 的重试复用原 API execution ID。命令、目标或有效权限变化会冲突；仅 epoch 标识或时间更新不会新建运行。同 workspace 存在未确认的 unknown 任务时，新工作会被阻止，必须先核查原任务。

缺少原始恢复上下文（recoveryContext / 原 Runner 稳定身份）的旧 `unknown` 记录没有自动恢复路径：它仍可查看，但会持续阻断同一 workspace 的新工作。这种记录不会被自动清除、放弃或伪造完成——那可能悄悄丢失一条仍在远端运行的命令。正确的安全路径是：先用 `execution_status`/`execution_logs` 核查原任务。在**独立 workspace** 开展新工作仅当它与原未知任务完全无关时才安全——不得共享任何可变资源或外部副作用（如同一外部目标或远端资源）。换用不同 `workspaceId` **不是**普遍安全地重跑原任务或绕过该阻断的方式。此限制是防重复副作用的保留设计，不是缺陷。

Runner 对同一 execution ID 持久去重。同 owner、同规范化请求摘要返回已有回执（HTTP 200）；首次接纳返回 202。不同请求或 owner 一律返回不泄露身份信息的 409；其他 owner 查询得到 404。本实现不删除去重记录。

每个 Runner 数据目录使用 SQLite 提供的、进程退出后由操作系统释放的单写锁。第二个 Runner 不能接管活跃实例的账本。账本损坏、丢失或版本不兼容时，拒绝接纳新工作，不会清空重建后继续执行。

API 使用 SQLite 观察租约及目录 compare-and-set revision。首次归档前固定结果字节，避免后续时钟偏移换算改变幂等输入。独立 finalizer 不调用执行接口；执行审计、文件派生关系和 workspace revision 使用稳定键去重并拒绝冲突。环境快照按原 revision 校验后才写成功审计。远端 CAS 引用保持 Runner 命名空间。

只有已提交的真实终态产生完成通知。旧 `unknown` 通知保留为历史，恢复后的真实终态另发一次更正通知。未知状态不会消耗最终完成通知或取消提醒。

## 重启边界

- API 重启、观察网络断开：可以继续同步原运行中或已完成的任务，不再次执行命令。
- Runner 进程退出：没有实现独立 supervisor。缺乏权威完成证据的任务保持 `unknown`；原 workspace 和 NPU 设备继续隔离，同步执行接口同样受限。
- 已完成计算的 CAS 发布/目录提交中断：持久发布 journal 可以核验并修复原提交，不重算。证据或预期 head 不匹配则继续阻塞；不会无依据清除通用 workspace 变更栅栏。
- 缺少原始上下文或稳定身份的旧记录仍可查看，但不会自动补造审计或重放。
- prepared 阶段及 dispatch 标记与实际网络发送之间崩溃的 intent，不自动恢复首次提交。这是防止重复副作用而保留的可用性限制。
- 恢复不能改变 Runner、workspace、环境、设备或权限。新运行及 checkpoint 接续必须走独立显式流程。

## 验证范围

CPU 自动化测试覆盖丢 ACK、第五次失败后重连、API 重建、100 次并发查询、双 API 观察者、权限/身份/摘要负例、时钟换算、归档重试、Runner 并发提交、真实子进程崩溃隔离、账本损坏及 HTTP 合约。

以上不等于真实 NPU 验收。Ascend 验收还需在受控断网前后验证物理进程/设备作业仅启动一次、设备分配不变、结果摘要一致及日志连续。未实现、也不宣称 Runner 进程退出后的 supervisor 接管。
