# CodeArts Resources

`ci/codearts-resources` 是 CodeArts 构建资源的独立维护分支，用于预取、校验并上传稳定的大文件资源。该分支不包含 ScienceDiscovery 业务代码，也不应合入 `main`。

向本分支推送提交后，`.codearts/workflow/codearts-resources-pipeline.yml` 会自动并行准备工具链资源和 QEMU Ubuntu 云镜像：先检查 OBS 中的现有对象，未命中时才从固定源站下载；每个对象都必须通过固定 SHA256 校验，之后才由 CodeArts 上传到 OBS。

## 文件

- `.codearts/workflow/codearts-resources-pipeline.yml`：push 触发、并行任务和 OBS 上传步骤。
- `.ci/prepare-codearts-resources.sh`：声明资源文件名、源站 URL 与 SHA256，并准备上传目录。
- `.ci/fetch-verified-binary.sh`：实现“本地文件 → OBS → 源站”的校验下载机制。
- `.ci/fetch-qemu-image.sh`：固定 QEMU Ubuntu 云镜像版本及其 SHA256。

## OBS 对象结构

```text
obs://openjiuwen-ci/
└── sciencediscovery/cache/
    ├── toolchains/v1/<immutable-filename>
    └── qemu/v1/noble-server-cloudimg-amd64.img
```

公网读取地址分别为：

- `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/toolchains/v1/`
- `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/qemu/v1/`

## 更新资源

新增或升级资源时，应同时更新资源文件名、权威源站 URL、SHA256 和流水线中的 OBS key / 上传文件路径。对象名必须体现不可变版本；不要用不同内容覆盖已有 key。提交并推送本分支后，使用流水线日志确认校验和上传结果。
