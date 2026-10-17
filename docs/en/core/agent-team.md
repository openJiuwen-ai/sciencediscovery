# Agent Team research collaboration

Agent Team uses the `science-research-team` skill to organize agents with distinct roles for literature research, data analysis, and reporting. You provide the question, materials, and deliverables; the lead agent assigns work, passes results between roles, and delivers the outputs.

It suits tasks with several stages, such as analyzing a dataset, checking the analysis, and writing a report. See [Analyze immune features with Agent Team](../domains/agent-team-data-analysis.md) for a walkthrough.

## Start a team task

Make sure `science-research-team` is available to the current conversation in the skill library. Then ask explicitly in chat:

```text
Use science-research-team to analyze my uploaded data.
Inspect the data, run the analysis, review the results, and deliver a report,
figures, and code that I can rerun.
```

Add the question, data files and column definitions, scope, and output format. The required built-in specialists must be enabled. Literature work needs available search connectors; code analysis needs a working execution environment. The agent will ask you to restore missing roles or skills if they are required.

## How roles divide the work

| Role | Responsibility |
|---|---|
| `literature-searcher` | Find relevant literature and organize sources |
| `evidence-extractor` | Extract evidence and limitations from known sources |
| `code-engineer` | Write and run analysis code; save results and figures |
| `result-evaluator` | Review methods, results, and reproducibility; request corrections |
| `report-writer` | Write from the supplied results, retaining disagreements and unresolved issues |

The team activates the roles the task needs. A data-only task mainly uses analysis, review, and reporting. When literature is also needed, research runs first and supplies evidence to the analysis.

Independent literature subtasks can run in parallel. Work that needs an earlier result runs in order: review follows analysis, and report writing follows the integrated results.

## What happens after review

An accepted analysis moves to reporting. If revisions are needed, the analysis agent updates its work using the review feedback, then submits it for another review.

The skill defaults to at most three analysis-and-review rounds. If the final round still needs revision, the team retains the latest output, marks the analysis incomplete, and explains the remaining issues. A generated file does not by itself mean the analysis passed review.

The skill guides the agents through this workflow. Check the task record and outputs to confirm what actually completed.

## What you receive

Specify the report language, filenames, and formats, plus any figures, tables, code, and rerun instructions you need. Delivery should identify the completed work, review outcome, and remaining limitations.

Check that conclusions trace to data or literature, methods are recorded, and incomplete work is clearly marked. Review helps identify problems but cannot guarantee every conclusion is correct.

Use [Idea Tree](idea-tree.md) when the focus is proposing and repeatedly improving research designs. Agent Team suits research, analysis, and delivery around an existing question and supplied materials.
