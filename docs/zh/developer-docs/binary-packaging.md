# 单文件二进制打包与发行

本文描述 Linux 单文件发行包的构建、版本标识、内容和首次启动机制。面向普通用户的安装步骤见[部署指南](../getting-started/deployment.md)。

## 构建版本标识

Runner 与发行包使用构建时 Git commit 的前 8 位作为构建标识，而不是内部里程碑名称。

- `pnpm build` 自动写入构建信息；
- SEA 打包保留同一标识；
- 运行机器不需要 Git；
- 工作树存在已跟踪文件的未提交改动时追加 `-dirty`；
- 正式发布应从干净提交构建。

若源码归档没有 Git 元数据，可以在构建时设置：

```bash
SCIENCE_AGENT_BUILD_COMMIT=<完整 commit SHA>
```

既没有 Git 信息也没有显式 SHA 时，构建标识为 `unknown`。系统不会伪造版本号。

远端与本地构建标识不同只用于提示，不单独阻止连接。已部署的旧 Runner 会继续报告自己的旧标识，直到被新构建替换。

## 构建发行包

在仓库根目录按当前架构构建：

```bash
case "$(uname -m)" in
  x86_64|amd64|x64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

./scripts/package-binary-release.sh \
  --arch "$arch" \
  --version local \
  --output dist/binary-release-local

artifact="dist/binary-release-local/ScienceDiscovery-local-linux-$arch"
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
"$artifact" serve
```

输出包括：

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
VERSION
SHA256SUMS
```

### 双架构构建

```bash
./scripts/package-binary-release.sh \
  --version local \
  --output dist/binary-release-local

(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
```

也可以只构建一个架构：

```bash
./scripts/package-binary-release.sh \
  --arch x86_64 \
  --version local \
  --output dist/binary-release-local
```

构建机需要：

- Node；
- pnpm；
- uv；
- tar；
- zstd；
- sha256sum。

不需要 Docker 或 QEMU。

Node 与 CPython 运行时按 `scripts/binary-release/runtimes.json` 中固定的版本和 SHA256 下载。TypeScript 产物、Web 资源与 gateway wheel 与目标架构无关；打包脚本会额外校验内置 CPython 扩展模块的 ELF 架构。

默认使用 zstd level 19 压缩，可在迭代构建时通过 `SCIENCE_AGENT_PAYLOAD_ZSTD_LEVEL` 调整。

## 单文件里包含什么

| 组成 | 说明 |
| --- | --- |
| Launcher | Node single-executable application；最终产物是普通 ELF 可执行文件 |
| Node runtime | 供控制 API 与 Runner 使用 |
| CPython 3.12 | 可重定位 Python；同时作为首启 gateway venv 的基础解释器 |
| Web 静态资源 | 预构建的 `apps/web/dist` |
| Gateway wheel 与首启清单 | 自有 gateway wheel、带哈希的锁定依赖清单和 uv wheel pin |
| JiuwenSwarm 与 adapter | 固定版本 JiuwenSwarm 及自有 adapter，连同其第三方依赖在构建时准备 |
| micromamba | 固定版本；首次启动播种到数据目录并由 Runner 校验 |

发行包**不包含**：

- uv 可执行环境本身；
- gateway 的完整第三方 Python 依赖树；
- Neo4j；
- starter Python/R 科学环境；
- conda 包缓存。

这些取舍用于减小发行包体积，同时保持关键运行时版本可校验。

## 首次启动 bootstrap

单文件第一次 `serve` 会先把内嵌 payload 解包到：

```text
~/.cache/science-discovery/payload/<payload-id>
```

可以通过 `XDG_CACHE_HOME` 或 `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR` 覆盖位置。

目录名包含 payload 摘要，因此新版本不会覆盖旧版本。历史 `~/.cache/science-agent` 缓存仅在目标新位置不存在时做一次兼容迁移。

随后准备两部分依赖：

1. **uv**：从配置的 PyPI index 下载构建时固定版本与 SHA256 的 uv wheel，校验后放入 `<data-dir>/tools/uv/`；
2. **gateway Python 环境**：在 `<data-dir>/envs/gateway` 基于内置 CPython 创建 venv，并按从 `services/gateway/uv.lock` 导出的 hash-pinned requirements 安装。

相关变量：

| 变量 | 作用 |
| --- | --- |
| `SCIENCE_AGENT_PYPI_INDEX` | Python 依赖 package index |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | uv wheel 单独下载 index |
| `SCIENCE_AGENT_UV_PATH` | 使用已有 uv，跳过下载 |

离线部署可以在联网主机完成一次首启后整体复制数据目录，或使用可达的内部镜像与预装 uv。

## 启动后的进程关系

单文件 `serve` 负责启动并监管运行所需组件。用户可见的公共端口仍是 4310，详细进程边界、adapter/API 关系和工具调用路径见[整体运行时架构](architecture.md)。

随包 Python MCP server 由 API 按需拉起，不由 launcher 作为常驻子服务监管。

Ctrl-C 会按启动反序停止由 launcher 启动的服务。

## Runner SEA

远端 Runner 使用自带 Node runtime 的 SEA 单文件。完整的自动部署、上传、校验与清理机制见[部署运行机制](deployment-runtime.md)。
