# Hub 主机部署与继续开发指南（交给主机上的 agent）

> 适用：一台可公网访问的 Linux 主机（Ubuntu 22.04 或同代发行版），已安装或允许安装 Docker。
> 目标：在主机上把 **MySQL + hub-api + nginx（站点）** 跑起来，导入已有目录，验证浏览、登录、上传、审核、签名下载，然后继续开发和调试。
> 约束：**只使用本文指定的目录、端口和 compose 项目名**；不要停止、删除或修改主机上其他人的容器、进程、目录和防火墙规则。动任何全局配置前先问用户。

---

## 0. 先决条件与边界

| 项 | 约定 |
|---|---|
| 代码目录 | `/opt/sciencediscovery-hub`（新建；不要放进别人的目录） |
| compose 项目名 | `sdhub`（所有容器名带这个前缀，便于识别和清理） |
| 端口 | 站点 `18080`、API `18100`、MySQL 不映射到宿主机 |
| 用户/权限 | 用 `root` 或具备 docker 权限的账号；不要修改系统级 nginx、iptables、已有服务 |
| 数据 | MySQL 数据在 compose volume `sdhub_mysql-data`；OBS 桶 `sciencediscoveryhub`（私有） |
| 密钥 | `.env` 只存在于主机，**禁止**提交、回显到日志或贴进聊天 |

开工前先看一眼主机现状，避免撞端口/撞服务：

```bash
ss -ltnp | head -40                 # 看 18080 / 18100 是否已被占用
docker ps --format '{{.Names}}\t{{.Ports}}'
df -h /opt                          # 预留至少 5 GB
```

如果端口被占用，换一对（例如 28080/28100），后续文档同步替换。

---

## 1. 安装依赖

```bash
apt-get update
apt-get install -y git curl ca-certificates
# Node 22 + pnpm（用发行版自带或 NodeSource 均可；不要覆盖主机上已有的 node）
node -v    # 需要 >= 22
corepack enable && corepack prepare pnpm@11 --activate || npm i -g pnpm@11
# Python 3.12（服务端；若已有 3.11+ 可跳过）
apt-get install -y python3.12 python3.12-venv
# Docker（若已安装，跳过；不要重装/改 daemon 配置）
docker --version && docker compose version
```

若主机访问 Docker Hub 很慢，可先拉镜像再打标签（二选一，不要改 daemon 配置）：

```bash
docker pull docker.m.daocloud.io/library/python:3.12-slim && docker tag docker.m.daocloud.io/library/python:3.12-slim python:3.12-slim
docker pull docker.m.daocloud.io/library/nginx:1.27-alpine && docker tag docker.m.daocloud.io/library/nginx:1.27-alpine nginx:1.27-alpine
docker pull docker.m.daocloud.io/library/mysql:8.0 && docker tag docker.m.daocloud.io/library/mysql:8.0 mysql:8.0
```

---

## 2. 解包与安装工作区

```bash
mkdir -p /opt/sciencediscovery-hub
tar xzf /root/sciencediscovery-hub-*.tar.gz -C /opt/sciencediscovery-hub --strip-components=1
cd /opt/sciencediscovery-hub
pnpm install --frozen-lockfile
pnpm hub:deps        # 构建导出器依赖的 workspace 包（schema/cas/provenance…）
```

服务端本地环境（只在主机上，用于测试和导入脚本）：

```bash
cd /opt/sciencediscovery-hub/services/hub-api
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

---

## 3. 配置 `.env`（唯一需要手填的文件）

```bash
cd /opt/sciencediscovery-hub/services/hub-api
cp .env.example .env
chmod 600 .env
```

需要用户提供/确认的值：

| 变量 | 值 |
|---|---|
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | 自己生成强密码 |
| `HUB_S3_ENDPOINT` | `https://obs.ap-southeast-1.myhuaweicloud.com` |
| `HUB_S3_REGION` | `ap-southeast-1` |
| `HUB_S3_BUCKET` | `sciencediscoveryhub` |
| `HUB_S3_ACCESS_KEY` / `HUB_S3_SECRET_KEY` | **向用户索取**（IAM 子用户，Put/Get 即可） |
| `HUB_SESSION_SECRET` | `python3 -c "import secrets;print(secrets.token_urlsafe(48))"` |
| `HUB_ADMIN_USERNAME` / `HUB_ADMIN_PASSWORD` | 初始管理员 |
| `HUB_ALLOW_REGISTRATION` | `false` |
| `API_HOST_PORT` / `WEB_PORT` | `18100` / `18080` |

生产主机必须开 NTP（`timedatectl set-ntp true`）；`HUB_CLOCK_OFFSET_SECONDS` 只用于时钟漂移的开发机，生产保持不设或 0。

---

## 4. 构建站点并启动整栈

站点必须按“API 模式、根路径”构建（**不要**跑导出器，`dist/` 里不应有 `catalog.json`）：

