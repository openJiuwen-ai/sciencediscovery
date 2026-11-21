# ScienceFlow Runtime Skill（中文安装说明）

这是一个基于本地 ScienceFlow 源码 ZIP 部署研究 Agent 的可发布 Skill。适合 ScienceDiscovery、GitHub 网络受限的 Ubuntu 服务器以及希望固定上游版本的环境。

**当前提供的是 Skill 模板版：**实际收到的是 `part1.zip` 和一个 GitHub 仓库链接，不是 `repo.zip` 实体。打包器现在可直接下载指定 GitHub commit 并构建完整发布包，或在网络受限时从你已有的 `repo.zip` 构建。不要将包含真实 `.env` 的原始 `repo.zip` 直接发布。

## 目录结构

- `SKILL.md`：符合 Skill 规范的入口，说明适用场景、边界和操作步骤。
- `scripts/install.py`：从本地 `assets/repo.zip` 安全提取源码，并建立独立 `.venv` 安装依赖。
- `scripts/configure_api.py`：从私有环境文件创建上游 `models.json`（文件权限 `600`）。
- `scripts/doctor.py`：检查源码、CLI 和 API 注册表的存在性。
- `scripts/run.py`：调用本地安装的 `scienceflow` CLI。
- `scripts/package_release.py`：将原始 `repo.zip` 过滤敏感文件后封装为完整发布包。
- `references/`：API、故障排查、ScienceDiscovery 导入说明。

## 维护者：生成包含 ScienceFlow 上游源码的完整发布包

**方案 A：有 GitHub 访问权限（推荐）**。将 ScienceFlow 0.2.0 对应的已知发布 commit 固定到产物中：

```bash
python3 scienceflow-runtime/scripts/package_release.py \
  --github-ref 8eb1ded20e5a98d3f5b5760d036e45e3ee2d6f3d \
  --output ./scienceflow-runtime-with-source.zip
```

也可使用 `--github-ref master` 获取当前主分支，但它不是不可变的版本，未来可能发生变化。

**方案 B：GitHub 不通或者需要保留你自己的修改版**，使用现有 `repo.zip`：

```bash
python3 scienceflow-runtime/scripts/package_release.py \
  --repo-zip ./repo.zip \
  --upstream-ref <固定commit或tag> \
  --output ./scienceflow-runtime-with-source.zip
```

`repo.zip` 内即使带有 `.env`，也会在重新打包时剔除。打包器会将源码封装为 `assets/repo.zip`，剔除 `.env*`、私钥、`models.json`、`.git/`、`.venv/` 等，并检查 ScienceDiscovery 的体积限制。推荐固定上游 commit、保存哈希、保留上游 LICENSE。此检查不等于完整的密钥扫描：发布前仍需审核源代码中的硬编码凭据。

## 使用者：安装和环境检查

把完整 ZIP 导入 ScienceDiscovery 的 Skills，或在宿主机解压。安装时在可写目录里执行：

```bash
SKILL_DIR=/path/to/scienceflow-runtime
bash "$SKILL_DIR/bootstrap.sh" ./sf_runtime
python3 "$SKILL_DIR/scripts/doctor.py" --target ./sf_runtime --check-cli
```

如果 Python 解释器不是 `python3`，可设置 `SF_PYTHON=/path/to/python3.12`。安装器不会克隆 GitHub；但 Python 依赖仍需要可访问 PyPI 镜像或本地 wheelhouse。若完全离线：

```bash
SF_PYTHON=python3.12 bash "$SKILL_DIR/bootstrap.sh" ./sf_runtime \
  --offline --wheelhouse /path/to/wheels
```

只准备源代码，不安装依赖：

```bash
bash "$SKILL_DIR/bootstrap.sh" ./sf_runtime --no-install
```

如果使用模板版而非完整包，可传入 `--repo-zip /path/to/repo.zip`。依赖安装失败后可以使用相同目标重试；如果源码 SHA-256 不同，必须换一个新运行目录，避免覆盖旧数据。

## API：建议配置到 Skill 之外

**推荐“公开模板 + 私有环境变量 + 上游私有模型注册表”三层配置。**

```bash
mkdir -p "$HOME/.config/scienceflow-runtime"
cp "$SKILL_DIR/config/api.env.example" "$HOME/.config/scienceflow-runtime/api.env"
chmod 600 "$HOME/.config/scienceflow-runtime/api.env"
# 修改 api.env，填写实际模型名、base_url 和密钥
python3 "$SKILL_DIR/scripts/configure_api.py" \
  --env-file "$HOME/.config/scienceflow-runtime/api.env"
```

生成 `~/.config/scienceflow/models.json`，文件权限是 `600`。对已存在的配置不会直接覆盖；使用 `--force` 时先写 `.bak` 备份（若备份已存在则停止，避免覆盖备份）。`SF_MODEL/SF_BASE_URL/SF_API_KEY` 分别对应模型名、OpenAI 兼容 API URL 和密钥，反馈模型可通过 `SF_FEEDBACK_*` 独立设置，代理按需设置 `SF_USE_PROXY=true`。

若公司 API 网关要求 `api_key="sk-1234"` 同时在 `default_headers.Authorization` 传**另一个**真实 Token，不能直接假设上游 `models.json` 支持任意 header；需先验证对应版本的 SDK 配置，或由可信反向代理注入。这一点在 `references/api-configuration.md` 中详细解释。

## 运行

```bash
python3 "$SKILL_DIR/scripts/run.py" --target ./sf_runtime -- --help
python3 "$SKILL_DIR/scripts/run.py" --target ./sf_runtime -- tui
```

后续使用当前上游 TUI 的 `/long-research` 指令启动研究任务。成功解压、成功安装、CLI 能启动和研究任务完成是四个不同层次，不能混淆。

## 限制

- 打包源码≠完全离线运行。`pip/uv` 仍会解析和安装第三方 Python 包；旧版依赖可能还指向 GitHub。
- ScienceDiscovery 的 Skill 包在沙箱中为只读，必须部署到可写工作区。若宿主不允许启动子进程、安装依赖、调用 GPU 或访问网络，Skill 无法突破权限限制。
- 仅使用模拟上游目录完成了脚本功能测试。真实的 ScienceFlow 安装及 Agent 全流程，需使用**实际的 repo.zip、匹配的依赖和可用的 API 凭据**验证。
