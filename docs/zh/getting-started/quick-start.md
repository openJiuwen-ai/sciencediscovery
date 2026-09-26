# 快速开始

这条路径只做一件事：让你尽快完成第一次可检查的 ScienceDiscovery 任务。

完成后，你应该能够：

- 打开 ScienceDiscovery；
- 配置一个可用的任务模型；
- 让 Agent 实际运行一次 Python 计算；
- 在工作区看到它交付的 Markdown 产物。

## 1. 按你的系统启动 ScienceDiscovery

### Linux：使用预编译版本

如果你使用 Linux x86_64 或 aarch64，这是最短路径。

你需要：

- 一个可用的模型 API Key；
- Bubblewrap，用于隔离代码执行。

先安装 Bubblewrap：

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# 或：sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

然后从 [Releases 页面](https://github.com/openJiuwen-ai/sciencediscovery/releases)下载与你的架构匹配的 ScienceDiscovery 可执行文件，并将它重命名为 `ScienceDiscovery`。

在文件所在目录执行：

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

### macOS：使用本地源码模式

macOS x64 和 arm64 均受支持。当前 macOS 没有预编译单文件版本，使用本地源码模式即可；沙箱使用系统自带的 Seatbelt，不需要安装 Bubblewrap。

先确认本机已有：

- Node.js 22.19+；
- pnpm 11.1.2；
- Python 3；
- uv 0.9+；
- Git；
- curl；
- 一个可用的模型 API Key。

然后执行：

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
git checkout feat/jiuwenswarm

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

第一次执行会安装和构建所需组件，因此需要联网，耗时也会比后续启动更长。

如果你已经完成过构建，之后可以用：

```bash
./scripts/start-stack.sh --mode local --no-build
```

### 启动成功后

无论使用 Linux 还是 macOS，启动完成后终端都会打印一个 `Open to sign in` 链接。用浏览器打开它即可进入 ScienceDiscovery。

先不要关掉启动终端；关闭它或按 Ctrl-C 会停止服务。

如果没有看到登录链接、浏览器无法进入界面，或启动过程报错，请查看[首次启动排障](deployment.md#二进制与本地模式的首次启动排障)。

> Docker、离线环境、Linux 源码构建以及更完整的部署说明见[部署指南](deployment.md)。

## 2. 配置模型

打开 **系统设置 → 模型注册表**：

1. 选择一个预置服务商，或手动添加服务商；
2. 填写模型服务信息和 API Key；
3. 点击**保存并连接**；
4. 确认连通性测试通过，并选择一个**全局默认任务模型**。

这里填写的是模型服务商的 API Key。若连接失败，优先检查 API Key、服务商 URL、模型 ID 和网络连接。

## 3. 完成第一次科研任务

新建一个 Project 和 Session，把下面的任务完整粘贴到消息框：

```text
请完成一个最小的数据分析任务，并把结果交付为可查看的科研产物。

数据如下：
temperature_c,yield_g
20,41
22,45
24,49
26,52
28,54
30,53
32,49
34,43

要求：
1. 将数据保存为 temperature_yield.csv。
2. 必须使用 Python 实际运行计算，不要只在回复中估算。
3. 计算平均产率、最高产率对应的温度，以及 temperature_c 与 yield_g 的 Pearson 相关系数。
4. 简要解释结果，并指出仅凭这组小样本不能得出因果结论。
5. 将完整分析写入 Markdown 文件 first-analysis.md，并把它登记为产物。
6. 最终回复中明确告诉我产物文件名。
```

如果首次代码执行出现权限确认，核对动作后批准，然后让任务继续完成。

这个任务的目的不是得到一个复杂的科研结论，而是确认 ScienceDiscovery 已经完成了一个最小闭环：**理解任务 → 运行工具 → 产生文件 → 交付产物**。

## 4. 确认你已经跑通

满足下面四项，就说明第一次使用成功：

- [ ] Session 中的任务已经结束，不再显示为运行中；
- [ ] 时间线中可以看到实际的代码执行记录；
- [ ] 工作区中可以看到 `first-analysis.md`；
- [ ] 打开产物后，可以看到基于实际计算得到的数值和简短解释。

不同模型生成的文字可能不同，这是正常的；这里关心的是工具是否实际执行、产物是否真实生成。

## 5. 接下来做什么

- 想了解 ScienceDiscovery 能做什么：看[核心能力](../README.md#核心能力)。
- 想照着真实科研案例做一遍：看[领域指南](../README.md#领域指南)。
- 想跑一个具体的优化案例：看[使用PUCT优化一个文本压缩算法](../domains/evolve-a-solution.md)。
- 想使用 Docker、源码构建或解决启动问题：看[部署指南](deployment.md)。
