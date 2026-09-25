# Specialists: give research tasks focused expertise

A research report often requires several kinds of work: finding papers, extracting evidence, writing code, evaluating results, and developing an argument. Each needs different judgment. Retrieval should fill source gaps; writing should avoid adding unsupported findings. Someone implementing an analysis also benefits from a separate examination of methodology and reliability.

Specialists separate these responsibilities and supply role instructions, skills, and tool scope. The main Agent can choose roles suited to the task while retaining responsibility for the research objective and synthesis. Researchers spend less time repeating working requirements and gain clearer assignments and deliveries.

## Research roles already provided

ScienceDiscovery includes the following eight Specialists. Combine them as needed; every investigation does not require the full team.

| Built-in role | Suitable work | Main delivery |
| --- | --- | --- |
| `literature-searcher` | Search available academic sources, deduplicate, and record coverage gaps | Source lists and retrieval notes |
| `evidence-extractor` | Extract findings, methods, statistics, and limits from supplied sources | Structured evidence with source anchors |
| `code-engineer` | Write, execute, and debug Python/R analyses; document methods and environments | Scripts, results, and reproduction notes |
| `result-evaluator` | Assess accuracy, completeness, robustness, and methodological quality | Revision decisions and concrete feedback |
| `report-writer` | Synthesize existing research summaries while preserving disagreements and source relationships | A report in the requested format |
| `creative-material-design` | Propose water-treatment material structures, properties, and feasibility | Candidate material designs |
| `assessment-screener` | Assess material candidates from specified perspectives and rubrics | Dimension scores, strengths, weaknesses, and verification notes |
| `insight-aggregator` | Compare assessments and expose agreement and disagreement | Insights for further improvement |

The first five cover common literature and data-research stages; the remaining three support material design and assessment. These material roles are callable presets, not a claim that current Idea Tree dispatches them to perform real experiments. [Idea Tree](idea-tree.md) has its own research loop and limits.

For a bird-migration review, retrieval can prepare sources, extraction can preserve species and experimental conditions, and writing can synthesize the findings. Data analysis may benefit more from code engineering and result evaluation. Actual delegation depends on the task; inspect execution records to see which roles were used.

![Built-in and custom Specialists](../../images/specialist-en.png)

Built-in responsibilities are fixed, with enable/disable controls. Role names do not confer professional qualifications, and several roles may share model biases. Clear assignments support inspection rather than replace validation. The workflow's `result-evaluator` is also distinct from the artifact-focused [Reviewer mechanism](science-memory-reviewer.md).

## Bring in your domain's experience

Presets cannot cover every laboratory's process. Create a Specialist that captures your research scope, decision rules, delivery requirements, and available connectors. A cohort-selection assistant, for example, could require inclusion/exclusion counts at each step and reproducible scripts.

Custom roles use the existing runtime and permission system; adding one does not require redeploying the application. If a role needs specialized tools or methods, connect MCP services or import Skills and incorporate them into the appropriate workflow.

- [Create and use custom Specialists](../advanced-setup/configure-specialists.md): define responsibilities, configure resources, and verify a task.
- [Scientific MCP and Skills](mcp-skills.md): existing tools, methods, and extension options.
- [Literature-research tutorial](../domains/literature-research.md): from a question to an inspectable report.
