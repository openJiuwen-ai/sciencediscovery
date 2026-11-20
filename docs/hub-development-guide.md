# ScienceDiscovery Hub：开发与调试指南

> 给接手这个项目的工程师/agent 看的完整说明：需求是什么、现在做到哪、代码怎么摆、怎么运行、怎么测、常见坑是什么。
> 配套文档：[主机部署与交接](hub-host-handoff.md)、[后端设计](hub-backend-design.md)。
> 当前分支：`feat/hub-backend`，PR **#1225（draft）**，目标仓库 `openJiuwen-ai/sciencediscovery`。

---

## 1. 需求背景（先读这一节）

### 1.1 要解决的问题

仓库里已经有技能（skills/）、专家（specialist）、连接器（mcp-sources）、团队技能和会话包（`.sdresearch`），但它们只能靠翻目录发现；发布出来的会话包也没有统一的下载入口。

这个项目要提供一个 **Hub**：

1. 浏览：按类型、分类、搜索查看所有资产；
2. 详情：说明文档、文件清单、基本信息；
3. 下载：技能包、专家/连接器 JSON、会话包；
4. 后续：用户登录、自己上传、版本管理、审核后才公开。

### 1.2 与 openJiuwen Agentic Hub 的关系

我们是照着 `openJiuwen-ai/skillhub` 的**架构**做的：

```text
浏览器 → nginx（站点 + /api 反代）→ hub-api（FastAPI）→ MySQL（唯一真相源）
                                                   └→ OBS 私有桶（包体，签名下载）
```

- 参考实现的资产元数据在数据库里，页面从 `/api/v1` 读；我们也一样；
- 参考实现的桶是私有的，下载由后端签短链；我们也一样；
- 参考实现有登录、上传、审核、版本；我们已实现后端接口和最小可用的前端页面。

**不再采用**“静态站 + `catalog.json` + push 自动发布桶”的旧形态。静态导出器只保留为**导入迁移工具**。

### 1.3 功能性需求与验收

| 编号 | 需求 | 验收方式 | 状态 |
|---|---|---|---|
| R1 | 五个标签页浏览（技能/团队技能/专家/连接器/会话包） | 首页计数与列表一致 | ✅ |
| R2 | 分类树过滤、搜索 | 选中分类/输入关键字，列表变化 | ✅（前端过滤） |
| R3 | 详情页：说明、Files 清单、文件预览、基本信息 | 打开任一条目 | ✅ |
| R4 | 下载：建议文件名、sha256 与目录一致 | 下载后 `sha256sum` 对照 | ✅ |
| R5 | 私有桶：匿名访问对象 403 | `curl -I` 对象 URL | ✅ |
| R6 | 登录/退出（管理员与普通用户） | Account 页 | ✅ |
| R7 | 创建资产 | Account → 创建 | ✅ |
| R8 | 上传版本（zip / `.sdresearch`），服务端校验 | Account → 上传 → 待审核 | ✅ |
| R9 | 审核通过/驳回，通过后才公开 | 审核队列 | ✅ |
| R10 | 版本历史、按版本下载 | API 已支持；前端仅显示最新版 | ⚠️ 部分 |
| R11 | 分组/细粒度权限、OAuth/SSO | — | ❌ 未做 |
| R12 | 限流、下载统计、搜索服务端化 | — | ❌ 未做 |

### 1.4 非功能约束

- 页面不得包含任何 AK/SK 或后端密钥；
- 桶必须私有，下载走签名 URL；
- 上传包有上限（50 MiB），解压膨胀有上限（512 MiB），预览单文件上限（2 MiB）；
- 导入必须幂等，可重复执行；
- 生产主机必须开启 NTP（SigV4 拒绝未来 15 分钟以上的签名）。

---

## 2. 架构与数据流

### 2.1 组件

| 组件 | 位置 | 作用 |
|---|---|---|
| 站点 | `apps/hub` | React + Vite 的 SPA；五个标签、详情、Files、Account |
| API | `services/hub-api` | FastAPI + SQLAlchemy；资产、版本、认证、审核、签名下载 |
| 数据库 | MySQL（compose） | 资产、版本、用户、审核、分类路径、README、审计 |
| 对象存储 | OBS 私有桶 | 包体：`assets/<kind>/<publisher>/<asset>/<version>/<file>` |
| 反向代理 | `services/hub-api/deploy/nginx.conf` | `/` 发 `dist`，`/api/` 反代到 8100 |
| 导出器 | `scripts/hub` | 从仓库生成 `catalog.json` + 包；**只作为导入输入** |

### 2.2 读路径

```text
GET /api/v1/catalog      → 网站一次拿全量 {assets, categories}
GET /api/v1/assets/{id}/readme?format=text → 详情页说明
GET /api/v1/assets/{id}/versions/{v}/files/content?path=… → Files 预览
GET /api/v1/artifacts/{id}?version=… → 签名 URL（直接下载）
GET /api/v1/artifacts/{id}/content?version=… → 同源流式下载（保存对话框）
```

