# PDF 抽取：services/paper

隔离的 PDF 抽取 worker：一个无常驻进程的 Python 脚本，由控制 API 按次拉起，把 PDF 变成有界的 Markdown、表格、插图与页面预览。用户视角的上限清单见[运行时行为参考](runtime-behavior.md#论文阅读器限制)。

## 1. 调用协议

API 侧（`papers.ts`）用 `execFile` 拉起：

```text
<python> services/paper/paper_worker.py <输入 PDF 路径> <输出目录>
```

- Python 解释器默认 `.sciencediscovery-data/envs/paper/bin/python`（`SCIENCE_AGENT_PAPER_PYTHON_PATH` 可覆盖）；worker 路径 `SCIENCE_AGENT_PAPER_WORKER_PATH`。
- worker 把 `PaperExtractionManifest` JSON 写到 stdout；API 侧 stdout 上限 10 MiB、单次调用超时 120 秒。
- 失败/取消由 API 写回 extraction job（`.sciencediscovery-data/artifact-extraction-jobs/`），错误码 `CANCELLED` / `NORMALIZATION_FAILED`，不自动重试。

## 2. 抽取管线（`paper_worker.py`，基于 pdfplumber）

1. 校验：大小 ≤ `MAX_PDF_BYTES`（50 MiB）、`%PDF-` 签名、输出目录为空、页数 ≤ `MAX_PAGES`（200）。
2. 文本：逐页 `extract_text(layout=True)`，累计不超过 `MAX_TEXT_CHARACTERS`（2000 万），写 `fulltext.md`（`## Page N` 分节）。
3. 表格：`find_tables()`，过滤 1 行/1 列表格，每表输出 CSV + bbox 裁剪 PNG，上限 `MAX_TABLES`（256）。
4. 插图：`page.images` 去重（bbox），过滤小于 8×8 pt，渲染 PNG，上限 `MAX_FIGURES`（128）。
5. 页面预览：前 `MAX_PAGE_PREVIEWS`（24）页渲染 PNG；所有渲染 120 DPI。
6. manifest：记录输入 SHA256、页/字符统计、每页 `needsVision`（嵌入文本 < 80 字符）、全部限制值与 warnings。

输出布局（会话工作区 `papers/<paper-id>/analysis/`）：

```text
manifest.json  fulltext.md  tables.json
pages/page-0001.png …  tables/table-0001-p3.{csv,png} …  images/figure-0001-p2.png …
```

## 3. 视觉分析（API 侧，不经 worker）

手动触发（`POST /api/sessions/:id/papers/:paperId/vision`）。候选图优先级：`needsVision` 页预览 → 插图 → 全部页预览，取前 `MAX_VISION_IMAGES`（4）张；单图 ≤ 5 MiB、总量 ≤ 12 MiB、响应 ≤ 2 MiB、超时 90 秒。由控制 API 直接 POST 视觉模型的 `chat/completions`（base64 data URL），结果写 `papers/<id>/vision/<run-id>.md`，请求与响应入 CAS，用量入 model-usage。

## 4. 测试

`pnpm paper:setup`（uv 锁定 venv）+ `pnpm paper:test`（unittest，`services/paper/tests/`），已接入 `pnpm check`。

## 相关文档

- [科研连接器](../explanation/science-connectors.md) — 下载与抽取在治理链路中的位置
- [控制面](../explanation/control-plane.md) — papers 相关端点
