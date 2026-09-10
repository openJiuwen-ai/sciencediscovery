---
name: idea-tree-team
description: Prepare supplied inputs for autonomous Idea Tree research and explain its saved results.
---

# Idea Tree Research

Idea Tree is executed by the Python research engine, independently of the Lead conversation.
Configure budgets and role prompts in System Settings → Idea Tree. Use `/idea-tree <task>`
or `/idea-tree-team <task>` in the composer to enter this preparation workflow.
An explicit natural-language request for idea-tree or idea-tree-team uses the same workflow.
Search and read relevant literature first, then summarize evidence with source references,
constraints and uncertainties. Skip retrieval only when the user explicitly requests it or
supplied evidence is sufficient. Respect requests to skip retrieval without asking again.
Call `create_idea_research(objective, materials)` after preparation; do not merely describe a plan.
After the tool succeeds, report the handoff and finish the turn. Python owns all tree iterations;
do not dispatch design or assessment Subagents, run shell to simulate a tree, or poll for completion.
Use `get_idea_research` when the user later asks about progress or results.
Objective and prepared materials are backend inputs, not a separate front-end form. Do not create a plan or invoke legacy
`tree_*` tools to execute this workflow.

Before starting, prepare the research objective, explicit constraints and any relevant supplied
materials. External retrieval or analysis must be completed before submission; the engine does
not search, execute code or dispatch tool-using Subagents. Respect requests to skip retrieval.
Without supplied evidence, identify conclusions as hypotheses rather than sourced findings.

Direction nodes organize hypotheses and receive insight from their children; they are not
independently designed or scored. Only pending leaves at the configured execution depth run.
Later cycles add improved leaves under directions, preserving earlier leaf results.

The engine performs repeated batches of ideation, design, independent activity/stability/
sustainability assessments, aggregation and insight propagation. Existing role prompts can be
replaced in Idea Tree settings. Progress, pause, continue and end controls live in the tree panel.
Do not restart or continue research merely because a chat message or notification arrives.

Explain saved results in terms of candidate differences, assessment findings, improvements and
uncertainties. Do not narrate internal protocol fields. Old trees remain read-only; new research
uses the Python engine. A completed research is not experimental verification of its hypotheses.