### 2.3 写路径

```text
POST /api/v1/auth/login              → token
POST /api/v1/assets                  → 创建资产（owner）
POST /api/v1/assets/{id}/versions    → 上传版本（owner/admin）
GET  /api/v1/admin/reviews           → 待审核队列（admin）
POST /api/v1/admin/reviews/{id}/{v}  → approve / reject（admin）
```

---

## 3. 代码地图

```text
apps/hub/                      站点
  src/App.tsx                  壳：标签、路由、Account 入口
  src/catalog/load.ts          静态/API 两种数据源
  src/catalog/api.ts           API 前缀、artifact 解析、content URL
  src/api/client.ts            登录、创建、上传、审核
  src/views/Detail.tsx         详情 + Files 浏览
  src/views/ListView.tsx       列表/分类/搜索
  src/views/Account.tsx        登录、发布、审核
  src/components/DownloadButton.tsx  保存对话框 + 签名 URL
scripts/hub/                   导出器（导入输入）
  export.ts                    生成 catalog.json
  skills.ts / specialists.ts / connectors.ts / sessions.ts
  tar.ts                       tar 读写（tar-stream）
services/hub-api/              API
  app/main.py                  create_app、守卫、中间件
  app/models.py                表结构
  app/routers/                 auth/assets/artifacts/catalog/reviews/files
  app/storage.py               local/S3、签名、流式读
  app/validation.py            zip/tar 校验、预览读取
  app/security.py              scrypt、HMAC token
  scripts/import_catalog.py    catalog → DB + OBS
  scripts/storage_smoke.py     桶/凭证冒烟
  deploy/nginx.conf            生产反代
  docker-compose.yml           MySQL + API + nginx
.github/workflows/hub-api.yml  API 测试与镜像构建（信息性）
docs/hub-backend-design.md     设计取舍
docs/hub-host-handoff.md       主机部署步骤
```

---

## 4. 领域模型

### 4.1 资产类型

| API `kind` | 前端 `kind` | 说明 |
|---|---|---|
| `skill` | `skill` | 单个技能 |
| `team` | `team-skill` | 团队技能（成员引用专家） |
| `specialist` | `specialist` | 专家 |
| `connector` | `connector` | MCP/连接器 |
| `session` | `session-package` | 会话包 `.sdresearch` |

### 4.2 表

- `users`：`username` 唯一、`password_hash`（scrypt）、`role`（user/admin）；
- `assets`：`id`（可能是路径，如 `biology/bioinformatics/abalign`）、`kind`、`name`（同发布者内唯一）、`display_name`、`summary`、`description`、`readme`、`extra`（JSON，kind 专属字段）、`category`（斜杠路径）、`tags`、`visibility`、`status`、`latest_version`、`public_latest_version`、计数与时间；
- `asset_versions`：`(asset_id, version)` 唯一、`filename`、`storage_key`、`sha256`、`size`、`manifest`（每个文件的 path/size/sha256）、`moderation_status`（pending/approved/rejected）、审核人/时间；
- `audit_log`：操作记录。

**关键语义**：`public_latest_version` 为 NULL 表示没有已通过审核的版本，对匿名不可见；审核通过后才写入。

### 4.3 存储键

```text
assets/<kind>/<publisher_id>/<asset_id>/<version>/<filename>
```

`asset_id` 允许带斜杠（外部技能是路径 id），逐段校验，不允许 `..`、绝对路径、反斜杠。

---

## 5. 环境与运行

### 5.1 本地（开发机）

```bash
pnpm install
pnpm hub:deps                 # 导出器依赖的 workspace 包
cd services/hub-api
python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
```

- 默认 `HUB_STORAGE_BACKEND=local`、SQLite；必须设置一个非默认的 `HUB_SESSION_SECRET`，否则拒绝启动；
- 本地站点：`VITE_HUB_API_BASE=/api/v1 pnpm hub:build:api --root`（不产出 `catalog.json`）；
- 静态兜底模式：不设 `VITE_HUB_API_BASE`，站点读 `catalog.json`（仅供对照）。

### 5.2 主机（生产形态）

见 [hub-host-handoff.md](hub-host-handoff.md)：专用目录 `/opt/sciencediscovery-hub`、compose 项目 `sdhub`、端口 18080/18100、`.env` 只留主机。

---

## 6. 测试与校验

| 命令 | 覆盖 | 期望 |
|---|---|---|
| `cd services/hub-api && .venv/bin/python -m pytest` | 认证、上传、审核、下载、tar/zip、预览上限、签名路由、导入、目录接口 | 20 passed |
| `pnpm hub:test` | 导出器、外部快照、会话包、tar | 44 passed |
| `pnpm typecheck` | 全工作区类型 | 0 error |
| `pnpm ci:l1` | 架构/文档/目录/元数据静态检查 | 4/4 |

