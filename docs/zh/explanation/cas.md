# 内容寻址存储（CAS）

ScienceDiscovery 通过 `@sciencediscovery/cas` 包保存不可变的审计与产物内容。业务模块调用统一 API，不各自实现存储布局；引用统一使用 `CasObjectRef { hash, size }`。

## 地址与布局

`CasStore` 对原始字节计算 SHA-256。64 位小写十六进制摘要同时是对象身份与地址：

```text
<data-dir>/cas/sha256/<摘要前两位>/<完整摘要>
```

算法目录为将来的地址格式留出空间，两位扇出避免单目录过大。解析路径前会校验摘要，调用方输入不能逃逸 CAS 根目录。

包提供内存内容哈希、流式文件哈希、`put` / `putFile`、`has`、`read` 和 `verify`。写入会复用已有地址；新对象先写临时文件，再在同一文件系统原子重命名，调用方看不到半成品。`putFile` 流式读取源文件。完整性敏感的消费者必须调用 `verify`，因为普通去重路径只检查对象存在，不会每次重读。

## CAS 与工作区变更检测

CAS 不监听工作区路径，也不判断文件是否改变。Runner 与 API 在执行前后比较 `size:mtimeMs` 指纹，生成 `createdFiles` 和 `modifiedFiles`；溯源模块再读取这些路径并把字节写入 CAS。

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

CAS 只追加，没有修改、删除、清理或列举接口。删除 Session 可以删除物理工作区与执行记录，但保留的 Project Artifact 仍从 CAS 解析；删除 Project 可能留下无引用对象。

垃圾回收尚未实现。未来收集器必须先标记 Artifact 版本、derivation、执行与 Prompt Manifest、MCP/Web 审计、Paper 记录和环境镜像中的全部活引用，再清除未标记对象；不能只按年龄删除，因为长期 Project Artifact 可能比来源 Session 工作区存活更久。

中断写入可能留下 `.tmp`，但不会留下半截正式对象。仅在没有写入方运行时才可清理过期临时文件。`verify` 失败表示内容与地址不符，应报告损坏，不应原地覆盖不可变地址。
