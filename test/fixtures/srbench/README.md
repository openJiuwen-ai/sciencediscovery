# LLM-SRBench fixture

`lsr_transform_i.34.1_2_0.json` is one problem of the `lsr_transform` subset of
[`pkuHaowei/llm-srbench`](https://huggingface.co/datasets/pkuHaowei/llm-srbench),
seeded into the Session's workspace by
`test/desktop-evolve-srbench-real.spec.ts`.

The case needs the data in the workspace because the design conversation
otherwise spends its budget fetching it: `huggingface.co` and the datasets
server are unreachable from some runners, and the public mirror serves the two
shards (172 MB and 181 MB) at a fraction of a megabyte per second.

## Shape

The keys are the parquet row's own columns, so a model that knows LLM-SRBench
recognizes the file without a translation table:

| key | value |
| --- | --- |
| `problem_id` | `lsr_transform_i.34.1_2_0` |
| `subset` | `lsr_transform` |
| `description` | the problem statement carried by the dataset |
| `input_vars` | `["omega", "c", "v"]` |
| `output_vars` | `["omega_0"]` |
| `train_input`, `train_output` | 4000 rows of the parquet's `train_input` / `train_output` |
| `test_input`, `test_output` | the first 2000 rows of `test_input` / `test_output` |

The parquet row also carries `gt_expression` and `symbols`. Neither is copied
here: the ground truth is what the search is supposed to find, and a fixture
that shows it would turn the case into a lookup.

Floats are written at the precision they were stored in — the shortest decimal
that reads back as the same float32 — which keeps the file small without
adding a noise floor: rounding further would cap NMSE around 1e-9 and make the
problem's `digits=12` unreachable.

## Regenerating

Download the subset and extract the row:

```sh
curl -sL -C - -o train-00000-of-00002.parquet \
  https://hf-mirror.com/datasets/pkuHaowei/llm-srbench/resolve/main/lsr_transform/train-00000-of-00002.parquet
curl -sL -C - -o train-00001-of-00002.parquet \
  https://hf-mirror.com/datasets/pkuHaowei/llm-srbench/resolve/main/lsr_transform/train-00001-of-00002.parquet
python3 -c 'import pyarrow.parquet as pq, pyarrow.compute as pc, json
table = pq.read_table("train-00001-of-00002.parquet")
row = table.filter(pc.equal(table.column("instance_id"), "lsr_transform_i.34.1_2_0")).to_pylist()[0]
for key in ("gt_expression", "symbols"):
    row.pop(key, None)
json.dump(row, open("raw.json", "w"))'
```

Then take the first 4000 train and 2000 test rows, write each value as the
shortest decimal that round-trips to its float32, and write the file above. The
row lives in `train-00001-of-00002.parquet`; the first shard can be skipped.