服务端测试用 SQLite 与临时目录，不访问网络；涉及 OBS 的手工验证用 `scripts/storage_smoke.py`。

---

## 7. 常见开发任务

### 7.1 增加一个 API 字段

1. `app/models.py` 加列（注意长度；已有库需要 `ALTER TABLE`）；
2. `app/serializers.py` 输出；
3. `scripts/import_catalog.py` 回填；
4. 测试：导入后接口可见；
5. 前端映射（`catalog/load.ts` 或详情页）。

### 7.2 增加一个接口

1. 在 `app/routers/` 加路由，注意可见性用 `_visible_to`；
2. 若路径参数可能是带斜杠的 id，用 `{asset_id:path}`，并把具体路由放在兜底路由之前；
3. 测试补充 `tests/`。

### 7.3 导入数据

```bash
pnpm hub:deps && pnpm hub:export
cd services/hub-api
.venv/bin/python -m scripts.import_catalog --catalog ../../apps/hub/public/catalog.json \
  --assets-root ../../apps/hub/public --sessions-root /path/to/sessions
```

- 幂等；`--dry-run` 只校验；
- 单个 JSON（专家/连接器）会被包成 zip；
- 会话 README 从包内 `README.md` 取。

### 7.4 重置本地数据库

```bash
docker exec <mysql> mysql -uroot -p -e "DROP DATABASE hub; CREATE DATABASE hub;"
# 重新起 API，create_all 会建表；再跑导入
```

### 7.5 仪表盘/排错

```bash
curl -s localhost:8100/api/v1/health
curl -s localhost:8100/api/v1/stats
docker compose -p sdhub logs --tail=100 api
```

---

## 8. 已知问题与排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `RequestTimeTooSkewed` | 主机时钟漂移 | 开 NTP；仅开发机可设 `HUB_CLOCK_OFFSET_SECONDS` |
| `XAmzContentSHA256Mismatch` | boto3 默认 CRC trailer，OBS 不支持 | 已在 `storage.py` 设 `when_required` |
| 启动即报 `HUB_SESSION_SECRET` | 空或默认密钥 | 设置随机值，或开发机 `HUB_ALLOW_DEV_SECRET=1` |
| 上传 413 | 超过 50 MiB（或声明长度超过上限+1MiB） | 压缩包；chunked 也会被运行时上限拦截 |
| 预览 413 | 单文件超过 2 MiB | 调整 `HUB_PREVIEW_MAX_BYTES` |
| 会话上传 400 | 不是 zip/tar、或含 `..`/符号链接/超大条目 | 看返回 detail |
| 详情页 403（nginx） | 真实目录被当成索引匹配 | 用仓库的 `deploy/nginx.conf`（`try_files $uri /index.html`） |
| `dist/` 里有 `catalog.json` | 错误地跑了导出器 | API 部署用 `hub:build:api --root` |
| 页面报 JSON 解析错误 | 静态回落到 `index.html` | 确认 nginx 的 `/api` 反代与静态 404 规则 |
| 本地 `pnpm build` 后页面坏 | 全量构建清掉 `dist` 与导出产物 | 重新 `hub:build:api --root` |

---

## 9. 提交流程与约定

- 分支 `feat/hub-backend`，PR #1225（**draft**，全部验证完再 ready）；
- 提交流程：本地跑完第 6 节 → push 到 fork `ink999107/sciencediscovery` → 等 CI → 不手动合并；
- 提交信息、PR 正文用英文；不要加任何工具署名；
- 不提交 `.env`、AK/SK、日志中的密钥；
- 改动 L1 的检查集合需要同步 `test/support/tagged/checks.mjs` 与 `.ci/test-catalog.mjs`（后者是另一套目录，注意区分）。

---

## 10. 接下来要做的（按优先级）

1. 主机上完整跑一遍：compose 起栈 → 导入 → 浏览/登录/上传/审核/下载验收；
2. 前端补齐：版本历史展示、分组权限、错误态优化；
3. 服务端：限流、服务端搜索、下载统计；
4. 全部验证后把 PR #1225 从 draft 改为 ready。

---

## 11. 术语

| 术语 | 含义 |
|---|---|
| catalog | 站点浏览数据；现在由 `GET /api/v1/catalog` 从数据库生成 |
| 导出器 | `scripts/hub`，从仓库生成 catalog 与包；现仅作导入输入 |
| 版本 | 一次上传的包；审核状态在版本上 |
| 签名 URL | OBS 预签名下载地址，默认 10 分钟 |
| 内容端点 | `/api/v1/artifacts/{id}/content`，同源流式下载，供保存对话框使用 |
| 冒烟 | `scripts/storage_smoke.py`：验证桶、凭证、签名、私有性 |
