# Analyze correlations and clusters of sepsis endotype scores

## Background

Different studies use different scores to describe immune states in sepsis. If two scores rise and fall together across the same patients, they may capture related variation. Our question is: **which endotyping scores cluster together based on their correlations across patients?**

This tutorial uses `da-14-1` from Phylo's [BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA). You will upload a CSV, inspect the data, analyze correlations and clusters, and review the delivered results. The objects being clustered are **score variables**, not patients. You do not need to recompute scores from raw gene expression.

The walkthrough is based on the repository's existing real E2E and retained outputs. Task instructions originate from BiomniBench (Qu et al., 2026). Benchmark materials are CC-BY-4.0; underlying data retain their original release terms. Follow the dataset's source attribution requirements.

## Preparation

Complete the [quick start](../getting-started/quick-start.md), configure a task model, and confirm that the Python scientific environment and sandbox work. Analysis uses packages such as pandas, NumPy, and SciPy; plotting may require Matplotlib. Follow environment installation prompts if dependencies are missing. A GPU and scientific memory are not required.

Sign in to Hugging Face, accept the dataset access conditions, and download these two files while preserving the directory layout:

```text
biomnibench-da/
└── da-14-1/
    ├── instruction.md
    └── environment/data/subspace_score_table.csv
```

The instruction file defines the original task; the CSV is approximately 2.3 MB. Do not upload rubrics or reference trajectories from `tests/` as task material. Keep download credentials on your machine, outside the conversation.

Allow about an hour and a model usage budget for a first attempt. The historical example below took about 21 minutes, but that is not a runtime guarantee. This recommendation does not automatically impose a one-hour limit on ordinary sessions.

## Start the task

Create a Project and Session. Upload `subspace_score_table.csv` to that session and confirm it appears in the workspace. Open your local `instruction.md` and paste its **complete original contents** into the message box. Sending only the research question omits requirements for the analysis trace, code, references, and final answer.

Append the following platform instructions before sending. This matches the real E2E prompt construction: it adapts paths and artifact registration without prescribing methods or answers.

```text
<platform_delivery>
The original task above defines the scientific scope and required outputs. The provided data file is in this session workspace: subspace_score_table.csv. Resolve paths using the actual workspace; /app/data in the original instruction maps to the workspace input and /app outputs map to workspace-relative outputs. Save and declare the required trace.md and answer.txt artifacts with those exact logical names.
</platform_delivery>
```

The original task prohibits searching for or reading the specific source paper, figures, or supplementary materials. Solve it from the supplied data. General methodological and background references are distinct from looking up the task's answer.

## Confirm requirements

Review the Agent's plan to check that it addresses the intended question:

| Check | What should be clear |
| --- | --- |
| Analysis objects | Compare score columns; do not treat patient IDs, categorical labels, or all numeric clinical covariates as endotype scores |
| Data scope | Actual dimensions, repeated patients, cohort composition, missingness, and counts before and after filtering |
| Methods | Choice of correlation coefficient, conversion to distance, and clustering method |
| Direction | Distinguish positive and negative correlations; taking absolute values changes the question |
| Reproducibility | Keep executed code, parameters, intermediate results, and decision rationales in the trace |
| Delivery | `trace.md` documents the process; `answer.txt` directly identifies which scores cluster together |

These checks help you read the analysis. They are not additional reference answers to insert into the benchmark prompt. You do not need to prescribe a cluster count in advance.

## Analysis process

First, check that the Agent actually reads the file and inspects its columns. Historical runs read **3,948 rows and 69 columns**. Rows are not necessarily independent patients: repeated patient records require inspection. Restating the file description does not substitute for reading the data.

Next, examine score selection and missing-value handling, followed by the correlation matrix and hierarchical clustering. If the Agent produces a heatmap or dendrogram, its objects should be score names. Strong negative correlation describes opposite directions; a large absolute correlation does not imply that scores move together.

One historical run used Spearman correlation, distance `1 − ρ`, and average linkage, then checked sensitivity to other choices. This illustrates one analysis, not the only permitted method.

Handle code execution and environment installation approvals according to the requested operation. If a package, path, or calculation fails, check whether the Agent corrects it and reruns the computation. Finally, open the artifacts area and verify that outputs can be previewed and downloaded. A summary in chat alone does not establish file delivery.

## Analyze results

Read `answer.txt` for the conclusion, then use the Objective, Data Sources, Approach, Results, and References sections of `trace.md` to inspect its basis. Filtering, clustering, and statistical operations should include reproducible code rather than prose alone. Extra plots and scripts are useful but do not replace the two required files.

The following record is from repetition 3 of a historical three-run experiment using DeepSeek Flash. It is an Agent-generated analysis example, not the official reference answer:

| Item | Recorded result |
| --- | --- |
| Analysis duration | About 20 minutes 31 seconds, excluding independent judging |
| Input and selected columns | Input 3,948 × 69; inspected 27 score columns and analyzed 26 after removing one exact-negation duplicate |
| Method | Spearman correlation, signed distance `1 − ρ`, average linkage; interpreted three main groups |
| Example within-group pair | `cano_SRSq` and `davenport_SRSq`, reported correlation approximately 0.922 |
| Example opposite-direction pair | `adaptive_score` and `inflammopathic_score`, reported correlation approximately −0.842 |
| Delivery check | Passed: the main run completed and referenced readable, nonempty final artifacts |
| Independent quality score | 100, using the original rubric, the local scoring adapter, and a DeepSeek Flash Judge |

This 100 is not an execution of the official verifier or independent confirmation of scientific validity. The repository uses the original expert rubric through a local compatible Judge adapter. Judge model and adapter choices affect comparability.

In the same experiment, repetition 1 delivered outputs but received an incomplete Judge response; repetition 2 failed the delivery check. Repetition 3 therefore does not establish consistent success. Inspect delivery status, scoring status, and reasons separately on your own run. An unavailable score is not zero.

## Caveats

- **Correlation is not causation.** Clustering shows associations within the analyzed samples; it does not establish treatment recommendations or clinical utility.
- **Check structural redundancy.** Some scores are algebraic functions of others. Strong correlations can follow from their definitions rather than independent biological findings.
- **Filtering changes results.** All records, infected-only subsets, and one record per patient can yield different numbers. Align sample scope and methods before comparing analyses.
- **Separate completion and quality.** The existing real E2E requires a completed main run referencing at least one readable, nonempty final artifact. Scientific quality is scored separately using the original rubric. Missing `trace.md` or `answer.txt` affects scoring; delivering some other artifact does not fulfill the entire original task.
- **Do not copy example numbers.** This page helps you interpret results; it should not be supplied as Agent input or a scoring answer. Preserve the original instructions and evaluate the current data and execution record.

## Related documentation

- [Quick start](../getting-started/quick-start.md): start the service, configure a model, and upload files.
- [Shell, environments, and workspaces](../core/execution-workspaces.md): execution, files, and task states.
- [BiomniBench-DA real E2E](../../../test/benchmarks/biomnibench-da/README.md): reproduction commands, input checks, and scoring configuration; select `BiomniBench-da-14-1` and set `E2E_BIOMNI_RUN_TIMEOUT_MS=3600000` for a one-hour budget.
- [中文版](../../zh/domains/analyze-sepsis-endotypes.md).
