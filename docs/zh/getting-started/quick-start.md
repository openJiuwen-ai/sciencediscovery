# 快速开始

本教程使用预编译 Linux 可执行文件，说明如何启动服务、配置模型并创建第一次 Agent 任务。
若你使用 macOS（本地源码模式）、需要 Docker，或想为 Linux 从源码构建二进制，请先按
[部署指南](deployment.md)启动服务，再回到[配置任务模型](#3-配置任务模型)。

> 系统定位与风险边界见 [README_zh.md](../../../README_zh.md)；部署的完整操作步骤见[部署指南](deployment.md)；参数和配额见[配置参考](../reference/configuration.md)。

## 1. 安装预编译二进制

最快的 Linux 路径需要：

- Linux x86_64 或 aarch64；
- bubblewrap；
- 与你的 Linux 架构匹配的 ScienceDiscovery 可执行文件，可在
  [Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载。下载后将文件重命名为
  `ScienceDiscovery`；
- 至少一个外部模型 API Key。

bubblewrap 需已安装在本机：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# 或：sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

默认情况下，首次执行 `serve` 还需要联网安装 gateway 依赖。离线环境的准备方式见
[首次启动安装的依赖](deployment.md#首次启动安装的依赖)。

使用其他操作系统或部署方式时，请改看[部署指南](deployment.md)。服务启动后，继续[配置任务模型](#3-配置任务模型)。

## 2. 启动 ScienceDiscovery

在终端中切换到 `ScienceDiscovery` 所在目录，再执行：

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

`serve` 会依次启动 gateway、runner 与 API/Web，并默认只监听本机。启动完成后，`serve` 会打印 `Open to sign in` 链接与本地服务访问令牌；在浏览器中打开该链接即可自动认证并保存本地服务访问令牌。（若直接打开 <http://127.0.0.1:4310>，界面会呈现清晰的连接引导，可复制启动日志中的「本地服务访问令牌」粘贴保存。）请勿分享该登录链接。Web UI 在持有的 token 被拒绝时会自动打开连接设置。Ctrl-C 会停止全部子服务。

另开终端检查 API 健康状态：

```bash
curl -fsS http://127.0.0.1:4310/health
```

正常启动时响应中的顶层 `status` 为 `ok`；如果 Runner 不可用，则为 `degraded`。字段说明见 [REST API 参考](../reference/rest-api.md#健康检查)。

二进制打包、源码模式和 Docker 是独立的部署路径，其前置条件与完整命令都在[部署指南](deployment.md)中。
二进制与本地模式遇到本地服务访问令牌被拒绝、健康状态为 `degraded`、Bubblewrap 或日志问题时，
参见其中的[首次启动排障](deployment.md#二进制与本地模式的首次启动排障)。

## 3. 配置任务模型

打开 **系统设置 → 模型注册表**。选择预置服务商或手动添加服务商，填写服务商信息和 API Key 后
点击**保存并连接**。该操作会登记服务商的模型并测试第一个模型的连通性；如果这是系统中的第一个
模型，它也会自动成为默认任务模型。已有模型时，请在模型注册表顶部的**全局默认任务模型**中选择。

此处配置的是外部模型 API Key，不是本地服务访问令牌。连通性测试失败时，请检查 API Key、
服务商 URL 或模型 ID，以及网络和代理设置后重试。支持的环境变量和文件配置见
[配置参考](../reference/configuration.md)。

## 4. 完成第一次 Agent 任务

1. 新建 Project 和 Session。
2. 输入一个具体的科研问题，例如“我计划研究温度对产率的影响。请说明需要收集的数据、两个
   质量检查点和第一步分析计划。”
3. 如需分析本地材料，可上传自己有权使用的 CSV 或 PDF，并在消息中说明分析目标。
4. 首次代码执行或外部数据访问出现权限卡片时，核对动作后批准。
5. 处理完所要求的批准后，助手回复结束且任务不再显示为运行中，才表示第一次任务已完成。未结束的
   流式回复或待处理的权限卡片都不表示任务已经完成。若它调用了工具，可在时间线检查结果；任务将
   生成的文件登记为产物时，可在工作区的**产物**区查看。

回复内容、工具调用和生成物取决于所配置的模型、启用的连接器以及提供的材料，不作为固定输出
承诺。

## 5. 下一步

- 部署和进程操作：[部署指南](deployment.md)
- 环境变量、端口、配额和存储路径：[配置参考](../reference/configuration.md)
- 日常运行时行为：[运行时行为参考](../reference/runtime-behavior.md)
- 工具参数：[内置工具参考](../reference/builtin-tools.md)
- 系统原理：[整体运行时架构](../developer-docs/architecture.md)
- 可选的端到端实践：[演进出一个更优解](../domains/evolve-a-solution.md)
- 跨数据库调研案例：[文献调研](../domains/literature-research.md)
