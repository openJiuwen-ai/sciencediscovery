# 阶段 I 门报告（W1+W2）— 2026-09-08 深夜初稿

**结论：PASS（有条件）** —— 产品代码零缺陷嫌疑；mocked 回归全绿；两条 KE 旅程的失败已收敛为**唯一环境缺口（fixture 录制面）**，且缺口已被产品自己的错误信息精确量化。real 层验收待次日执行。

## 一、代码评审（范围 e2c07ed..fbc0c3f，累计 ~12000 行）

| 模块 | 结论 | 发现 |
|---|---|---|
| W0 存储/队列/嵌入/LLM（f4036b5 前段） | PASS | 详见 2026-09-08-W0-zcode-review.md + Claude 回执（行动项全清零，自评 6 major 同修，测试 42+43→55） |
| W1 连接器/JATS/抽取（f4036b5） | PASS | ScholarlyTransport 接缝按规格落地；SSRF 逐跳守卫；溯源门 6 用例；C10 lean 查询 |
| W1.3 orchestrator/routes/图谱页（81cce98） | PASS | Claude 自评审 2C+6M 全修（轮询死循环/KeApiError 500 落地/SSRF 双跳断言等） |
| W2 算法核（4208c92） | PASS | convergence.ts/selection.ts 数学核验正确（Chao1/Chapman-LP+Seber/MMR/AA/引用先验），2×P3 观察项 |
| W2 grow 循环（fbc0c3f） | PASS 无 P1/P2 | eager watermark 防搁浅、预算持久态、doom-loop 死信前 finalize、L-P best-effort 防死信变重试、hub boost 恰好一次 |

**P3 观察项（不阻断）**：① blendAaScores 原地改写 score（现单点使用无害）；② deferred 搁浅任务不跨周期（DA 原语义，注释在案，留 W5 议）。

## 二、mocked E2E 矩阵（第 7 轮定稿：9 passed / 2 failed / 2 skipped，9.6 分钟）

| 旅程 | 结果 | 归因 |
|---|---|---|
| J1 首次运行 / J2 交付 / J4 委派 / J6 模型设置 / J7 模型目录 / T1 / F1 / timeouts / network-guard | ✅ 9/11 全绿 | — |
| J3 准备环境 | ⏭ skipped(BLOCKED) | 隔离栈无网装配依赖，预期内 |
| literature-review | ⏭ skipped | 条件跳过 |
| **J-KE1 建库种子** | ❌ step5 等不到 succeeded | **测试基建：fixture 未录制**（见下） |
| **J-KE2 图谱渲染** | ❌ 同上 | 同上 |

**fixture 缺口的精确定量**（来自 ke_jobs 死信错误，产品响亮报错设计有效）：
链路已验证至：建库→选中→种子→arxiv 搜索 fixture 命中→10 篇论文 PDF URL 定位→ingest 查 fixture→死信。
缺 10 个 arxiv PDF 录制件（文件名错误信息已给出，如 `arxiv.org_pdf_2010.09898-31e89663c03a.json`，base64 编码）。
后续待验：PDF 解析后 extraction→embedding 环节的 mocked 配置（KE embedding endpoint 在隔离栈的配置来源待确认，预计是下一个校准点）。

## 三、七轮迭代的环境归因账（全部测试基建，已沉淀 playbook 素材）

1. WSL→Windows localhost 单向 → Playwright 迁 WSL 内跑（同宿主）
2. chromium 缺系统库 → root `playwright install-deps`（验证门：ldconfig 直查）
3. 三轮共用数据目录 → 每轮干净目录；KE 旅程 finally 必须清 provider/model/默认设置
4. 模型目录 fixture → `SCIENCE_AGENT_MODEL_CATALOG_PATH`（CI 脚本 171 行的隐藏要求）
5. J7 时区断言 → 套件跑加 `TZ=UTC` 对齐 CI
6. 管道假阳性两犯 → 验证标记必须与被验证命令同链无管道
7. D: 改动必须重新 sync WSL（Claude memory 原警告，QA 也踩了一遍）

## 四、给 Claude 的行动项（阶段 II 开工前可选）

- [ ] 无阻断项。建议：extraction→embedding 在无 embedding 配置时的失败信息可读性（当前 extract job 的报错形态待 mocked 配置补齐后评估）

## 五、QA 待办（下巡航）

1. 录制 10 个 arxiv PDF fixture（make-fixture.mjs --base64，文件名按死信错误逐一对应）
2. 查明 KE embedding endpoint 在隔离栈的配置来源并补 mocked 方案
3. 重跑 J-KE1/J-KE2 → 预期全绿 → mocked 拍关闭
4. real 层：注入 minimax/siliconflow 凭据 → 真实种子 10 篇（≥8 ready、实体 150-250、embedding 非空率、溯源门抽查 10 条边）→ grow 2 cycle
5. 补全本报告 real 层矩阵 → 出最终结论

## 附：环境复现（下次一条链）

`~/start-sd-e2e-mocked.sh`（data 目录/端口 4390/4391/catalog env/fixture env）→ 就绪后
`wsl: cd ~/sciencediscovery/.e2e && E2E_BASE_URL=http://127.0.0.1:4390 E2E_API_TOKEN=<token> TZ=UTC npm run test:mocked`
