# 用户反馈功能 — 部署与点验手册

本手册覆盖「用户反馈功能」上线前的两件手工事项：

1. 部署 Cloudflare Worker（`packages/feedback-worker`）并配置密钥/KV/Origin 白名单
2. 在两个前端（Linux Web 端 + Windows 桌面端）点验反馈提交，核对回执码与 GitHub issue

## 架构速览

| 组件 | 作用 |
| --- | --- |
| `packages/operational-logging` | 共享契约：payload 构建、脱敏、回执码、端点常量、校验 |
| `packages/feedback-worker` | Cloudflare Worker：KV 去重/限流/护栏、Origin 白名单、CORS，中转成私有 GitHub issue |
| `apps/web` | **Linux Web 端**（默认根路径 `apps/web/dist`） |
| `apps/desktop` | **Windows 桌面端**新工作台（打包 renderer 载荷） |
| `win_desktop`（sd-shell） | Electron 外壳，拉起后端栈并加载 UI |
| `services/launcher` | 后端栈入口，4310 服务 UI、4410 服务控制 API |

> 打包后的桌面端通过 `SCIENCE_AGENT_WEB_DIR=apps/desktop/dist`（见 `win_desktop/src/bootstrap.ts`）加载 `apps/desktop`；Web/默认路径加载 `apps/web`。两端反馈功能均已实现。

> **限额是近似值。** 去重、IP 小时限流、installId 日限流和每日 issue 配额都建立在 KV 的 `get` → 判断 → `put` 之上，KV 没有原子的条件写入，并发请求可能同时通过检查而略微超出阈值。当前量级下可以接受；若将来需要严格限额，应改用 Durable Object 承载计数。

---

## 一、部署 Worker

### 前置条件

- 一个 Cloudflare 账号
- 一个**私有** GitHub 仓库 `sciencediscovery-feedback`
- 一份 **fine-grained PAT**：仅授予该仓库 `Issues → Read and write` 权限
- 该仓库已建好以下 issue 标签：`source:in-app`、`kind:bug`、`kind:idea`、`kind:other`、`needs-triage`，以及联系方式会用到的 `contact:email`、`contact:github`。创建 issue 时一并附带标签，**缺任何一个 GitHub 都会返回 422**；Worker 遇到 422 会自动去掉标签重试一次，反馈不会丢，但 issue 会缺标签、需要人工补。仓库 Settings → Labels 里逐个新建即可。

### 部署前需处理的三个缺口

1. 仓库没有 `wrangler` 依赖（`deploy` 脚本调用 `wrangler deploy`，但未声明依赖）→ 全程用 `npx wrangler`。
2. `wrangler.toml` 缺少 `[[kv_namespaces]]` 段 → Worker 源码靠 `env.FEEDBACK_KV` 工作，必须补绑定。
3. `wrangler.toml` 中 `REPO_OWNER` 为空 → 不填则 issue 创建请求会打到 `repos//sciencediscovery-feedback`，返回 502。

### 步骤（在仓库根 `E:\MyCode\sciencediscovery` 下执行）

1. 登录 Cloudflare 并创建 KV namespace，拿到 id：

   ```powershell
   npx wrangler login
   cd packages/feedback-worker
   npx wrangler kv namespace create FEEDBACK_KV
   # 输出形如 { id = "0123abcd..." }，记下 id
   ```

2. 编辑 `packages/feedback-worker/wrangler.toml`：
   - `[vars]` 中填入 `REPO_OWNER = "<GitHub 用户名或 org>"`
   - 追加 KV 绑定：

     ```toml
     [[kv_namespaces]]
     binding = "FEEDBACK_KV"
     id = "<上一步的 id>"
     ```

   - 生产白名单（可选，本地 5173/5174/4310 已默认放行）：

     ```toml
     # ALLOWED_ORIGINS = "https://你的生产域名"
     ```

3. 构建共享层（Worker 依赖 `@sciencediscovery/operational-logging/feedback` 的运行时 `dist/feedback.js`）：

   ```powershell
   pnpm --filter @sciencediscovery/operational-logging build
   ```

