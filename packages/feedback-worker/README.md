# 用户反馈功能 — 部署与点验手册

本手册覆盖「用户反馈功能」上线前的两件手工事项：

1. 部署 Cloudflare Worker（`packages/feedback-worker`）并在控制台配置变量、密钥与 KV 绑定
2. 在两个前端（Linux Web 端 + Windows 桌面端）点验反馈提交，核对回执码与 GitHub issue

## 架构速览

| 组件 | 作用 |
| --- | --- |
| `packages/operational-logging` | 共享契约：payload 构建、脱敏、回执码、端点常量、校验、图片校验；`feedback-client` 子路径还共享两端的草稿/历史存储、打开钩子和提交请求 |
| `packages/feedback-worker` | Cloudflare Worker：KV 去重/限流/护栏、Origin 白名单、CORS，中转成私有 GitHub issue，并把截图写入仓库 |
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
- 一份 **fine-grained PAT**，仅授权该仓库：
  - `Issues → Read and write`（创建 issue）
  - `Contents → Read and write`（把截图写入 `feedback-images/`）
- 该仓库已建好以下 issue 标签：`source:in-app`、`kind:bug`、`kind:idea`、`kind:other`、`needs-triage`，以及联系方式会用到的 `contact:email`、`contact:github`。创建 issue 时一并附带标签，**缺任何一个 GitHub 都会返回 422**；Worker 遇到 422 会自动去掉标签重试一次，反馈不会丢，但 issue 会缺标签、需要人工补。仓库 Settings → Labels 里逐个新建即可。

### 所有可配置项都在 Cloudflare 控制台

仓库里的 `wrangler.toml` **只保留 Worker 名称、入口、兼容日期、可观测性和 KV 绑定**，不再包含任何限额或仓库地址。限额与目标仓库必须配置在：

> Cloudflare Dashboard → Workers & Pages → `sciencediscovery-feedback` → Settings → Variables and Secrets

| 变量 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `REPO_OWNER` | 文本 | 是 | 反馈 issue 所在仓库的 owner |
| `REPO_NAME` | 文本 | 是 | 反馈 issue 所在仓库名（通常 `sciencediscovery-feedback`） |
| `INSTALL_DAILY_LIMIT` | 文本（正整数） | 否 | 同一 installId 每日最多提交次数，缺省 `5` |
| `IP_HOURLY_LIMIT` | 文本（正整数） | 否 | 同一 IP 每小时最多提交次数，缺省 `10` |
| `DAILY_ISSUE_LIMIT` | 文本（正整数） | 是 | 所有来源每日最多创建 issue 数（总护栏），例如 `200` |
| `DEDUP_TTL_SECONDS` | 文本（正整数，≥60） | 否 | 去重记录保留秒数（KV 要求 ≥60），缺省 `604800`（7 天） |
| `ALLOWED_ORIGINS` | 文本 | 否 | 追加放行的 Origin，逗号分隔；本地 5173/5174/4310 已内置 |
| `GITHUB_TOKEN` | Secret | 是 | 上面的 fine-grained PAT，**只能**放 Secret |

`INSTALL_DAILY_LIMIT`、`IP_HOURLY_LIMIT`、`DEDUP_TTL_SECONDS` 缺省时使用它们原先在 `wrangler.toml` 里的值，避免一次没带变量的部署让所有反馈变成 503。`REPO_OWNER`、`REPO_NAME`、`DAILY_ISSUE_LIMIT` 没有兜底：缺失，或任何变量写了非法值（非正整数、TTL <60），Worker 都会返回 `503 {"error":"misconfigured"}`，并在 `wrangler tail` 里打印缺失的变量名，避免“带着没人选过的限额悄悄上线”。

`wrangler.toml` 里的 `keep_vars = true` 不能删。没有它时，`wrangler deploy` 会把「配置文件里没写 `[vars]`」理解成「删掉全部变量」，于是一次普通部署就会清空上面这些控制台变量，Worker 随即变成 503 `misconfigured`。它只保留「部署那一刻 Worker 上已有的变量」：变量已经丢了的话，先按上表补回来再部署。Secret 与 KV 绑定不受该行为影响。

### 步骤（在仓库根 `E:\MyCode\sciencediscovery` 下执行）

1. 登录 Cloudflare 并创建 KV namespace，拿到 id：

   ```powershell
   npx wrangler login
   cd packages/feedback-worker
   npx wrangler kv namespace create FEEDBACK_KV
   # 输出形如 { id = "0123abcd..." }，记下 id
   ```

