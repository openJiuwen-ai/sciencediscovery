# Project 与 Session 的 Runner 继承

Project 提供 Session 的默认设置，不是 Session 可选机器的权限上限。

## 三层职责

- **系统设置**维护全局机器目录、连接方式、凭据和可用状态；“科学环境”页按 Runner 管理 Python/R 环境与远程 workspace。
- **Project 设置**选择默认远程 Runner。未覆盖的 Session 跟随这些默认值，包括后续修改。
- **Session 设置**可以继承 Project，也可以从全局可用机器目录独立选择。无需先在 Project 勾选同一台机器。

本地 Runner 始终可用。远程名单只是让机器成为候选，主 Agent 和子 Agent 的实际命令仍按本次选择的 Runner ID 执行；文件仍显式同步。

## 精确定义

| Session 的 remoteRunnerHostIds | 生效规则 |
|---|---|
| 未设置 | 动态继承 Project.remoteRunnerHostIds |
| 非空数组 | 完整替换默认值，不与 Project 取交集 |
| 空数组 [] | 显式不使用任何远程 Runner，不回退到 Project |
| 更新请求传 null | 清除覆盖，恢复动态继承 |
| 更新请求省略字段 | 保持现有选择 |

例如 Project 默认只有 A，Session 可以独立选 B 或 A+B。Project 之后移除 A，不影响已覆盖的 Session；只影响仍处于继承模式的 Session。Project 默认为空，也不妨碍 Session 独立选择 B。

## 校验与安全边界

独立选择并非跳过校验：主机必须在全局目录中已登记、具有当前支持的执行能力；未知或不可用机器不能新增到选择中。实际执行和提示目录仍只使用该 Session 的有效候选，并过滤当前不可用机器。不得再用 Project 名单做第二次交集或作为 Session 选项过滤条件。

已被 Project 或 Session 引用的全局机器不能直接删除，需先解除对应选择。保存密码、主机密钥信任、Runner 沙箱与工作区边界不因继承规则改变。

## 设置页的保存

Project/Session 运行设置的最终保存按钮位于全部设置区块之后。远程 Runner 的勾选与继承切换沿用即时保存，页面明确标注；模型、连接器、Skill 等草稿由底部保存按钮提交。即时保存项不会因关闭对话框回滚。

## 运行环境与工作区管理

每次为远程 Runner 建立连接、准备远端环境时（首次部署与之后的重连都算），控制面除了确保 Runner 自身的二进制就位，还会把固定版本的 micromamba 按 SHA-256 校验后放到该机器的 `<数据目录>/scientific-envs/bin/micromamba`。这是为隔离网络上的算力机器准备的：它们通常没有到发布站点的出口，而部署它们的控制面有。机器上已有同一固定版本时只读一次校验和，不传输；控制面自己也拿不到发布件时不阻断连接，Runner 会在自己的环境初始化状态里说明缺什么、以及可以用镜像（`SCIENCE_AGENT_MICROMAMBA_BASE_URL`）还是本机路径（`SCIENCE_AGENT_PROVISIONER_PATH`）解决。

远程机器的时钟与本安装不一致是内网常态（有些机器根本连不上 NTP 源）。Runner 校验执行签名时只接受与自身时钟相差 30 秒以内的时间戳，因此控制面在连接时就从 Runner 自己的应答里量出固定偏差，并在为该 Runner 签名时按它的时钟写时间戳；偏差超过 30 秒会在机器卡片上提示，提醒把机器的 NTP 配好——机器自身的日志和文件时间仍然是偏的。

反过来，**记录一律用本安装的时钟**：Runner 报回来的执行开始/结束时间在客户端边界就按同一偏差换算回本地时钟，既保留 Runner 实测的时长，又不会让某台机器的时钟把时间线搅乱。

系统设置 → 科学环境，先选择 Runner，再进入 Python/R 环境或 Workspaces。远端操作经主程序 API 转发到对应 Runner，SSH 仍只走隧道，自行部署仍走已配置端点；未连接不会回退到本地。包源偏好保持全局，远端环境及 revision 不合并到本地同名目录。

远端 workspace 按 Project/Session 展示本程序已知的位置及历史同步记录，包括已归档 Session 和取消选机后的历史使用。位置可能为空或尚未创建；这不是扫描远程机器全部磁盘目录。删除会清理所示 Session 在该 Runner 上的目录（含子 Agent 子目录），不清理本地文件、产物或历史记录；需确认，活跃运行期间拒绝。文件传输仍由模型显式发起。

Session 设置只保留执行选择与继承，不再放远端工作区清理控件。

## 回归入口

- services/api/src/store.test.ts：独立选机、默认值变化、清空与恢复继承、未知/不可用机器校验及重载。
- services/api/src/remote-runner.test.ts：Project 默认为空时主/子 Agent 工作区操作仍按 Session 选择授权。
- test/journey-ssh-remote-runner.spec.ts：Session 独立选机、底部保存、全局按 Runner 管理环境及工作区。
