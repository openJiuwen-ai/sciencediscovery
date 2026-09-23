# 01 快速开始

本教程使用预编译 Linux 可执行文件，说明如何启动服务、配置模型并创建第一次 Agent 任务。
若你使用 macOS、想从源码构建二进制，或需要 Docker，请先按[部署指南](deployment.md)启动服务，
再回到[配置任务模型](#3-配置任务模型)。

> 系统定位与风险边界见 [README_zh.md](../../../README_zh.md)；部署的完整操作步骤见[部署指南](deployment.md)；参数和配额见[配置参考](../reference/configuration.md)。

## 1. 安装预编译二进制

最快的 Linux 路径需要：

- Linux x86_64 或 aarch64；
- bubblewrap；
- 与你的 Linux 架构匹配的 ScienceDiscovery 可执行文件，可在
  [Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载；
- 至少一个外部模型 API Key。

bubblewrap 需已安装在本机：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# 或：sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

使用其他操作系统或部署方式时，请改看[部署指南](deployment.md)。服务启动后，继续[配置任务模型](#3-配置任务模型)。

## 2. 启动 ScienceDiscovery

以下命令假设 `ScienceDiscovery` 可执行文件位于当前目录：

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

在 **系统配置 → Global defaults** 中配置任务模型。每个配置包含显示名、base URL、模型 ID、可选的 **Vision capable** 标志与外部模型 API Key。此处配置外部模型服务商凭据，与本地服务访问令牌相互独立。提供方 API Key 以 AES-256-GCM 加密存储，API 不返回原始密钥。完整行为见[运行时行为参考](../reference/runtime-behavior.md#模型)。

## 4. 完成第一次 Agent 任务

1. 新建 Project 和 Session。
2. 输入一个具体的科研问题，例如“概括当前研究目标，并给出下一步分析计划”。
3. 如需分析本地材料，可上传自己有权使用的 CSV 或 PDF，并在消息中说明分析目标。
4. 首次代码执行或外部数据访问出现权限卡片时，核对动作后批准。
5. 在消息时间线检查工具调用和执行结果；如果任务生成文件，可在 Artifact 区查看。

回复内容、工具调用和生成物取决于所配置的模型、启用的连接器以及提供的材料，不作为固定输出承诺。

## 5. 下一步

- 部署和进程操作：[部署指南](deployment.md)
- 环境变量、端口、配额和存储路径：[配置参考](../reference/configuration.md)
- 日常运行时行为：[运行时行为参考](../reference/runtime-behavior.md)
- 工具参数：[内置工具参考](../reference/builtin-tools.md)
- 系统原理：[整体运行时架构](../developer-docs/architecture.md)
