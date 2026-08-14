---
name: science-research-team
description: Use this skill to orchestrate a multi-domain research team for literature/evidence research and data analysis. Dispatches the right domain(s) based on the user's request, runs each domain to completion with its own loop, then synthesizes into reports. Load when the user needs rigorous research with knowledge or data analysis.
---

# Science Research Team Skill

## Overview

A research-and-analysis orchestrator: takes a research question, runs the right combination of literature search, evidence extraction, code-based analysis, and report synthesis, then delivers reports. The skill handles sub-task decomposition, sub-agent dispatch, iteration with revision, file persistence, and reports assembly end-to-end — the user provide the research question, the skill runs the workflow.

## When to Use This Skill

**Use this skill when:**

- The user asks a research question that benefits from rigorous literature / evidence work — knowledge domain activated.
- The user asks for data analysis, statistical testing, modeling, or visualization — data domain activated.
- The user wants both knowledge and data combined, with the knowledge findings informing the analysis — both domains activated, knowledge runs first.

**Do NOT use this skill for:**

- Pure single-turn Q&A, planning, or reasoning that doesn't need execution or evidence gathering.
- Tasks where the user just wants raw code run with no verification

## Core Principle

Three principles govern the team:

1. **User-centric** — remember the user's requirements and execute tasks centered on them. Do NOT add scope, change the assignment, or substitute your own preferences for what the user asked.
2. **Workflow adherence** — follow the specified workflow. Do NOT plan independently, re-design the topology, or skip steps.
3. **Domain separation** — each sub-agent stays in its lane. Knowledge sub-agents do NOT run code analysis; code-engineer does NOT do literature search; report-writer does NOT re-run analysis.

## Python Package Installation

If you need to install new Python packages, install them through the Tsinghua PyPI mirror for reliability:

```bash
pip install [python package] -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## Methodology

The team runs in 5 high-level steps. **You MUST read [references/workflow.md](references/workflow.md) in full before executing any step** — it owns each step's detailed execution flow, input formats, validation rules, and iteration rules, and the overview below is not a substitute.

1. **Coarse-grained intent parsing** — identify active domains (knowledge, data, report), capture scope constraints, and verify sub-agents + skills are present (pause and ask the user for any missing). Knowledge runs first when both data and knowledge are activated.
2. **Knowledge domain** (if activated) — you plan sub-tasks → dispatches `literature-searcher` / `evidence-extractor` → integrates outputs and applies the schema + content rules as integration principles in one step.
3. **Data domain** (if activated) — you dispatches `code-engineer` ↔ `result-evaluator` iteration loop with `max_engineer_evaluator_iterations` cap. Revision guidance flows verbatim between rounds.
4. **Report writing** — you dispatch `report-writer` with Domain Summaries; `report-writer` produces the user's required outputs (or default outputs if none specified). You do NOT write the report.
5. **Final delivery** — deliver whatever the report-writer produced, with execution summaries.

## Quality Bar

The team run is sound when:

- [ ] Coarse intent parsing correctly identified which domains to activate and in what order.
- [ ] Data iteration stopped at `ACCEPT_AND_PROCEED` or `max_engineer_evaluator_iterations`, whichever came first.
- [ ] Analysis Summary carried no fabricated data, no off-scope analysis, no self-evaluation by code-engineer.
- [ ] Report: every finding traces to its source role; no new claims introduced; contradictions surfaced verbatim.
- [ ] No new scope was injected by you across iterations; only revision guidance changed between data rounds.
- [ ] report-writer did NOT re-run analysis, did NOT add claims, did NOT resolve contradictions on its own.
- [ ] You never wrote code, evaluated results, or produced user-required outputs — all were delegated to the respective sub-agents / report-writer.

## Common Mistakes to Avoid

- ❌ Activating both knowledge and data when the user only needs one.
- ❌ Running knowledge and data in parallel — knowledge must complete first when used as feed-forward.
- ❌ Paraphrasing or summarizing revision guidance between data rounds.
- ❌ Raising `max_engineer_evaluator_iterations` mid-loop to keep iterating past the cap.
- ❌ Modifying evaluation criteria between data rounds.

## Output

You deliver whatever the `report-writer` produced to the user, with:
- Which domains ran and which round finalized each
- Any unresolved issues
- The iteration trail (`accepted` / iteration cap / format error / kick-back retry)