```bash
cd /opt/sciencediscovery-hub
VITE_HUB_API_BASE=/api/v1 pnpm hub:build:api --root
```

启动：

```bash
cd services/hub-api
docker compose -p sdhub --env-file .env up -d --build
```

首次构建镜像可能需要几分钟；若 PyPI 慢，给构建参数：

```bash
docker compose -p sdhub --env-file .env build \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple api
```

健康检查：

```bash
curl -s http://127.0.0.1:18100/api/v1/health        # API 直连
curl -s http://127.0.0.1:18080/api/v1/health        # 经过 nginx
curl -sI http://127.0.0.1:18080/ | head -1          # 站点
```

---

## 5. 导入现有目录

导入器读取导出器的产物（`catalog.json` + 包 + README），并写入 MySQL/OBS：

```bash
cd /opt/sciencediscovery-hub
pnpm hub:export       # 生成 apps/hub/public（内置技能；外部快照可选）

cd services/hub-api
docker compose -p sdhub --env-file .env run --rm \
  -v /opt/sciencediscovery-hub/apps/hub/public:/import:ro \
  api python -m scripts.import_catalog \
    --catalog /import/catalog.json \
    --assets-root /import \
    --sessions-root /import
```

- 会话包：把用户提供的两个 `.sdresearch` 放到一个目录（例如 `/opt/sd-sessions`），并把该目录挂成 `-v /opt/sd-sessions:/sessions:ro --sessions-root /sessions`；
- 导入是幂等的：重复执行只会跳过已存在的版本；
- 校验：`curl -s http://127.0.0.1:18080/api/v1/stats` 应返回各类型数量。

> 如果导出器需要外部技能快照，先运行 `pnpm hub:sync-skills`（需要 GitCode 访问）；没有快照也可以导入内置技能。

---

## 6. 验收清单

1. **浏览**：`http://<主机IP>:18080/` 首页有卡片；切换五个标签；搜索；
2. **详情**：任取一个技能，Readme 与 Files 能显示（来自 `/api/v1`，不是静态文件）；
3. **下载**：点下载 → 浏览器“另存为”（Chrome/Edge）→ 文件 sha256 与 `catalog` 中的 `download.sha256` 一致：

   ```bash
   curl -s http://127.0.0.1:18080/api/v1/artifacts/<asset-id> | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['sha256'])"
   ```

4. **私有性**：不带签名的 OBS 对象 URL 必须 403：

   ```bash
   curl -sI "https://sciencediscoveryhub.obs.ap-southeast-1.myhuaweicloud.com/assets/..." | head -1
   ```

5. **写路径**：右上角 Account → 用管理员登录 → 创建资产 → 上传 `.zip` → 审核队列通过 → 首页出现；再点下载校验 sha256；
6. **会话**：会话包卡片存在，详情 Readme 来自包内 `README.md`；
7. **重启**：`docker compose -p sdhub restart` 后数据仍在。

---

## 7. 继续开发的流程

```bash
cd /opt/sciencediscovery-hub
git checkout feat/hub-backend     # 或从压缩包自带分支继续
# 改代码
pnpm typecheck && pnpm hub:test
pnpm ci:l1
cd services/hub-api && .venv/bin/python -m pytest
```

- 分支：`feat/hub-backend`（PR #1225，draft；远端 fork `ink999107/sciencediscovery`）；
- **不要**手动合并 PR；CI + committer 批准后自动合并；
- 不要提交 `.env`、AK/SK、cookie、日志中的密钥；
- 不要修改主机上其他人的文件/进程；需要全局改动（防火墙、系统 nginx、daemon 配置）先问用户。

---

## 8. 已知事项与排错

| 现象 | 原因/处理 |
|---|---|
| `RequestTimeTooSkewed` | 主机时钟漂移；开 NTP。仅开发机可临时设 `HUB_CLOCK_OFFSET_SECONDS` |
| 构建镜像拉不到 `python:3.12-slim` | 用第 1 节的镜像源拉取后打标签 |
| `pnpm hub:build:api` 后 `dist/` 里有 `catalog.json` | 错误地跑了导出器；API 构建应使用 `hub:build:api --root`，且 `dist/` 只应有 `assets/` 与 `index.html` |
| 详情页 403 | nginx 把真实目录当成索引；确认使用仓库里的 `services/hub-api/deploy/nginx.conf`（`try_files $uri /index.html`） |
| 上传 413 | 单包上限 50 MiB（`.sdresearch` 也适用）；预览上限 2 MiB |
| 会话上传 400 | `.sdresearch` 是 gzip tar；服务端已支持，若报错请附 `docker compose logs api` |
| 端口冲突 | 换 `API_HOST_PORT` / `WEB_PORT`，不要停别人的容器 |

---

## 9. 需要回传的内容

- `docker compose -p sdhub ps`、`docker compose -p sdhub logs --tail=100 api`；
- `/api/v1/stats` 与首页截图；
- 上传→审核→下载的截图与 sha256 比对结果；
- 任何失败的完整命令与输出。
