# 长任务失败后的恢复证据

#401 为当前 managed Runner 执行路径增加可选适配器契约。它不负责找回
unknown 原任务（#398），不回滚 Agent 历史，不恢复进程/NPU 内存，也不为任意
模型实现计算检查点。附带的 Python fixture 只证明 CPU 确定性接续能力，不代表
真实模型或 NPU 验收。

## 适配器契约

类型和运行时解析器位于
[`packages/schema/src/recovery.ts`](../../../packages/schema/src/recovery.ts)。
`run_shell` 可选参数 `recovery_metadata_path` 指定 workspace 内的 JSON sidecar。
Runner 向该 shell 提供 `SCIENCEDISCOVERY_EXECUTION_ID`；适配器必须把它写入
`executionId`，防止旧 sidecar 被当成新执行证据。

v1 字段包括适配器 ID/版本、工作单元及其完成/失败/部分/未知/未开始状态、失败原因、
产物清单和接续能力。产物必须声明相对路径、SHA-256、大小、result/checkpoint/diagnostic
角色、完整性状态，以及适配器的语义验证结果和 validatorId。框架另行核验字节完整性，
不会把“文件存在”当作已完成。

接续能力为 supported、unsupported 或 unknown。后两者必须给出原因且没有接续点。
受支持的点必须提供 entryPointId、resume/reuse_results 模式、准确命令的 SHA-256、cwd、
所需对象 ID、输入/配置/程序的固定文件哈希，以及不能自动验证的前置条件。
手工前置条件非空时阻止执行，不能由 LLM 声称“已验证”来绕过。

这些字段是数据而不是执行授权。框架不执行 sidecar 里的命令、URL、脚本、pickle 或
validator。适配器负责列全检查点分片和业务依赖；框架不替适配器推断缺失的语义。
上限：JSON 1 MiB、工作单元/对象各 1,000、接续点 100、每个对象/输入 64 MiB、
单次采集或准入检查总量 256 MiB。错误结构、未知版本、不安全路径或旧 executionId
只产生 unknown，不改变原进程结果。

## 持久化与查询

Runner 仅在原操作已 join 子进程、返回非零退出结果后，在 workspace lease 内采集。
unknown、取消、准入/传输异常、direct host 和 explicit handoff 均不能证明可恢复失败。
完整且经适配器验证的产物还必须是安全普通文件，大小和哈希一致；partial/invalid
只作为诊断信息，不作为可用检查点。

已验证字节冻结到 CAS，`ExecutionRecovery` manifest 显式引用它们，现有
`WorkspaceExecution` 引用 manifest 并一起提交到 workspace ref。只有提交后才发布
recovery 字段。发布失败不能暴露可用指针。API 随原执行保存元数据，重连后
`execution_status` 和 Session activity 仍可读取，读取绝不启动替代任务。
旧工具/旧记录兼容，缺失时明确为 unknown/NOT_REPORTED。supported 表示适配器能力，
不是当前条件全部满足。

对外引用使用 Runner storeId 和 objectId，不伪装成 API 本地 CAS digest。
新执行不覆盖原失败、workspace version 或 manifest。保留沿用现有 CAS 历史根，
本次不增加自动清理，也不保证用户删除后仍可恢复。

## 显式接续与边界

Agent 仍调用 `run_shell`，显式传 `recovery_context`：

```json
{
  "parentExecutionId": "原执行 ID",
  "recoveryPointId": "continue-units",
  "manifestDigest": "sha256:<64 位小写十六进制>",
  "attemptToken": "one-intentional-attempt"
}
```

准确命令和目录必须匹配接续点；仍经过当前 code 权限、网络同意、Runner allowlist、
NPU 选择和环境准入，不能继承原一次性授权。API 要求同 owner/Runner/workspace、
原 failed 且 provenance committed。owner/token 账本在提交前持久化新 executionId；
相同 token/请求返回同一子执行，unknown 也不会重发；同 token 改请求冲突。
有意再次尝试使用新 token。

Runner 真正出队时，在 workspace lease 内重新读取已发布的原 WorkspaceExecution 和
不可变 manifest，核对身份、非零退出证据、digest、完整 CAS 对象与当前路径字节、
输入/配置/程序哈希。环境 revision 在实际持有环境 runtime lease 时核验。任何变化、
缺失/损坏对象、部分结果、未验证条件都在启动进程前拒绝。子执行记录 lineage，
原失败不改写。

当前 main 的历史执行记录不能可靠地把每个中断任务绑定到 workspace，因此 Runner
只要存在未解决的 unknown 执行，受控接续就保守阻止，即使该未知任务可能无关。
不能猜测孤儿进程已经结束。找回状态、按准确 workspace 隔离重启后的未知执行属于
#398；本补丁不引入其对账代码，也不会自动清除 unknown。

首版不会从 CAS 自动恢复已改变/删除的文件、跨 Runner/workspace 迁移、豁免环境差异，
也没有新增专门 UI 面板。原路径必须仍匹配固定内容。workspace lease 无法约束带外宿主
写入，不宣称消除了任意恶意宿主上的 TOCTOU。

## 验证

[`recovery-fixture.py`](../../../services/runner/workloads/recovery-fixture.py)
完成前两个工作单元后原子写 checkpoint，制造失败和 partial 文件；接续只计算剩余
两个单元，结果与 clean run 一致。Runner 测试删除日志并重启后读取原 manifest；
API 测试覆盖持久化、远端 CAS 引用、身份隔离、重复意图及未知结果。
这些是 CPU 单元/集成检查，不等价于完整浏览器、Agent 或真实 NPU 验收。
详细字段、限制和开发测试命令见[英文版本](../../en/developer-docs/execution-recovery.md)。
