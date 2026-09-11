# 运行拓扑变更：Claude 与 zcode 共用唯一长驻栈（4310）

日期：2026-09-11 · 作者：Claude（用户决定）

## 用户决定

"claude 和 zcode 只启动一套服务，之前测试的数据清空，后续测试都在这一套里面做。"

## 现状（已执行）

- **唯一长驻栈 = 4310**（`~/start-dev-sd.sh`，token `Vv77w8ZpH0-hEO3FZyaNtqAkzpLj8pe7kq-sIIALjF4`）。新加 `SCIENCE_AGENT_KE_VISION_*` env（minimax VLM，图版页注释默认开）。
- **已停止并删除数据**：4495 ke-local 栈（两个 Local PDF KB 已通过 sqlite ATTACH 合并进 4310 后删目录）、**4390 你的 mocked 栈已停**（pid 50502 链）、`sd-e2e-mocked-data*`（含 data7）/ `sd-e2e-real-data` / `sd-fg-e2e-data` / `sd-ke-local-data` 全部删除。保留了 `sd-e2e-checkout`（代码目录）和日志/脚本文件。
- **4310 KE 库已清测试残留**：删掉 W4 E2E Communities ×3 + J-KE1/J-KE2 知识库（保留 Ebola GP Smoke 118 实体、Ebola Local PDF Baseline 65、Ebola Local PDF Vision 67）。KE 无删除 API，按 kb_id 清了 13 张表（FTS 触发器自动维护，250=250 一致）。4310 的 catalog.sqlite（会话/项目历史）未动。
- 4310 模型：minimax-text 仍是全局默认（576ca918）；留了一条 J-KE2 stub 模型记录（无害，指向死 stub，不影响默认）。

## 约定（请遵守）

1. **日常/手动/真实层测试都在 4310**，不再各起长驻测试栈。
2. **自动化 journey 例外**：J-KE*/J-FG1 这类必须 fixture 隔离的，仍可自起**一次性**隔离栈，但跑完立即拆掉、随手删数据目录——不要留长驻进程。你之前 4390 的长驻 mocked 栈就是这次被收掉的。
3. 需要在 4310 上跑"本地 PDF → 真实管线"测试时：4310 不带 fixture env（真实网络），要么用真实种子查询，要么参照 `qa/handoff/to-zcode/2026-09-11T1930-pdf-vision-pass.md` 的夹具法临时带 `SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR=/home/xjtlb/ke-local-fixtures` 重启（夹具目录保留着）。
4. **KE 跨栈迁移方法**（以后可能再用）：停栈 → `ATTACH` 源库 → `INSERT OR IGNORE INTO <13 张 ke_* 表> SELECT * FROM src.<表>` → knowledge_bases 最后；FTS 由触发器自动维护；schema 版本须一致（ke_migrations）。

## 相关

- 视觉增强细节见 2026-09-11T1930-pdf-vision-pass.md（HEAD 2c2205c）。
