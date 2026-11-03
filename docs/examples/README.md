# Tutorial sample data

Small files that the [learning path](../en/getting-started/quick-start.md) uses, so a first analysis does not depend on finding your own data.

| File | Used by | Contents |
| --- | --- | --- |
| [`plant-growth.csv`](plant-growth.csv) | [End-to-end walkthrough](../en/getting-started/quick-start.md) · [端到端体验案例](../zh/getting-started/quick-start.md) | 45 plants, 15 in each of three fertilizer treatments |

`plant-growth.csv` columns:

| Column | Meaning |
| --- | --- |
| `plant_id` | Plant identifier, `P01`–`P45` |
| `treatment` | `control`, `fertilizer_a` or `fertilizer_b` |
| `light_hours` | Daily light the plant received, 10–14 hours |
| `dry_mass_g` | Dry mass at harvest, in grams |

The values are synthetic: they were generated for these tutorials with a fixed random seed and do not describe real plants or a real experiment. Do not cite them as findings.

中文教程使用同一份文件，见[端到端体验案例](../zh/getting-started/quick-start.md)。

These files are part of this repository and are distributed under its [Apache License 2.0](../../LICENSE).

To download a file without a checkout, for example when you run the prepackaged binary:

```bash
curl -LO https://raw.githubusercontent.com/openJiuwen-ai/sciencediscovery/main/docs/examples/plant-growth.csv
```