4. 写入 GitHub token 为 Secret（绝不可放 toml 或客户端代码）：

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   # 回车后粘贴 PAT
   ```

5. 部署：

   ```powershell
   npx wrangler deploy
   ```

6. 端到端验证（不必等前端，直接打 Worker）。

   > 地址格式是 `<Worker 名>.<workers.dev 子域名>.workers.dev`。本项目的值是
   > `https://sciencediscovery-feedback.sciencediscovery.workers.dev`，与
   > `packages/operational-logging/src/feedback.ts` 的 `FEEDBACK_ENDPOINT` 必须一致。

   ```powershell
   curl.exe -X POST "https://sciencediscovery-feedback.sciencediscovery.workers.dev/api/feedback" -H "Content-Type: application/json" -H "Origin: http://localhost:5173" -d "{\"v\":1,\"kind\":\"bug\",\"title\":\"deploy smoke test\",\"body\":\"This is a real smoke test feedback sent after deployment.\",\"clientTs\":\"2026-11-04T00:00:00.000Z\"}"
   ```

   > 上面刻意写成**单行**、正文用 ASCII：多行反引号续行在 PowerShell 里粘贴容易失效，
   中文正文可能被本地代码页改写。若连不上，尝试加代理 `--proxy http://127.0.0.1:7890`。

   期望 `201` + `{"receipt":"FB-XXXX-XXXX",...}`；错误会返回 `{error,...}`。

---

## 二、本地点验

### Web 端（Linux）

1. 起后端：

   ```powershell
   pnpm dev
   # = pnpm --filter @sciencediscovery/api dev（tsx watch，起控制 API）
   ```

   需要完整栈（runner/memory-graph 等）时用 `pnpm server`（bash 脚本，Windows 需 Git Bash/WSL）。

2. 起前端（另开终端）：

   ```powershell
   pnpm --filter @sciencediscovery/web dev
   # 浏览器开 http://localhost:5173（/api、/health 已代理到 4310）
   ```

3. 登录 → 侧栏底部「反馈」→ 填写提交 → 记录回执码。

### 桌面端（Windows）

**A. 轻量点验（先做，验证 renderer 反馈流程即可）**

```powershell
pnpm --filter @sciencediscovery/desktop build      # -> apps/desktop/dist
$env:SCIENCE_AGENT_WEB_DIR="apps/desktop/dist"
pnpm start                                          # 起栈并让 4310 服务 desktop
# 浏览器开 http://localhost:4310
# 或用纯前端热更：pnpm --filter @sciencediscovery/desktop dev  # 5174，代理到 4310
```

**B. 真实 Electron 外壳**

```powershell
cd win_desktop
pnpm install
pnpm start        # = node scripts/build.mjs && electron .
```

它会自己拉起后端栈并 `loadURL`；首次走数据目录/模型向导（可用 `SD_SHELL_UI_URL` / `SD_SHELL_TOKEN` 跳过）。

### 核对回执码 + GitHub issue

- 前端：提交成功后显示回执码，历史记录里也留一份。
- GitHub：私有仓库 `sciencediscovery-feedback` 的 Issues 中出现标题 `[FB-XXXX-XXXX] <你的标题>`，正文含回执码/类型/版本/系统/语言/installId/诊断/联系方式（联系方式单独标注「私有，勿外传」）。

---

## 端口与 Origin 白名单速查

默认端口（epoch 0）：

| 端口 | 服务 |
| --- | --- |
| 4310 | Web UI（adapter） |
| 4311 | runner |
| 4410 | 控制 API（health + Bearer） |
| 4313 | evolve |
| 17674 | memory-graph |

Worker 默认放行的 Origin（`DEFAULT_ALLOWED_ORIGINS`）：

```
http://127.0.0.1:4310   http://localhost:4310
http://127.0.0.1:5173   http://localhost:5173
http://127.0.0.1:5174   http://localhost:5174
```

> 桌面端 Electron 无 `Origin` 头会被放行；只有部署到公网域名时才需用 `ALLOWED_ORIGINS` 追加。

---

## 故障排查

| 状态码 | 含义 | 排查方向 |
| --- | --- | --- |
| 502 | GitHub issue 创建失败 | `REPO_OWNER` 为空、PAT 无 `issues:write` 权限、仓库不存在/非私有 |
| 403 | Origin 被拒 | 来源不在 `DEFAULT_ALLOWED_ORIGINS` 且未配置 `ALLOWED_ORIGINS` |
| 409 | 重复提交 | 7 天内相同 `kind+body` 已提交过，返回原回执码 |
| 429 | 限流 | installId 每日 >5 次，或同一 IP 每小时 >10 次 |
| 503 | 每日 issue 配额耗尽 | `DAILY_ISSUE_LIMIT`（默认 200）已达上限 |
| 413 | 体积超限 | 请求体超过 `FEEDBACK_MAX_BYTES`（16384 字节） |
| 400 | 字段校验失败 | `body` 需 ≥10 字符，`title` ≤120，`kind` 合法等 |