2. 把 id 填进 `packages/feedback-worker/wrangler.toml` 已有的 `[[kv_namespaces]]` 段（`binding = "FEEDBACK_KV"`）。也可以改用 Dashboard 的 KV 绑定，二选一。

3. 构建共享层（Worker 依赖 `@sciencediscovery/operational-logging/feedback` 的运行时 `dist/feedback.js`）：

   ```powershell
   pnpm --filter @sciencediscovery/operational-logging build
   ```

4. 按上表在 Dashboard 添加变量，并写入 GitHub token：

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

## 二、截图上传

- 反馈对话框右下角的「上传图片」按钮可选本地图片，最多 8 张。客户端先压缩（最长边 1600px、WebP，必要时逐级降质/缩小），再以 Base64 随文字一起提交，**原图不会离开浏览器**。
- 单张压缩后 ≤ 2 MB，整个请求 ≤ 24 MiB（8 张满配 Base64 约 21.4 MiB）。超限会先被客户端拦下（`too_large`），Worker 再做一次同样的校验。
- Worker 通过 GitHub Contents API 把图片写到目标仓库的 `feedback-images/<回执码>/<序号>.<png|jpg|webp>`，文件名与用户选择的文件名无关；用户填写的文件名只作为 issue 正文里的说明文字。
- 图片上传失败不会丢掉反馈：issue 仍会创建，正文「截图」一节会标注哪些图片上传失败，原因只记录在 `wrangler tail`。如果 issue 本身创建失败，Worker 会尽力删除本次已上传的图片，避免重试时在仓库里留下孤儿文件。
- 隐私提示：截图会进入私有仓库的历史（即使日后删除文件也仍可从提交历史恢复），并且对仓库协作者可见。反馈对话框里应提示用户先遮挡敏感信息。

---

## 三、本地点验

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

3. 登录 → 侧栏底部「反馈」→ 填写提交 → 记录回执码。可选附图后再提交，确认 issue 正文出现截图。

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
- GitHub：私有仓库 `sciencediscovery-feedback` 的 Issues 中出现标题 `[FB-XXXX-XXXX] <你的标题>`，正文含回执码/类型/版本/系统/语言/install Id/诊断/截图/联系方式（联系方式单独标注「私有，勿外传」）。
- 图片：仓库内出现 `feedback-images/FB-XXXX-XXXX/1.png` 等文件；issue 正文用 raw 链接内嵌。

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

```text
http://127.0.0.1:4310   http://localhost:4310
http://127.0.0.1:5173   http://localhost:5173
http://127.0.0.1:5174   http://localhost:5174
```

> 桌面端 Electron 无 `Origin` 头会被放行；只有部署到公网域名时才需用 `ALLOWED_ORIGINS` 追加。

---

## 故障排查

| 状态码 | 含义 | 排查方向 |
| --- | --- | --- |
| 503 + `{"error":"misconfigured"}` | 控制台配置缺失/非法 | `wrangler tail` 会打印缺失的变量名；按上表补齐后重新部署。若变量原本配过、只是刚部署完就 503，多半是 `keep_vars` 被删所致 |
| 502 | GitHub 调用失败 | `REPO_OWNER`/`REPO_NAME` 错误、PAT 缺 `issues:write` 或 `contents:write`、仓库不存在 |
| 403 | Origin 被拒 | 来源不在 `DEFAULT_ALLOWED_ORIGINS` 且未配置 `ALLOWED_ORIGINS` |
| 409 | 重复提交 | `DEDUP_TTL_SECONDS` 内相同 `installId + kind + body + 图片内容` 已提交过，返回原回执码 |
| 429 | 限流 | 超过 `INSTALL_DAILY_LIMIT`（按 installId）或 `IP_HOURLY_LIMIT`（按 IP） |
| 503 + `{"error":"unavailable"}` | 每日 issue 配额耗尽 | `DAILY_ISSUE_LIMIT` 已达上限 |
| 413 | 体积超限 | 请求体超过 `FEEDBACK_MAX_BYTES`（24 MiB）；单图 ≤2 MB 由共享校验拦截 |
| 400 | 字段校验失败 | `body` 需 ≥10 字符，`title` ≤120，`kind` 合法，图片 MIME/Base64 合法等 |
