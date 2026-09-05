# 内容寻址存储（CAS）

ScienceDiscovery 通过 `@sciencediscovery/cas` 包保存不可变的审计与产物内容。业务模块调用统一 API，不各自实现存储布局；引用统一使用 `CasObjectRef { hash, size }`。

## 地址与布局

`CasStore` 对原始字节计算 SHA-256。64 位小写十六进制摘要同时是对象身份与地址：

```text
<data-dir>/versioning/data/blobs/sha256/<完整摘要>
<data-dir>/versioning/agent-state/blobs/sha256/<完整摘要>
```

两池均采用 OCI image layout（oci-layout、index.json、blobs/sha256）。只有本地沙箱工作区文件字节进入 Data Pool；stdin/stdout/stderr、读取观察、Prompt、响应、tree 元数据和状态记录进入 Agent State Pool。CasStore 默认写 State Pool，工作区文件写入方显式选择 data。旧裸 hash 接口兼容读取两池和原 cas/sha256/<前两位>/<hash>，旧对象无需移动。新 DataRef/AgentStateRef 接口在类型和运行时均校验所属池。

包提供 hash、sha256File、put/putFile、has、read 和 verify。新对象写临时文件并 fsync，以不覆盖的原子 hard link 发布，再同步目录；已有对象必须校验，不静默覆盖损坏内容。putFile 流式读取；read 校验 hash，typed read 额外校验 size 和 pool。

## CAS 与工作区变更检测

Runner/API 的 UI 变化投影仍比较 size:mtimeMs；版本化 WorkspaceTree 不信任该缓存，在写入者完成后全量 hash。Linux 文件名和 symlink target 按原始字节 base64url 保存，名称按字节排序、大小写敏感、不做 Unicode 规范化；保存执行位和空目录，mtime/uid/gid/xattr 不进入身份。拒绝 FIFO/socket/设备文件，不跟随符号链接。采集期间检测到变化会失败；未受控后台写入不属于 barrier 保证范围。

- 工作区快照负责路径级变化、执行审计和 UI 事件。
- CAS 负责不可变字节与内容去重。
- 产物目录决定哪些归档值成为用户可见 Artifact。

因此只改时间戳可能产生新的 derivation、但复用已有 CAS 对象；反过来，CAS 中存在的未声明执行输出不会自动成为用户可见产物。

## 写入方与消费方

| 写入方 | 内容 |
|---|---|
| `ProvenanceRecorder` | 代码、stdout、stderr、环境快照和文件 derivation |
| 产物注册 | 上传、下载或显式声明的产物内容与版本 |
| Prompt Manifest | 模型输入、系统提示、响应和错误文本 |
| MCP / Web 治理 broker | 请求、原始响应和规范化结果快照 |
| Paper 服务 | PDF、视觉输入、请求、响应和 manifest |
| API 环境镜像 | 从 Runner 复制的环境快照 |

完整性检查与 Reviewer 使用 `verify`；产物内容、diff、预览、看板和候选解析使用 `read`。记录只保存 `CasObjectRef`，不重复保存内容。Runner 环境存储有独立的 revision 生命周期，虽也使用 SHA-256 校验，但不是 `CasStore` 消费方。

## 生命周期与恢复

VersionStore.putRecord 使用 RFC 8785 JCS、schemaVersion 和强引用依赖计算内容身份，validateClosure 检查全部可达字节。未知 schemaVersion 拒绝读取，不做隐式原地升级。

生产 createAgentRun 创建行为 AgentManifest、血缘 AgentRevision 和初始状态；每个模型 turn 通过可等待 Runtime lifecycle 顺序提交 before state、实际 context/model input、整批工具结果、after state、actions/eventSegments、TrajectoryStep。State 将完整运行 transcript 与压缩后的模型 history 分开，另保存原始观察、工具可见性/loop 状态，以及计划、Artifact、权限、环境和子 Agent 权威记录。DurableContextStore 仅作为上下文投影。ModelContextSnapshot 的精确边界为 ProviderModelClient.invoke 输入，不保存 HTTP 认证。

versioning/refs.sqlite 使用 WAL/FULL 保存 live refs 和只追加的 history refs。StepCommitCoordinator 校验类型、归属和闭包后，在比较交换事务中更新 head 与 history；失败传播给 run。崩溃后 head 只能是旧完整值或新完整值。开发者可用 readRecord、roots、validateClosure 检查，不新增 Web 接口。版本存储必须位于 Agent 工作区之外。

持久 kernel 堆、远端副作用、Memory Graph 不做快照，显式标注仅引用或不可回退。deferred 提升只改变 State/Context，不改变 Manifest。当前不实现 Fork、跨实例恢复、GC、OCI 导入/导出、Evaluation 或版本浏览器。

CAS 只追加，没有修改、删除、清理或列举接口。删除 Session 可以删除物理工作区与执行记录，但保留的 Project Artifact 仍从 CAS 解析；删除 Project 可能留下无引用对象。

垃圾回收尚未实现。未来收集器必须先标记 Artifact 版本、derivation、执行与 Prompt Manifest、MCP/Web 审计、Paper 记录和环境镜像中的全部活引用，再清除未标记对象；不能只按年龄删除，因为长期 Project Artifact 可能比来源 Session 工作区存活更久。

中断写入可能留下 `.tmp`，但不会留下半截正式对象。仅在没有写入方运行时才可清理过期临时文件。`verify` 失败表示内容与地址不符，应报告损坏，不应原地覆盖不可变地址。
