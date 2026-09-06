# Project 与 Session 的 Runner 继承

Project 提供 Session 的默认设置，不是 Session 可选机器的权限上限。

## 三层职责

- **系统设置**维护全局机器目录、连接方式、凭据和可用状态。
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

## 回归入口

- services/api/src/store.test.ts：独立选机、默认值变化、清空与恢复继承、未知/不可用机器校验及重载。
- services/api/src/remote-runner.test.ts：Project 默认为空时主/子 Agent 工作区操作仍按 Session 选择授权。
- test/journey-ssh-remote-runner.spec.ts：Session 可选择 Project 未选的机器，最终保存位于远程设置与工作区之后。
