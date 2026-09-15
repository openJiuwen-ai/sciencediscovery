# Scholarly fixture 录制与回放（mocked 层 E2E）

回放实现：`services/api/src/knowledge-engine/connectors/transport.ts` 的 `FixtureScholarlyTransport`。
隔离栈以 `SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR` 指向本目录启动时，全部学术连接器出站走本地回放；
**未录制的 URL 响亮报错**（设计意图：宁可测试红，不假成功）。

## 文件契约

- 路径：`<本目录>/<fixtureFileName(url)>.json`
- 命名算法（与 transport.ts 的 `fixtureFileName` 完全一致）：
  `sanitize(host + pathname)`（非 `[a-zA-Z0-9._-]` → `_`，去首尾 `_`，截 80 字符）+ `-` + `sha256(完整 URL).hex 前 12 位`
- 信封：`{ "status": 200, "headers"?: {...}, "body": "…", "encoding"?: "utf8" | "base64" }`（PDF 等二进制用 base64）
- **URL 必须逐字符匹配运行时请求**（含 query 参数顺序与 limit/maxPapers 取值）——用 `make-fixture.mjs` 生成文件名可保证一致

## 录制方式

首选（阶段门建议向 dev 提的增强）：运行时录制模式——`ScholarlyTransport` 代理包装，env 开关注入，
passthrough 同时把响应写成本目录信封。一次真实种子运行即可覆盖全部面。

当前可用：`node make-fixture.mjs <完整URL> [--status N] [--from-file 文件] [--base64] [--header k=v ...]`
（默认自行抓取该 URL 并落盘；文件名自动按契约生成）

## 录制面（W1 完工通知给出的 7 项 + 双路径注意）

| 源 | URL 面 | 注意 |
|---|---|---|
| europepmc | search + fullTextXML | **双路径**：OA 成功 XML + 非 OA 4xx（连接器对 4xx 一律返回 null 不抛错，两种都要录） |
| semantic-scholar | search（+引用解析） | 限流敏感，录制时注意 Retry-After |
| arxiv | `/api/query?search_query=all:<enc>&start=0&max_results=<n>&sortBy=relevance`、`id_list=` | max_results 必须与 orchestrator 实际取值一致；PDF 下载（base64）另录 |
| openalex | works 检索 | — |
| unpaywall | v2 命中与未命中两种 | 404 是正常业务态 |
| pubmed | eutils esearch/efetch | — |
| PDF 下载 | 下载链最终 URL | `encoding:"base64"` |
| arXiv e-print（Z5 LaTeX 通路） | `https://arxiv.org/e-print/<id>`（主镜像 arxiv.org；运行时 transport 跟随 301→`/src/`，fixture 按原始 URL + 最终 200 体录制，`--base64`） | 双路径：**gzip tarball**（TeX 源，如 `1706.03762`）与 **PDF-source 降级**（提交源为单 PDF → `downloadArxivEprint` 返回 null 走 PDF 链，如 `1901.02624` 合成体）。注意：本目录原有 10 篇 arXiv PDF 的 id 实测多为 PDF-only 投稿，其 `/e-print/` 拿不到 TeX——录 LaTeX 面需另选有源投稿 |

## 与旅程的关系

`journey-ke-create-kb-seed` / `journey-ke-graph-renders`（@mocked）的前置就是本目录齐备。
录制件按种子查询（"Ebola virus glycoprotein antibody neutralization"）一次性覆盖。
