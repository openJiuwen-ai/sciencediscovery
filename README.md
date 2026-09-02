# CodeArts Resources

`ci/codearts-resources` 是 CodeArts 构建资源的独立维护分支，用于预取、校验并上传稳定的大文件资源。该分支不包含 ScienceDiscovery 业务代码，也不应合入 `main`。

向本分支推送提交后，`.codearts/workflow/codearts-resources-pipeline.yml` 会先并行准备工具链资源和 QEMU Ubuntu 云镜像，再基于这些固定输入构建预制 QEMU Runner 镜像。每个下载对象都必须通过固定 SHA256 校验，之后才由 CodeArts 上传到 OBS。

预制 Runner 镜像包含 `bubblewrap`、Node.js 22.19.0、pnpm 11.1.2、uv 0.9.26 及运行所需的基础系统工具。正式 CI 使用该镜像后不再在每次启动时执行 apt 更新或安装这些稳定工具；仓库源码、`pnpm-lock.yaml` 对应依赖、构建产物和测试结果仍按提交生成，不固化到基础镜像中。

## 文件

- `.codearts/workflow/codearts-resources-pipeline.yml`：push 触发、并行任务和 OBS 上传步骤。
- `.ci/prepare-codearts-resources.sh`：声明资源文件名、源站 URL 与 SHA256，并准备上传目录。
- `.ci/fetch-verified-binary.sh`：实现“本地文件 → OBS → 源站”的校验下载机制。
- `.ci/fetch-qemu-image.sh`：固定 QEMU Ubuntu 云镜像版本及其 SHA256。
- `.ci/build-qemu-runner-image.sh`：通过 QEMU TCG 启动基础镜像并生成预制 Runner 镜像。
- `.ci/provision-qemu-runner-image.sh`：只在镜像构建阶段进入 guest 安装并校验稳定工具。

## OBS 对象结构

```text
obs://openjiuwen-ci/
└── sciencediscovery/cache/
    ├── toolchains/v1/<immutable-filename>
    ├── qemu/v1/noble-server-cloudimg-amd64.img
    └── qemu-runner/v1/<resource-commit>/<pipeline-run>/
        ├── ScienceDiscovery-qemu-runner-noble-amd64.qcow2
        ├── SHA256SUMS
        └── VERSION
```

公网读取地址分别为：

- `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/toolchains/v1/`
- `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/qemu/v1/`
- `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/qemu-runner/v1/<resource-commit>/<pipeline-run>/`

## 发布预制 Runner 镜像

预制镜像采用“候选构建、固定校验和、再显式引用”的两阶段流程：

1. 推送本分支，资源流水线生成以资源分支 commit 和 pipeline run 隔离的候选镜像，同时上传 `SHA256SUMS` 与 `VERSION`。
2. 校验流水线日志和 `SHA256SUMS`，确认镜像中的版本探测及 bubblewrap sandbox 自检均通过。
3. 在正式流水线中显式固定候选镜像的公网 URL 和 SHA256。不要使用 `latest`，也不要覆盖已经被引用的对象。

这种结构保证正式流水线只下载一个不可变、可校验的 Runner 镜像；资源分支再次构建不会静默改变既有 CI 环境。

流水线在上传前检查三个本地产物，上传后再从公网下载并核验完整镜像、`SHA256SUMS` 和 `VERSION`。只有最终日志出现 `Verified published QEMU Runner image` 才代表候选镜像真正可供正式流水线引用；不要只依赖 CodeArts job 的绿色状态。

## 更新资源

新增或升级资源时，应同时更新资源文件名、权威源站 URL、SHA256 和流水线中的 OBS key / 上传文件路径。对象名必须体现不可变版本；不要用不同内容覆盖已有 key。提交并推送本分支后，使用流水线日志确认校验和上传结果。
