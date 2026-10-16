# ScienceMemory and Reviewer: make conclusions easier to question

A fluent report can still leave essential questions unanswered: which computation produced this number, and does the cited paper support this sentence? ScienceMemory and Reviewer help retain research foundations and identify issues that deserve another look.

## Connect the work to its evidence

ScienceMemory organizes recorded tasks, tool calls, code, files, and citations into a clickable graph. Task chains show what happened and what it produced. Citation chains connect conclusions to evidence and its sources.

An analysis figure can link to the code and execution that generated it. A structured report citation can lead to evidence or an artifact. These relationships offer a direct route back to specific records rather than requiring a search through the entire conversation.

![Inspect evidence and recorded relationships](../../images/evidence4.jpg)

Completeness depends on what was recorded and which evidence relationships were explicitly established. Every sentence does not automatically acquire a complete support chain, and unregistered evidence will not appear by itself.

## Add another perspective on an artifact

Reviewer and session automatic review are on by default for new installs. Eligible report artifacts trigger background reviews in the same workflow, without a second message. Use **Automatic review** beside the composer’s Approval mode to turn it off for a session. **Run review** and Quick/Deep settings remain in the workspace Reviewer controls. Findings and reasons attach to specific artifact versions, helping locate missing citations, mismatched sources, or incomplete computational provenance.

Quick review focuses on citation structure and computational evidence chains. Deeper checking requires accessible sources, suitable tools, and time. A well-formed citation does not establish support, and a recorded execution does not establish sound statistics.

Reviewer feedback does not automatically edit artifacts or guarantee a subsequent revision by the main Agent. Use findings to request more evidence, narrower claims, or corrected calculations, then inspect the new version.

## Reduce hallucination through inspectable evidence

The practical benefit is turning vague doubt into a traceable issue: a missing source, a calculation inconsistent with its result, or a conclusion that exceeds the evidence. This supports efforts to reduce research hallucinations, but model reviews can be wrong and a graph is not proof of truth.

Scientific memory is optional. Its local-file backend needs no separate graph database; choose Neo4j when that backend is needed. Existing explicit Reviewer opt-outs are preserved. If the system capability is off, the composer explains why automatic review is unavailable; eligible reports record a skipped reason in the review card. Starting with one analysis that delivers reliable artifacts makes it easier to understand the records when adding provenance and review.

- [ScienceMemory setup](../advanced-setup/science-memory-setup.md): local storage and Neo4j.
- [Review and provenance design](../developer-docs/review-provenance.md): versions, evidence, and findings.
- [ScienceMemory design](../developer-docs/science-memory.md): task and citation chains.

The live controls are the global Reviewer Specialist switch and the session Automatic review toggle. Legacy `reviewMode` and `semanticReviewEnabled` fields do not control this path.
