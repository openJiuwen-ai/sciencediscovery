# Daily 用例模型回放

Daily 的真实模型用例保留原有 `@real` spec，不在真实用例中加入 mock 分支。需要进行快速、无 Token 消耗的流程看护时，使用独立的回放入口：

```bash
E2E_REPLAY_CAPTURE_ROOT=/path/to/model-replay/captures \
E2E_REPLAY_BIOMNI_DATA_ROOT=/path/to/biomnibench-da \
node scripts/run-daily-model-replay.mjs --case J5
```

`--case all` 会按串行顺序运行 12 个 daily 用例；也可以传入 `DRB-58`、`TC-E2E-01`、`PUCT-COMPRESS`、`Inline Plan`、`Biomni DA-13-3` 等单个名称。脚本为每个用例启动独立的本地 OpenAI-compatible 回放服务，读取对应采集目录的 `model-calls/`，再调用正常的隔离 E2E 栈。模型地址、Token 和 API variant 都由脚本覆盖为本地值，原始 spec 不会访问上游模型。

Biomni 用例还需要 `biomnibench-da` 输入数据。脚本默认读取采集目录中的 `biomni-capture-plan-deepseek.json` 和保存的 `quality-scorecard.json`，将 judge 结果也回放到本地，因此不会产生新的 judge 请求。需要将输入路径显式设置为：

```bash
E2E_REPLAY_BIOMNI_DATA_ROOT=/home/zjc/biomnibench-da
```

每个用例的结果默认写入系统临时目录 `sciencediscovery-daily-replay/`。结果中的 `replay-summary.json` 必须同时满足两项条件才算通过：E2E 进程退出码为 0，且本地服务器消费了该用例全部录制响应。响应不足、额外请求、栈前置条件缺失或用例失败都会使回放命令失败。

采集数据不提交到仓库。仓库只包含回放服务器、用例映射和启动脚本；运行机器需要通过 `E2E_REPLAY_CAPTURE_ROOT` 提供已保存的采集目录。首次运行可省略 `CI_E2E_PREPARED`，后续运行在依赖和 Chromium 已准备好后设置 `CI_E2E_PREPARED=1` 以跳过重复安装。
